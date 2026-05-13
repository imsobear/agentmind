// Minimal Anthropic SSE parser. We tee the upstream stream byte-for-byte to
// the client while also accumulating decoded events for the JSONL capture.

import type {
  SseEvent,
  AnthropicResponse,
  ContentBlock,
  Usage,
  StopReason,
} from '../lib/anthropic-types'

export class SseAccumulator {
  private buffer = ''
  // Internal decoder for the streaming response. We rebuild a final
  // AnthropicResponse-shaped object as events arrive — same shape as a
  // non-streaming call would return.
  private msg: AnthropicResponse | null = null
  events: SseEvent[] = []

  // Feed raw bytes from the upstream. Returns nothing — events accumulate in
  // `events` and the assembled response in `getResponse()`.
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

  // Flush any trailing event if upstream closed without a final \n\n.
  flush() {
    if (this.buffer.trim()) {
      this.parseEventBlock(this.buffer)
      this.buffer = ''
    }
  }

  getResponse(): AnthropicResponse | undefined {
    return this.msg ?? undefined
  }

  private parseEventBlock(block: string) {
    // SSE event block: lines prefixed with "event:" and "data:".
    let eventName: string | undefined
    let dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
    }
    if (!dataLines.length) return
    const dataStr = dataLines.join('\n')
    let data: any
    try {
      data = JSON.parse(dataStr)
    } catch {
      return
    }
    if (!eventName && data?.type) eventName = data.type
    if (!eventName) return
    const ev = { ...data, type: eventName } as SseEvent
    this.events.push(ev)
    this.applyEvent(ev)
  }

  private applyEvent(ev: SseEvent) {
    switch (ev.type) {
      case 'message_start': {
        // ev.message is a partial AnthropicResponse with empty content.
        this.msg = { ...ev.message, content: [] }
        break
      }
      case 'content_block_start': {
        if (!this.msg) return
        // Clone so future deltas can mutate safely.
        const block = JSON.parse(JSON.stringify(ev.content_block)) as ContentBlock
        // Initialise mutable accumulators on the block.
        // For tool_use, Anthropic always sends `input: {}` in the start event,
        // but the real arguments stream in via `input_json_delta` as a JSON
        // string. Overwrite to empty string so deltas append cleanly; we
        // parse the assembled string at content_block_stop.
        if (block.type === 'tool_use') {
          ;(block as any).input = ''
        }
        this.msg.content[ev.index] = block
        break
      }
      case 'content_block_delta': {
        if (!this.msg) return
        const block: any = this.msg.content[ev.index]
        if (!block) return
        const d: any = ev.delta
        switch (d.type) {
          case 'text_delta':
            block.text = (block.text ?? '') + d.text
            break
          case 'thinking_delta':
            block.thinking = (block.thinking ?? '') + d.thinking
            break
          case 'signature_delta':
            block.signature = (block.signature ?? '') + d.signature
            break
          case 'input_json_delta':
            // For tool_use blocks, Anthropic streams the arguments as JSON
            // text. We accumulate as a string and parse on stop.
            block.input = (block.input ?? '') + d.partial_json
            break
        }
        break
      }
      case 'content_block_stop': {
        if (!this.msg) return
        const block: any = this.msg.content[ev.index]
        if (!block) return
        if (block.type === 'tool_use' && typeof block.input === 'string') {
          // Finalise: parse the assembled JSON string. If it's empty, default to {}.
          const raw: string = block.input
          if (!raw) block.input = {}
          else {
            try {
              block.input = JSON.parse(raw)
            } catch {
              // leave as string; better than dropping data
            }
          }
        }
        break
      }
      case 'message_delta': {
        if (!this.msg) return
        const d = ev.delta as { stop_reason?: StopReason; stop_sequence?: string | null }
        if (d.stop_reason !== undefined) this.msg.stop_reason = d.stop_reason
        if (d.stop_sequence !== undefined) this.msg.stop_sequence = d.stop_sequence
        if (ev.usage) {
          // message_delta carries cumulative output usage; merge.
          this.msg.usage = mergeUsage(this.msg.usage, ev.usage)
        }
        break
      }
      case 'message_stop':
      case 'ping':
      case 'error':
        break
    }
  }
}

function mergeUsage(a: Usage | undefined, b: Usage): Usage {
  return {
    input_tokens: b.input_tokens ?? a?.input_tokens,
    output_tokens: b.output_tokens ?? a?.output_tokens,
    cache_creation_input_tokens:
      b.cache_creation_input_tokens ?? a?.cache_creation_input_tokens,
    cache_read_input_tokens:
      b.cache_read_input_tokens ?? a?.cache_read_input_tokens,
  }
}
