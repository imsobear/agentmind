// Per-interaction view extractors that dispatch on `agentType`.
//
// `aggregate.ts` and `middleware.ts` need to ask high-level questions like
// "what model was this?", "how many tool calls did it make?", "what was
// the stop reason?" without caring whether the underlying request/response
// is Anthropic-shaped or OpenAI-Responses-shaped. This module is the one
// place where that dispatch happens.
//
// Pre-0.2 records have no `agentType` — readers must default to
// `claude-code` (the only protocol we shipped then). Everything below
// honours that fallback.

import type { CapturedInteraction, AgentType, MessageParam } from '../lib/anthropic-types'
import type {
  AnthropicRequest,
  AnthropicResponse,
  StopReason,
  Usage,
} from '../lib/anthropic-types'
import type {
  ResponsesRequest,
  ResponsesObject,
  ResponsesUsage,
  ResponsesOutputItem,
} from '../lib/openai-responses-types'
import { adapters } from './adapters'

export function agentTypeOf(it: CapturedInteraction): AgentType {
  return it.agentType ?? 'claude-code'
}

export function modelOf(it: CapturedInteraction): string | undefined {
  const req = it.request as any
  return req?.model
}

// "Main" = the real agent's main-thread call, not a framework helper.
//
// Two layers of filtering, applied in order:
//
//   1. Tool-count gate. Helper calls (Claude Code's haiku title-gen,
//      topic classifier; Codex CLI's compaction summariser) ship with
//      zero tools — the model has nothing to do but answer in text.
//      Anything with `tools.length >= 1` is at least a candidate for
//      being the main agent.
//
//   2. Known-prompt gate. Claude Code re-uses the main agent's full
//      tool set for several internal-only calls (auto-recap when the
//      user idles, "suggestion mode" lookahead, context compaction).
//      They satisfy gate #1 but are NOT user-driven and showing them
//      as messages just makes the project history harder to read.
//      We reject them by matching the latest user-prompt against a
//      small list of stable framework prefixes — chosen so a real
//      user typing the same words would either start with `>` quoting
//      or different framing, and so a false-positive only loses a
//      visible message (the underlying record stays on disk).
export function isMainInteractionFor(it: CapturedInteraction): boolean {
  const req = it.request as any
  const tools = req?.tools
  if (!Array.isArray(tools) || tools.length < 1) return false
  if (isFrameworkInternalPrompt(it)) return false
  return true
}

// Prefix patterns that identify a framework-injected user turn. Kept
// public so docs / tests can reference the same list.
export const FRAMEWORK_INTERNAL_PROMPT_PREFIXES: Record<AgentType, string[]> = {
  'claude-code': [
    // Auto-recap when the user comes back from idle. Verbatim prefix
    // emitted by Claude Code 1.x.
    'The user stepped away and is coming back. Recap',
    // "What might the user type next?" lookahead. Always wrapped in
    // square-bracket framing.
    '[SUGGESTION MODE:',
    // Context compaction call — Claude Code summarises the running
    // transcript when token usage gets high.
    '# IMPORTANT! Output context summary',
    // Slash-command "init" probe that lists tools without doing work.
    'Your task is to create a new file called CLAUDE.md',
  ],
  // We don't yet have a confirmed Codex framework-internal prompt that
  // makes it past the tool-count gate. Codex's compaction call ships
  // with tools=[] so it's filtered at gate #1.
  'codex-cli': [],
  unknown: [],
}

function isFrameworkInternalPrompt(it: CapturedInteraction): boolean {
  const agent = agentTypeOf(it)
  const prefixes = FRAMEWORK_INTERNAL_PROMPT_PREFIXES[agent]
  if (!prefixes?.length) return false
  const text = latestUserTextFromRequest(it)
  if (!text) return false
  const head = text.trimStart()
  for (const p of prefixes) {
    if (head.startsWith(p)) return true
  }
  return false
}

// Count tool invocations in the response.
//   - Anthropic: number of `tool_use` blocks in `response.content`
//   - Responses: number of `function_call` / `custom_tool_call` items in `output`
// Used for the iteration row's "N tools" badge.
export function countToolUses(it: CapturedInteraction): number {
  if (agentTypeOf(it) === 'codex-cli') {
    const resp = it.response as ResponsesObject | undefined
    if (!resp?.output) return 0
    let n = 0
    for (const item of resp.output) {
      if (item.type === 'function_call' || item.type === 'custom_tool_call') n++
    }
    return n
  }
  const resp = it.response as AnthropicResponse | undefined
  if (!resp?.content) return 0
  let n = 0
  for (const b of resp.content) if (b.type === 'tool_use') n++
  return n
}

export function stopReasonOf(it: CapturedInteraction): StopReason | string | null {
  if (agentTypeOf(it) === 'codex-cli') {
    // Map Responses' `status` onto something the existing UI recognises.
    // The mapping is intentionally loose — anything that isn't an
    // obvious "the agent stopped of its own accord" surfaces as a raw
    // status string, which the UI renders as-is.
    const r = it.response as ResponsesObject | undefined
    if (!r) return null
    switch (r.status) {
      case 'completed': {
        // If the model emitted any tool_call output, treat as `tool_use`
        // so action segments / "open" badge work analogously to Anthropic.
        if (countToolUses(it) > 0) return 'tool_use'
        return 'end_turn'
      }
      case 'incomplete':
        return 'max_tokens'
      case 'failed':
      case 'cancelled':
        return r.status
      case 'in_progress':
        return null
      default:
        return r.status ?? null
    }
  }
  const r = it.response as AnthropicResponse | undefined
  return r?.stop_reason ?? null
}

// Tokens used. Normalise the field names so the UI doesn't need a switch.
export function usageOf(it: CapturedInteraction): Usage | undefined {
  if (agentTypeOf(it) === 'codex-cli') {
    const u = (it.response as ResponsesObject | undefined)?.usage as ResponsesUsage | undefined
    if (!u) return undefined
    return {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cached_tokens,
      // Codex's `reasoning_tokens` is the closest analogue to Anthropic's
      // `cache_creation_input_tokens` for the "this iter cost extra"
      // signal — surface it under that field so existing columns just
      // work. The label happens to be wrong but the magnitude is right;
      // a polish pass can rename if we ever differentiate the two.
      cache_creation_input_tokens: u.reasoning_tokens,
    }
  }
  return (it.response as AnthropicResponse | undefined)?.usage
}

// Number of transcript items in this iteration's request — used to compute
// `prevMessageCount` (how many items the iteration inherited from its
// predecessor). For Anthropic that's `messages.length`; for Responses
// that's `input.length`.
export function transcriptLength(it: CapturedInteraction): number {
  if (agentTypeOf(it) === 'codex-cli') {
    return (it.request as ResponsesRequest | undefined)?.input?.length ?? 0
  }
  return (it.request as AnthropicRequest | undefined)?.messages?.length ?? 0
}

// Latest user-typed prompt text in this interaction's request transcript.
// Used for the sidebar preview. Re-implements the bespoke Anthropic logic
// (strip <system-reminder> wrappers, walk backwards) but for the Responses
// shape we just take the freshest user-role input_text.
export function latestUserTextFromRequest(it: CapturedInteraction): string | undefined {
  if (agentTypeOf(it) === 'codex-cli') {
    const r = it.request as ResponsesRequest | undefined
    const items = r?.input ?? []
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.type !== 'message' || item.role !== 'user') continue
      for (const c of item.content) {
        if (c.type === 'input_text' && c.text.trim()) return c.text
      }
    }
    return undefined
  }
  const msgs = ((it.request as AnthropicRequest | undefined)?.messages ?? []) as MessageParam[]
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      const t = m.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (t) return t
      continue
    }
    for (const b of m.content) {
      if (b.type === 'text') {
        const t = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        if (t) return t
      }
    }
  }
  return undefined
}

// Best-effort normalisation back to MessageParam[] for the Grouper's
// prefix-equality logic when hydrating from disk. We re-use the
// per-protocol adapter so this stays one place.
export function normaliseRequestForGrouping(it: CapturedInteraction): MessageParam[] {
  const agent = agentTypeOf(it)
  const adapter = adapters.find((a) => a.agentType === agent)
  if (!adapter) return []
  return adapter.normaliseMessages(it.request)
}

// "How many transcript items did this iter inherit from the previous
// iter's transcript?" Used by the UI's diff badges. Both protocols send
// cumulative transcripts so this is just "prev iter's length".
export function prevTranscriptLength(prev: CapturedInteraction | undefined): number {
  if (!prev) return 0
  return transcriptLength(prev)
}

export type { ResponsesOutputItem }
