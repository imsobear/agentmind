// OpenAI Responses-API SSE parser.
//
// Mirrors the contract of `sse.ts` (Anthropic) so a single LiveSession can
// host either accumulator. We tee the upstream stream byte-for-byte to the
// client while accumulating decoded events here, then assemble a final
// `ResponsesObject` once `response.completed` (or `failed`/`incomplete`)
// arrives.
//
// Why a separate parser and not "OpenAI just speaks Anthropic too":
//   - Event names are different and the deltas target items by
//     `output_index` / `item_id`, not the linear `index` Anthropic uses.
//   - Tool args arrive as `function_call_arguments.delta` (string of JSON
//     fragments) rather than `input_json_delta`.
//   - There's a `response.completed` envelope that already carries the
//     fully-assembled `output` array, so for many providers we don't even
//     need to stitch deltas — we just trust the terminal envelope. We
//     still stitch as a fallback so anything emitted between item.added
//     and item.done renders before the envelope arrives.

import type {
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesFunctionCallItem,
  ResponsesCustomToolCallItem,
  ResponsesReasoningItem,
  ResponsesSseEvent,
} from '../lib/openai-responses-types'

// Per-output-item builder state. We track the running JSON-string
// accumulators for function calls and the running text for messages /
// reasoning so the LiveRegistry can render a partial response mid-stream.
interface ItemBuilder {
  item: ResponsesOutputItem
  // Streaming text buffer for `message` (output_text) and `reasoning`
  // (reasoning_text + reasoning_summary). We keep separate buffers so the
  // renderer can show summaries and content distinctly when the model
  // emits both.
  text?: string
  reasoningText?: string
  reasoningSummaryText?: string
  // For function/custom tool calls, the arguments string is assembled by
  // concatenating deltas. The terminal `output_item.done` overwrites this
  // with the canonical value.
  args?: string
}

export class ResponsesSseAccumulator {
  private buffer = ''
  // The response envelope as we know it. `response.created` populates the
  // header (id, model, status="in_progress"), every `output_item.added`
  // appends a placeholder, deltas mutate that placeholder, and
  // `response.completed` overwrites everything with the canonical version.
  private envelope: ResponsesObject | null = null
  private items = new Map<number, ItemBuilder>()
  events: ResponsesSseEvent[] = []

  feed(chunk: string) {
    this.buffer += chunk
    while (true) {
      const sep = this.buffer.indexOf('\n\n')
      if (sep < 0) break
      const raw = this.buffer.slice(0, sep)
      this.buffer = this.buffer.slice(sep + 2)
      this.parseEventBlock(raw)
    }
  }

  flush() {
    if (this.buffer.trim()) {
      this.parseEventBlock(this.buffer)
      this.buffer = ''
    }
  }

  // Snapshot of the response as currently assembled. Returns `undefined`
  // until `response.created` arrives.
  getResponse(): ResponsesObject | undefined {
    if (!this.envelope) return undefined
    // Materialise the running item builders into the output array — the
    // map preserves insertion order via numeric keys we sort by.
    const indexes = Array.from(this.items.keys()).sort((a, b) => a - b)
    const output: ResponsesOutputItem[] = []
    for (const idx of indexes) {
      const b = this.items.get(idx)
      if (!b) continue
      output.push(b.item)
    }
    // If `response.completed` has already overwritten `envelope.output`,
    // prefer that (canonical). Otherwise use the running builders.
    return {
      ...this.envelope,
      output: this.envelope.output?.length ? this.envelope.output : output,
    }
  }

  private parseEventBlock(block: string) {
    // SSE block: lines prefixed with "event:" and "data:". Like Anthropic,
    // we use the `data:` JSON's own `type` as the discriminator — the
    // `event:` header is redundant in practice.
    let dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
    }
    if (!dataLines.length) return
    const data = dataLines.join('\n')
    if (!data || data === '[DONE]') return
    let parsed: ResponsesSseEvent
    try {
      parsed = JSON.parse(data) as ResponsesSseEvent
    } catch {
      return
    }
    this.events.push(parsed)
    this.handle(parsed)
  }

  private handle(ev: ResponsesSseEvent) {
    const kind = ev.type
    if (kind === 'response.created' || kind === 'response.in_progress') {
      const r = (ev as any).response as Partial<ResponsesObject> | undefined
      if (r) this.mergeEnvelope(r)
      return
    }
    if (kind === 'response.completed') {
      const r = (ev as any).response as ResponsesObject | undefined
      if (r) {
        // Terminal envelope is canonical — drop our running builders, the
        // server-rendered `output` is what we persist.
        this.envelope = { ...this.envelope, ...r }
        this.items.clear()
      }
      return
    }
    if (kind === 'response.failed' || kind === 'response.incomplete') {
      const r = (ev as any).response as Partial<ResponsesObject> | undefined
      if (r) this.mergeEnvelope(r)
      const err = (ev as any).error
      if (err) this.envelope = { ...(this.envelope ?? blankEnvelope()), error: err, status: 'failed' }
      return
    }
    if (kind === 'response.output_item.added') {
      const idx = (ev as any).output_index ?? this.items.size
      const item = (ev as any).item as ResponsesOutputItem | undefined
      if (item) this.items.set(idx, { item: cloneItem(item) })
      return
    }
    if (kind === 'response.output_item.done') {
      const idx = (ev as any).output_index
      const item = (ev as any).item as ResponsesOutputItem | undefined
      if (item == null) return
      const key = typeof idx === 'number' ? idx : this.findItemSlotByItemId(item)
      if (key == null) return
      // Terminal item event is canonical for that slot — overwrite.
      this.items.set(key, { item: cloneItem(item) })
      return
    }
    if (kind === 'response.output_text.delta') {
      const idx = (ev as any).output_index
      const b = typeof idx === 'number' ? this.items.get(idx) : undefined
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.text = (b.text ?? '') + delta
      // Mutate the message item's first output_text block so a mid-stream
      // snapshot already contains the in-progress text.
      if (b.item.type === 'message') {
        const m = b.item as ResponsesOutputMessage
        if (!m.content) m.content = []
        const existing = m.content.find((c) => c.type === 'output_text') as
          | { type: 'output_text'; text: string }
          | undefined
        if (existing) existing.text = b.text
        else m.content.push({ type: 'output_text', text: b.text })
      }
      return
    }
    if (kind === 'response.function_call_arguments.delta') {
      const idx = (ev as any).output_index
      const b = typeof idx === 'number' ? this.items.get(idx) : undefined
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.args = (b.args ?? '') + delta
      if (b.item.type === 'function_call') {
        ;(b.item as ResponsesFunctionCallItem).arguments = b.args
      }
      return
    }
    if (kind === 'response.custom_tool_call_input.delta') {
      const idx = (ev as any).output_index
      const b = typeof idx === 'number' ? this.items.get(idx) : undefined
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.args = (b.args ?? '') + delta
      if (b.item.type === 'custom_tool_call') {
        ;(b.item as ResponsesCustomToolCallItem).input = b.args
      }
      return
    }
    if (kind === 'response.reasoning_text.delta') {
      const idx = (ev as any).output_index
      const b = typeof idx === 'number' ? this.items.get(idx) : undefined
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.reasoningText = (b.reasoningText ?? '') + delta
      if (b.item.type === 'reasoning') {
        const r = b.item as ResponsesReasoningItem
        const content = r.content ?? []
        const existing = content.find((c) => c.type === 'text')
        if (existing) existing.text = b.reasoningText
        else content.push({ type: 'text', text: b.reasoningText })
        r.content = content
      }
      return
    }
    if (kind === 'response.reasoning_summary_text.delta') {
      const idx = (ev as any).output_index
      const b = typeof idx === 'number' ? this.items.get(idx) : undefined
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.reasoningSummaryText = (b.reasoningSummaryText ?? '') + delta
      if (b.item.type === 'reasoning') {
        const r = b.item as ResponsesReasoningItem
        const summary = r.summary ?? []
        const existing = summary.find((c) => c.type === 'summary_text')
        if (existing) existing.text = b.reasoningSummaryText
        else summary.push({ type: 'summary_text', text: b.reasoningSummaryText })
        r.summary = summary
      }
      return
    }
    // Catch-all kinds (errors with bare `{type:"error", error}`, future
    // deltas we don't model yet, telemetry-only) — already captured in
    // this.events; nothing else to do.
  }

  private mergeEnvelope(partial: Partial<ResponsesObject>) {
    this.envelope = {
      ...(this.envelope ?? blankEnvelope()),
      ...partial,
      // Don't let an early partial wipe out a populated output array.
      output: partial.output ?? this.envelope?.output ?? [],
    }
  }

  // Slow fallback when an `output_item.done` event omits `output_index`.
  // We try to match by `item.id` against any of our running builders;
  // returns null if no match (very rare).
  private findItemSlotByItemId(item: ResponsesOutputItem): number | null {
    const id = (item as any).id
    if (!id) return null
    for (const [k, b] of this.items) {
      if ((b.item as any).id === id) return k
    }
    return null
  }
}

function blankEnvelope(): ResponsesObject {
  return { id: '', output: [] }
}

// Shallow clone — items are passed through to consumers who may mutate
// fields like `arguments`. We don't deep-clone because the inner objects
// are themselves freshly parsed from JSON.parse() each event.
function cloneItem(item: ResponsesOutputItem): ResponsesOutputItem {
  return { ...item }
}
