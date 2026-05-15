// Protocol adapters.
//
// Each upstream protocol (Anthropic Messages, OpenAI Responses) exposes a
// thin Adapter to the proxy/grouper layer. The Adapter is responsible for
// the protocol-specific bits:
//
//   1. Parsing the incoming JSON body
//   2. Extracting the cwd (so we can route into the right project)
//   3. Normalising the request's transcript into the Anthropic-shaped
//      MessageParam[] that the Grouper uses for prefix-equality message
//      detection. The Grouper itself stays oblivious to which protocol
//      produced the input — that's the whole point of this layer.
//   4. Producing an SseAccumulator-shaped object that decodes the
//      protocol's specific event stream and assembles a final response.
//
// Adding a third agent later means adding a third Adapter, NOT touching
// proxy.ts. Keep that invariant.

import type { AgentType, MessageParam } from '../lib/anthropic-types'
import type { AnthropicRequest } from '../lib/anthropic-types'
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesContentItem,
} from '../lib/openai-responses-types'
import { SseAccumulator } from './sse'
import { ResponsesSseAccumulator } from './responses-sse'

// The minimum surface the proxy needs from an accumulator. Both Anthropic
// (`SseAccumulator`) and Responses (`ResponsesSseAccumulator`) satisfy
// this without changes.
export interface SseAccumulatorLike {
  feed(chunk: string): void
  flush(): void
  // Snapshot for live streaming. Shape varies by protocol — UI narrows on
  // `interaction.agentType`.
  getResponse(): unknown
  // Raw events captured so far, written to JSONL on completion.
  events: unknown[]
}

export interface ProtocolAdapter {
  readonly agentType: AgentType
  // URL path we route on. Multiple paths => one adapter per path.
  readonly endpointPath: string
  // Parse the incoming HTTP body. Returns `undefined` on invalid JSON;
  // the caller bails to 400 in that case.
  parseRequest(body: Buffer): unknown
  // Extract cwd from a freshly-parsed request. Best-effort — return
  // undefined when nothing in the prompt exposes one. Helper-call routing
  // (which doesn't have a cwd) falls back to "most recent" in Grouper.
  extractCwd(req: unknown): string | undefined
  // Pull the canonical model name out of the request for project headers.
  extractModel(req: unknown): string | undefined
  // Project the request's transcript onto the Anthropic-shaped MessageParam[]
  // form the Grouper consumes. The shape doesn't have to be lossless — it's
  // only used to detect "this request extends a prior one" via prefix
  // equality. Anthropic's adapter returns its messages array directly;
  // Responses flattens its `input[]` into role-tagged content blocks.
  normaliseMessages(req: unknown): MessageParam[]
  // A fresh per-interaction accumulator.
  createAccumulator(): SseAccumulatorLike
}

// ── Anthropic Messages ─────────────────────────────────────────────────────

class AnthropicAdapter implements ProtocolAdapter {
  readonly agentType: AgentType = 'claude-code'
  readonly endpointPath = '/v1/messages'

  parseRequest(body: Buffer): AnthropicRequest | undefined {
    try {
      return JSON.parse(body.toString('utf8')) as AnthropicRequest
    } catch {
      return undefined
    }
  }

  extractCwd(req: unknown): string | undefined {
    const r = req as AnthropicRequest | undefined
    if (!r) return undefined
    const sys = r.system
    let text = ''
    if (typeof sys === 'string') text = sys
    else if (Array.isArray(sys)) text = sys.map((b) => b.text).join('\n')
    if (!text) return undefined
    const m = text.match(/(?:cwd|working[_ ]?directory)\s*[:=]\s*([^\n]+)/i)
    return m?.[1]?.trim() || undefined
  }

  extractModel(req: unknown): string | undefined {
    return (req as AnthropicRequest | undefined)?.model
  }

  normaliseMessages(req: unknown): MessageParam[] {
    return (req as AnthropicRequest | undefined)?.messages ?? []
  }

  createAccumulator(): SseAccumulatorLike {
    return new SseAccumulator() as unknown as SseAccumulatorLike
  }
}

// ── OpenAI Responses ───────────────────────────────────────────────────────

class ResponsesAdapter implements ProtocolAdapter {
  readonly agentType: AgentType = 'codex-cli'
  readonly endpointPath = '/v1/responses'

  parseRequest(body: Buffer): ResponsesRequest | undefined {
    try {
      return JSON.parse(body.toString('utf8')) as ResponsesRequest
    } catch {
      return undefined
    }
  }

  // Codex CLI wraps its environment in an XML-tagged contextual user
  // fragment:
  //   <environment_context>
  //     <cwd>/abs/path</cwd>
  //     <shell>zsh</shell>
  //     ...
  //   </environment_context>
  //
  // Single-environment path uses a top-level <cwd>; multi-env wraps each
  // in <environment id="…"><cwd>…</cwd>…</environment>. Either way the
  // first <cwd>…</cwd> in the request text is the one we want. Source
  // truth: openai/codex:codex-rs/core/src/context/environment_context.rs.
  //
  // We search both `instructions` and every text part of `input[]` — the
  // env block is normally injected as a user-role input message rather
  // than into instructions.
  extractCwd(req: unknown): string | undefined {
    const r = req as ResponsesRequest | undefined
    if (!r) return undefined
    const candidates: string[] = []
    if (typeof r.instructions === 'string') candidates.push(r.instructions)
    for (const item of r.input ?? []) {
      if (item.type !== 'message') continue
      for (const c of item.content ?? []) {
        if (c.type === 'input_text' || c.type === 'output_text') {
          candidates.push((c as { text: string }).text)
        }
      }
    }
    for (const text of candidates) {
      const m = text.match(/<cwd>([^<\n]+)<\/cwd>/)
      const cwd = m?.[1]?.trim()
      if (cwd) return cwd
    }
    return undefined
  }

  extractModel(req: unknown): string | undefined {
    return (req as ResponsesRequest | undefined)?.model
  }

  // Project Responses `input[]` onto Anthropic-shaped MessageParam[] so the
  // Grouper's prefix-equality logic works unchanged. Lossy on purpose —
  // we don't have to round-trip, just need stable canonical form across
  // iterations.
  //
  //   - Each `{type:"message", role, content:[...]}` becomes one
  //     MessageParam, with content items remapped:
  //       input_text   → {type:"text", text}
  //       output_text  → {type:"text", text}
  //       input_image  → {type:"image", source:{type:"url", url:image_url}}
  //   - Each `{type:"function_call_output", call_id, output}` becomes a
  //     user-role message holding a synthetic `tool_result` block.
  //     This lets the Grouper recognise "this iter inherited a tool
  //     result" → same message as the previous iter.
  //   - Custom/MCP/tool_search outputs collapse onto the same shape.
  //   - Anything else (rare/future) is dropped from the grouping view.
  normaliseMessages(req: unknown): MessageParam[] {
    const r = req as ResponsesRequest | undefined
    if (!r?.input) return []
    const out: MessageParam[] = []
    for (const item of r.input) {
      const m = normaliseInputItem(item)
      if (m) out.push(m)
    }
    return out
  }

  createAccumulator(): SseAccumulatorLike {
    return new ResponsesSseAccumulator() as unknown as SseAccumulatorLike
  }
}

function normaliseInputItem(item: ResponsesInputItem): MessageParam | undefined {
  if (item.type === 'message') {
    // Codex emits assistant/user/system/developer; Anthropic's role union
    // only models user|assistant for MessageParam (system goes elsewhere).
    // We coerce system/developer to assistant so prefix-equality still
    // captures them; group resolution doesn't care which.
    const role: 'user' | 'assistant' = item.role === 'user' ? 'user' : 'assistant'
    return { role, content: contentForGrouping(item.content) }
  }
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: stringifyToolOutput(item.output),
        },
      ],
    }
  }
  if (item.type === 'mcp_tool_call_output') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
        },
      ],
    }
  }
  if (item.type === 'tool_search_output') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: JSON.stringify({ status: item.status, execution: item.execution, count: item.tools.length }),
        },
      ],
    }
  }
  return undefined
}

function contentForGrouping(
  cs: ResponsesContentItem[] | undefined,
): MessageParam['content'] {
  if (!cs?.length) return ''
  const blocks: any[] = []
  for (const c of cs) {
    if (c.type === 'input_text' || c.type === 'output_text') {
      blocks.push({ type: 'text', text: (c as { text: string }).text })
    } else if (c.type === 'input_image') {
      blocks.push({ type: 'image', source: { type: 'url', url: c.image_url } })
    }
  }
  return blocks
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((b: any) => (b?.type === 'input_text' ? String(b.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

export const adapters: ProtocolAdapter[] = [new AnthropicAdapter(), new ResponsesAdapter()]

export function adapterForPath(path: string): ProtocolAdapter | undefined {
  return adapters.find((a) => a.endpointPath === path)
}
