// OpenAI Responses-API SSE parser.
//
// Mirrors the contract of `sse.ts` (Anthropic) so a single LiveSession can
// host either accumulator. We tee the upstream stream byte-for-byte to the
// client while accumulating decoded events here, then assemble a final
// `ResponsesObject` once `response.completed` (or `failed`/`incomplete`)
// arrives.
//
// Real wire shape (cross-checked against
// `codex-rs/codex-api/src/sse/responses.rs`):
//   - Events DO NOT carry `output_index` at all. Routing is by either
//     `item_id` (when present) or by the implicit "currently open
//     item" — the one most recently announced by `output_item.added`
//     and not yet closed by `output_item.done`. Codex CLI's own
//     downstream consumer works the same way.
//   - `response.completed` ships only `{id, usage, status, ...}` —
//     specifically NOT `output[]`. The output is the union of all
//     `output_item.done` events that preceded it. If we drop our
//     running builders when `.completed` arrives, the persisted record
//     ends up with an empty `output[]` even though the JSON is otherwise
//     populated.
//
// Both of these were silent bugs in v0.2.0: the test stub sent
// `output_index` (it was synthetic) and a fully populated
// `response.completed.output`, masking the real-world behavior.

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
  // The response envelope as we know it. `response.created` populates
  // the header (id, model, status="in_progress") and `response.completed`
  // fills in `usage` + flips the status. We DO NOT trust `.completed` to
  // bring `output[]` with it — that's stitched separately.
  private envelope: ResponsesObject | null = null
  // Output items in emission order. Append-only; `output_item.done`
  // overwrites in place, `response.completed` may overwrite wholesale
  // (only if it actually carries an output array — rare in practice).
  private items: ItemBuilder[] = []
  // Index into `items` of the currently-open builder. Set by
  // `output_item.added`, cleared by `output_item.done`. Bare deltas
  // (without `item_id`) target this slot.
  private openIndex: number | undefined
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
    const fromItems = this.items.map((b) => b.item)
    // If `response.completed` has already brought a populated output[]
    // (some upstreams do; chatgpt.com generally does not), prefer that —
    // it's server-canonical. Otherwise materialise from our running
    // builders, which are the union of `output_item.done` payloads.
    const envOutput = this.envelope.output
    const useEnv = Array.isArray(envOutput) && envOutput.length > 0
    return {
      ...this.envelope,
      output: useEnv ? envOutput : fromItems,
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

  // Find the builder a delta targets. Priority order:
  //   1. `item_id` match against an existing item.id (most precise)
  //   2. Currently-open slot from the last `output_item.added`
  // Returns undefined if neither resolves — we silently drop the delta
  // rather than create a phantom slot.
  private slotFor(itemId: string | undefined): ItemBuilder | undefined {
    if (itemId) {
      for (const b of this.items) {
        if ((b.item as { id?: string }).id === itemId) return b
      }
    }
    if (this.openIndex != null) return this.items[this.openIndex]
    return undefined
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
        const incomingOutput =
          Array.isArray(r.output) && r.output.length > 0 ? r.output : undefined
        this.envelope = {
          ...(this.envelope ?? blankEnvelope()),
          ...r,
          // Critical: if `.completed` lacks output[] (chatgpt.com /
          // backend-api/codex omits it entirely), DON'T clobber the
          // running envelope.output we may have inherited. The actual
          // output lives in our `items` builders, which `getResponse()`
          // will materialise.
          output: incomingOutput ?? this.envelope?.output ?? [],
        }
        // If the upstream DID ship a canonical output[], it supersedes
        // anything we stitched — drop the builders to avoid duplicates.
        if (incomingOutput) this.items = []
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
      const item = (ev as any).item as ResponsesOutputItem | undefined
      if (!item) return
      this.items.push({ item: cloneItem(item) })
      this.openIndex = this.items.length - 1
      return
    }
    if (kind === 'response.output_item.done') {
      const item = (ev as any).item as ResponsesOutputItem | undefined
      if (item == null) return
      const itemId = (item as { id?: string }).id
      // Prefer matching by item.id (works even if we missed the
      // `.added` event or items were emitted out of band). Fall back
      // to the currently-open slot.
      let matchedIdx: number | undefined
      if (itemId) {
        for (let i = 0; i < this.items.length; i++) {
          if ((this.items[i].item as { id?: string }).id === itemId) {
            matchedIdx = i
            break
          }
        }
      }
      if (matchedIdx == null) matchedIdx = this.openIndex
      if (matchedIdx != null && matchedIdx < this.items.length) {
        this.items[matchedIdx] = { item: cloneItem(item) }
      } else {
        // Never saw an `.added` for this item — synthesise the slot so
        // the output isn't lost.
        this.items.push({ item: cloneItem(item) })
      }
      this.openIndex = undefined
      return
    }
    if (kind === 'response.output_text.delta') {
      const b = this.slotFor((ev as any).item_id)
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
      const b = this.slotFor((ev as any).item_id)
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.args = (b.args ?? '') + delta
      if (b.item.type === 'function_call') {
        ;(b.item as ResponsesFunctionCallItem).arguments = b.args
      }
      return
    }
    if (kind === 'response.custom_tool_call_input.delta') {
      const b = this.slotFor((ev as any).item_id)
      if (!b) return
      const delta = String((ev as any).delta ?? '')
      b.args = (b.args ?? '') + delta
      if (b.item.type === 'custom_tool_call') {
        ;(b.item as ResponsesCustomToolCallItem).input = b.args
      }
      return
    }
    if (kind === 'response.reasoning_text.delta') {
      const b = this.slotFor((ev as any).item_id)
      if (!b || b.item.type !== 'reasoning') return
      const delta = String((ev as any).delta ?? '')
      b.reasoningText = (b.reasoningText ?? '') + delta
      const r = b.item as ResponsesReasoningItem
      const content = r.content ?? []
      const existing = content.find((c) => c.type === 'text')
      if (existing) existing.text = b.reasoningText
      else content.push({ type: 'text', text: b.reasoningText })
      r.content = content
      return
    }
    if (kind === 'response.reasoning_summary_text.delta') {
      const b = this.slotFor((ev as any).item_id)
      if (!b || b.item.type !== 'reasoning') return
      const delta = String((ev as any).delta ?? '')
      b.reasoningSummaryText = (b.reasoningSummaryText ?? '') + delta
      const r = b.item as ResponsesReasoningItem
      const summary = r.summary ?? []
      const existing = summary.find((c) => c.type === 'summary_text')
      if (existing) existing.text = b.reasoningSummaryText
      else summary.push({ type: 'summary_text', text: b.reasoningSummaryText })
      r.summary = summary
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
