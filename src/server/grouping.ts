// Session + Message inference from Anthropic Messages API requests.
//
// Claude Code does not send a session-id header. We never know which `claude`
// process the request came from. So we infer:
//
// SESSION
//   A run of `claude` typically fires many API calls in quick succession —
//   not just the main agent's ReAct iterations, but also background calls
//   (a Haiku for title generation, another for topic classification, …).
//   These all share a single user-perceived "claude session".
//
//   We therefore group all requests within an IDLE WINDOW into one session.
//   If no proxy traffic for `idleMs`, the next request opens a new session.
//
// MESSAGE
//   Within a session, two requests belong to the same "message" iff
//     1. the older request's `messages` array is a prefix of the newer one's,
//        AND
//     2. the slice that was appended does NOT contain a new user-typed prompt
//        (only assistant outputs and tool_result echoes).
//
//   That covers the ReAct loop (iter 2/3/… extend iter 1's `messages` with
//   assistant + tool_result; same message). When the user types a new prompt
//   the appended slice contains a fresh user-text message → a new message
//   opens. Parallel background calls (haiku title, classifier, etc.) start
//   from their own short message arrays that don't extend any existing
//   message → each opens a fresh message too.

import type { AnthropicRequest, MessageParam } from '../lib/anthropic-types'

interface Message {
  messageId: string
  index: number
  // Last messages array we recorded for this message chain — the union of
  // all blocks seen so far. New requests extend this.
  lastMessages: MessageParam[]
  // Number of user-prompt messages committed to this chain. A new request
  // that increases this count opens a new message instead of extending.
  userPromptCount: number
  interactionCount: number
}

interface Session {
  sessionId: string
  startedAt: number
  lastSeenAt: number
  messages: Message[]
}

export interface GroupResolution {
  sessionId: string
  messageId: string
  isNewSession: boolean
  isNewMessage: boolean
  messageIndex: number
  interactionIndex: number
  firstUserText?: string
  isFirstCall: boolean
}

function isUserPromptMessage(m: MessageParam): boolean {
  if (m.role !== 'user') return false
  if (typeof m.content === 'string') return m.content.trim().length > 0
  // A user message that contains ANY tool_result block is always the agent's
  // tool round-trip, not a user-typed prompt — even if it carries adjacent
  // framework text blocks like "Tool loaded." (after a ToolSearch call),
  // date_change notices, plan_mode markers, etc. Claude Code attaches all
  // of those alongside the tool_result rather than as a fresh user turn.
  for (const block of m.content) {
    if (block.type === 'tool_result') return false
  }
  // Otherwise: must contain at least one non-trivial text/image block,
  // ignoring <system-reminder>…</system-reminder> wrappers.
  for (const block of m.content) {
    if (block.type === 'text') {
      const trimmed = block.text.trim()
      if (!trimmed) continue
      const stripped = trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (stripped.length > 0) return true
    } else if (block.type === 'image') {
      return true
    }
  }
  return false
}

function firstUserText(m: MessageParam): string | undefined {
  if (typeof m.content === 'string') return m.content
  for (const block of m.content) if (block.type === 'text') return block.text
  return undefined
}

function countUserPrompts(msgs: MessageParam[]): number {
  let n = 0
  for (const m of msgs) if (isUserPromptMessage(m)) n++
  return n
}

// Canonicalise a MessageParam for prefix-equality:
//   1. Coerce string `content` to a single-block text array — Anthropic
//      accepts both `{content: "x"}` and `{content: [{type:"text", text:"x"}]}`,
//      and Claude Code switches between forms across iterations.
//   2. Strip every `cache_control` marker recursively — Claude Code
//      re-anchors the ephemeral cache marker between calls; the first call
//      has it on the latest user block, the next call drops it (because the
//      prior content is now in the cached prefix).
// Without either, every ReAct continuation looks "different" and we
// wrongly open a new message.
function stripCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCacheControl)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      o[k] = stripCacheControl(val)
    }
    return o
  }
  return v
}

function canonical(m: MessageParam): unknown {
  const content =
    typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : m.content
  return { role: m.role, content: stripCacheControl(content) }
}

function isPrefixOf(prev: MessageParam[], next: MessageParam[]): boolean {
  if (prev.length > next.length) return false
  for (let i = 0; i < prev.length; i++) {
    if (JSON.stringify(canonical(prev[i])) !== JSON.stringify(canonical(next[i]))) {
      return false
    }
  }
  return true
}

export class Grouper {
  private sessions: Session[] = []
  private readonly idleMs: number

  constructor(opts: { idleMs?: number } = {}) {
    // 3 minutes is long enough to cover any conceivable in-CLI gap (model
    // streaming, slow tool execution) and short enough that two distinct
    // claude invocations rarely overlap. Override via constructor.
    this.idleMs = opts.idleMs ?? 3 * 60 * 1000
  }

  resolve(req: AnthropicRequest, now: number, newId: () => string): GroupResolution {
    // ── pick / open session
    let session: Session | undefined
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i]
      if (now - s.lastSeenAt <= this.idleMs) {
        session = s
        break
      }
    }
    let isNewSession = false
    if (!session) {
      session = {
        sessionId: newId(),
        startedAt: now,
        lastSeenAt: now,
        messages: [],
      }
      this.sessions.push(session)
      isNewSession = true
    }
    session.lastSeenAt = now

    // ── pick / open message inside session
    const reqUserPrompts = countUserPrompts(req.messages)
    let message: Message | undefined
    for (const m of session.messages) {
      if (m.userPromptCount !== reqUserPrompts) continue
      if (isPrefixOf(m.lastMessages, req.messages)) {
        message = m
        break
      }
    }
    let isNewMessage = false
    if (!message) {
      message = {
        messageId: newId(),
        index: session.messages.length,
        lastMessages: req.messages,
        userPromptCount: reqUserPrompts,
        interactionCount: 0,
      }
      session.messages.push(message)
      isNewMessage = true
    } else {
      // extension: update lastMessages
      message.lastMessages = req.messages
    }

    const interactionIndex = message.interactionCount
    message.interactionCount++

    // first-user-text preview for newly opened message
    let preview: string | undefined
    if (isNewMessage) {
      for (let i = req.messages.length - 1; i >= 0; i--) {
        if (isUserPromptMessage(req.messages[i])) {
          preview = firstUserText(req.messages[i])
          break
        }
      }
    }

    return {
      sessionId: session.sessionId,
      messageId: message.messageId,
      messageIndex: message.index,
      isNewSession,
      isNewMessage,
      interactionIndex,
      firstUserText: preview,
      isFirstCall: req.messages.length === 1 && req.messages[0]?.role === 'user',
    }
  }

  snapshot() {
    return this.sessions.map((s) => ({
      sessionId: s.sessionId,
      messageCount: s.messages.length,
      lastSeenAt: s.lastSeenAt,
    }))
  }
}
