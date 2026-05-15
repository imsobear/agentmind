// Display-time aggregation:
//   1. Drop helper API calls entirely — they're Claude Code's haiku side-calls
//      (topic classifier, post-processing, title generator) with no tools
//      and a tiny system prompt. They aren't the agent's reasoning loop,
//      they're framework bookkeeping, and surfacing them dilutes the
//      "what did the agent do" story.
//   2. Group consecutive main-agent API calls (ReAct iterations that extend
//      each other's `messages` array) into one user-facing message.
//   3. Reconstruct the ACTION steps that sit BETWEEN two API calls. Anthropic
//      models say "use these tools" in iter N's response (`tool_use` blocks)
//      and Claude Code shows up at iter N+1 with the `tool_result` blocks
//      wrapped in a user-role message. The local execution that produced
//      the result happens off-API in the gap — and that gap is the only
//      place we can express the real-world wall-clock cost the model never
//      sees. We pair tool_use ↔ tool_result by `tool_use_id` and attach
//      the gap-duration so the UI can render the ReAct loop literally as
//      `LLM call → [actions] → LLM call → … → end_turn`.
//
// Claude Code fires for each user prompt roughly:
//
//   t+0   helper #1  (haiku, no tools)        — topic classifier  ← dropped
//   t+1   MAIN       (sonnet, ~15 tools)      — the real agent, possibly
//                                                 with N ReAct iterations
//   t+8   helper #2  (haiku, no tools)        — post-processing   ← dropped
//
// Only the MAIN call's iterations are kept and rendered.

import type {
  AnthropicRequest,
  AnthropicResponse,
  CapturedInteraction,
  CapturedMessage,
} from '../lib/anthropic-types'
import {
  agentTypeOf,
  isMainInteractionFor,
  latestUserTextFromRequest,
  modelOf,
  stopReasonOf,
  transcriptLength,
  usageOf,
} from './interaction-view'

export interface InteractionStub {
  interactionId: string
  index: number
  startedAt: string
  endedAt?: string
  durationMs?: number
  model?: string
  toolCount: number
  stopReason: unknown
  usage?: unknown
  hasError: boolean
  // Count of items this iteration inherited verbatim from the previous
  // main-agent iteration's transcript (Anthropic `messages` / Responses
  // `input`). The first `prevMessageCount` entries are the cached
  // prefix; everything from `prevMessageCount` onwards is what was
  // appended between the two calls (the assistant's previous output +
  // the tool_result(s) it produced). 0 for the first iteration of a
  // message — the whole array is "new".
  prevMessageCount: number
  // Stamp the per-iteration agent type so cards can render the correct
  // protocol view. Optional for back-compat (pre-0.2 stubs lacked it).
  agentType?: import('../lib/anthropic-types').AgentType
}

// One local tool execution, paired by tool_use_id between two iterations.
export interface ActionEntry {
  toolUseId: string
  name: string
  // Full tool input — generally small (filenames, queries, commands).
  input: unknown
  // First N chars of the result text. Full data lives in the next
  // interaction's tool_result block; the UI links there for the rest.
  resultPreview?: string
  resultChars?: number
  resultTruncated?: boolean
  isError: boolean
  // No matching tool_result in the next iteration — extremely rare, would
  // indicate Claude Code skipped or dropped a tool the model called.
  unmatched?: boolean
  // tool_result content array included an inline image — preview text alone
  // can't represent it, the UI shows a marker.
  hasImage?: boolean
  // tool_result had `tool_reference` blocks (Anthropic ToolSearch hydration
  // of deferred tool schemas) — flagged so the renderer can label them.
  hasToolHydration?: boolean
}

// Everything that happened BETWEEN two adjacent main-agent iterations.
export interface ActionSegment {
  // The iteration whose response held the tool_use blocks.
  fromInteractionId: string
  // The iteration whose request carries the matching tool_result blocks.
  // Absent when the segment is `pending` (live; no follow-up captured yet,
  // or the user interrupted Claude Code mid-tool).
  toInteractionId?: string
  // Wall-clock between the producer iteration ending and the consumer
  // iteration starting. Roughly equals local tool execution time —
  // typically Bash sleeps, large Reads, MCP roundtrips.
  durationMs?: number
  pending?: boolean
  actions: ActionEntry[]
}

export interface AggregatedMessage extends CapturedMessage {
  interactions: InteractionStub[]
  stopReason: unknown
  actionSegments: ActionSegment[]
}

// A request whose `tools` array is non-empty came from the real agent.
// Anything with zero tools is a helper call (Claude Code's haiku topic
// classifier, post-processing, title generator; Codex CLI's compaction /
// summariser) — pure framework noise from the user's perspective,
// dropped at display time. See `interaction-view.isMainInteractionFor`
// for the protocol-agnostic implementation.
export function isMainInteraction(it: CapturedInteraction): boolean {
  return isMainInteractionFor(it)
}

export function aggregateMessages(
  messages: CapturedMessage[],
  interactions: CapturedInteraction[],
  countToolUseBlocks: (it: CapturedInteraction) => number,
): AggregatedMessage[] {
  // Bucket interactions by their stored messageId.
  const byMsgId = new Map<string, CapturedInteraction[]>()
  for (const it of interactions) {
    const arr = byMsgId.get(it.messageId) ?? []
    arr.push(it)
    byMsgId.set(it.messageId, arr)
  }

  // Keep only messages that contain at least one main-agent interaction.
  // Helper-only messages (those built entirely from haiku side-calls) are
  // dropped wholesale.
  const aggregated: AggregatedMessage[] = []
  for (const m of messages) {
    const all = byMsgId.get(m.messageId) ?? []
    const mainIts = all.filter(isMainInteraction)
    if (mainIts.length === 0) continue
    mainIts.sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    )
    aggregated.push(
      buildAggregated(
        { ...m, firstUserText: deriveFirstUserText(mainIts) ?? m.firstUserText },
        mainIts,
        countToolUseBlocks,
        0,
      ),
    )
  }

  // Sort by start time and reindex.
  aggregated.sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  )
  aggregated.forEach((m, i) => (m.index = i))
  return aggregated
}

// Pull the latest user-typed text from a main interaction's request.
// Delegates to interaction-view so the per-protocol differences (Anthropic
// `messages` with <system-reminder> wrappers vs Responses `input` with
// plain text blocks) live in one place.
function deriveFirstUserText(mainIts: CapturedInteraction[]): string | undefined {
  if (!mainIts.length) return undefined
  return latestUserTextFromRequest(mainIts[0])
}

function buildAggregated(
  m: CapturedMessage,
  its: CapturedInteraction[],
  countToolUseBlocks: (it: CapturedInteraction) => number,
  index: number,
): AggregatedMessage {
  const stubs: InteractionStub[] = its.map((it, idx) => ({
    interactionId: it.interactionId,
    index: idx,
    startedAt: it.startedAt,
    endedAt: it.endedAt,
    durationMs: it.durationMs,
    model: modelOf(it),
    // Caller can pass a custom counter (middleware does, for legacy
    // reasons), but the per-protocol default in interaction-view is
    // identical, so the parameter is now effectively redundant. Kept
    // for the signature compat.
    toolCount: countToolUseBlocks(it),
    stopReason: stopReasonOf(it) as InteractionStub['stopReason'],
    usage: usageOf(it),
    hasError: !!it.error,
    prevMessageCount: idx > 0 ? transcriptLength(its[idx - 1]) : 0,
    agentType: agentTypeOf(it),
  }))
  const earliestStart = stubs.length ? stubs[0].startedAt : m.startedAt
  const stopReason = stubs.length ? stubs[stubs.length - 1].stopReason : null
  return {
    ...m,
    index,
    startedAt: earliestStart,
    interactions: stubs,
    stopReason,
    actionSegments: computeActionSegments(its),
  }
}

// ── Action reconstruction ─────────────────────────────────────────────
//
// For each main iteration, look at its `tool_use` blocks (the model's
// "Action" step in ReAct) and pair them with the matching `tool_result`
// blocks from the NEXT iteration's request. The pair represents one
// local tool execution that happened between the two API calls.
//
// Where the results sit in the next request: Claude Code packs tool_result
// blocks into the most recent user-role message of `messages[]`, often
// alongside framework text wrappers (system-reminders, plan-mode markers,
// "Tool loaded." after ToolSearch). We walk the user messages from the
// end backwards and pick the first one that actually contains tool_result
// blocks — robust to those framework text-only user turns sometimes
// interleaved by claude code.

const RESULT_PREVIEW_LIMIT = 2048

function flattenResultContent(content: unknown): {
  text: string
  chars: number
  hasImage: boolean
  hasToolHydration: boolean
} {
  if (typeof content === 'string') {
    return {
      text: content,
      chars: content.length,
      hasImage: false,
      hasToolHydration: false,
    }
  }
  if (!Array.isArray(content)) {
    return { text: '', chars: 0, hasImage: false, hasToolHydration: false }
  }
  let text = ''
  let chars = 0
  let hasImage = false
  let hasToolHydration = false
  for (const sub of content) {
    if (typeof sub === 'string') {
      text += sub + '\n'
      chars += sub.length
      continue
    }
    if (!sub || typeof sub !== 'object') continue
    const s = sub as { type?: string; text?: string }
    if (s.type === 'text' && typeof s.text === 'string') {
      text += s.text + '\n'
      chars += s.text.length
    } else if (s.type === 'image') {
      hasImage = true
    } else if (s.type === 'tool_reference') {
      hasToolHydration = true
    }
  }
  return { text, chars, hasImage, hasToolHydration }
}

export function computeActionSegments(its: CapturedInteraction[]): ActionSegment[] {
  // Action segments are currently only computed for Anthropic
  // interactions — the tool_use/tool_result pairing is bespoke to that
  // shape (see implementation below). For Codex CLI's Responses-API
  // traffic the equivalent pairing (function_call → function_call_output)
  // is reconstructible but not implemented in 0.2.0; segments stay
  // empty for those messages and the UI falls back to the per-iter card
  // view. Tracked as a polish ticket for 0.3.
  if (its.length && agentTypeOf(its[0]) !== 'claude-code') return []
  const segments: ActionSegment[] = []
  for (let i = 0; i < its.length; i++) {
    const cur = its[i]
    const curResp = cur.response as AnthropicResponse | undefined
    const toolUses = (curResp?.content ?? []).filter(
      (b) => b.type === 'tool_use',
    ) as Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>
    if (toolUses.length === 0) continue

    const next = its[i + 1]
    if (!next) {
      // Producer iteration ended with tool_use but no follow-up arrived.
      // Live session, or interrupted before tools completed.
      segments.push({
        fromInteractionId: cur.interactionId,
        pending: true,
        actions: toolUses.map((tu) => ({
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
          isError: false,
        })),
      })
      continue
    }

    const nextReq = next.request as AnthropicRequest | undefined
    const msgs = nextReq?.messages ?? []
    let toolResults: Array<{
      tool_use_id: string
      content: unknown
      is_error?: boolean
    }> = []
    for (let j = msgs.length - 1; j >= 0; j--) {
      const m = msgs[j]
      if (m.role !== 'user' || typeof m.content === 'string') continue
      const trs = m.content.filter(
        (b: any) => b.type === 'tool_result',
      ) as Array<{ tool_use_id: string; content: unknown; is_error?: boolean }>
      if (trs.length) {
        toolResults = trs
        break
      }
    }
    const resultById = new Map(toolResults.map((r) => [r.tool_use_id, r]))

    const actions: ActionEntry[] = toolUses.map((tu) => {
      const r = resultById.get(tu.id)
      if (!r) {
        return {
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
          isError: false,
          unmatched: true,
        }
      }
      const flat = flattenResultContent(r.content)
      const truncated = flat.text.length > RESULT_PREVIEW_LIMIT
      return {
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        resultPreview: truncated ? flat.text.slice(0, RESULT_PREVIEW_LIMIT) : flat.text,
        resultChars: flat.chars,
        resultTruncated: truncated || undefined,
        isError: r.is_error === true,
        hasImage: flat.hasImage || undefined,
        hasToolHydration: flat.hasToolHydration || undefined,
      }
    })

    const endedAtMs = cur.endedAt
      ? new Date(cur.endedAt).getTime()
      : new Date(cur.startedAt).getTime() + (cur.durationMs ?? 0)
    const nextStartedAtMs = new Date(next.startedAt).getTime()

    segments.push({
      fromInteractionId: cur.interactionId,
      toInteractionId: next.interactionId,
      durationMs: Math.max(0, nextStartedAtMs - endedAtMs),
      actions,
    })
  }
  return segments
}
