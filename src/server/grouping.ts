// Project + Message inference from Anthropic Messages API requests.
//
// Claude Code does not send a project- or session-id header. We never
// know which `claude` process the request came from. So we infer:
//
// PROJECT
//   One project per working-directory. The `claude` process running in
//   /foo/bar always belongs to project hash("/foo/bar"), regardless of
//   how many times it's restarted, regardless of how long ago the
//   previous run finished. This makes the URL stable for bookmarks and
//   matches the user's mental model — "this is the project I'm working
//   on in /foo/bar".
//
//   The cwd is best-effort recovered from the system prompt. A few
//   helper requests (haiku title-gen, topic classifier, summariser…)
//   don't expose their cwd because their system prompt is too sparse;
//   we attach those to whichever project most recently received a
//   cwd-bearing request from this proxy process. They invariably arrive
//   alongside their parent agent's main call, so "most recent cwd" is a
//   safe attribution.
//
// MESSAGE
//   Within a project, two requests belong to the same "message" iff
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
import { projectIdForCwd } from './projectId'

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

interface Project {
  projectId: string
  startedAt: number
  // The working directory recovered from the first cwd-bearing request.
  // Always present after the first such request — undefined only for
  // brand-new in-process state before any cwd has been seen.
  cwd: string
  messages: Message[]
}

export interface GroupResolution {
  projectId: string
  messageId: string
  isNewProject: boolean
  isNewMessage: boolean
  messageIndex: number
  interactionIndex: number
  firstUserText?: string
  isFirstCall: boolean
  // The cwd we ultimately attributed the request to. Useful for the
  // proxy when it writes the `project` header record on first sight.
  cwd: string
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

// Snapshot of an existing project on disk, supplied by the Storage
// layer at Grouper cold-miss time so message indices keep increasing
// across proxy restarts (the projectId is now deterministic from cwd,
// so two runs in the same directory all append to the same file —
// without rehydration the second run's "iter 1" would re-use index 0).
export interface ProjectHydration {
  cwd: string
  messages: Array<{
    messageId: string
    index: number
    lastMessages: MessageParam[]
    userPromptCount: number
    interactionCount: number
  }>
}

export interface GrouperDeps {
  // Called on first sight of a cwd in this process. Return any messages
  // already persisted for that cwd so subsequent indices continue from
  // there. Returning `undefined` (project not on disk) opens a fresh
  // project starting at message index 0.
  hydrate?: (cwd: string) => ProjectHydration | undefined
}

export class Grouper {
  // Keyed by cwd. Resolution is O(1) — no scan, no time window.
  private projects = new Map<string, Project>()
  // Last cwd we routed a request to. Helper calls without their own cwd
  // (haiku title-gen etc.) attach to this. Empty before the first
  // cwd-bearing request — those rare leading helpers go to a synthetic
  // "_orphan_" project to avoid dropping them on the floor.
  private lastCwd: string | undefined
  private readonly deps: GrouperDeps

  constructor(deps: GrouperDeps = {}) {
    this.deps = deps
  }

  resolve(
    req: AnthropicRequest,
    now: number,
    newId: () => string,
    cwd: string | undefined,
  ): GroupResolution {
    const resolvedCwd = cwd ?? this.lastCwd ?? '_orphan_'

    let project = this.projects.get(resolvedCwd)
    let isNewProject = false
    if (!project) {
      // Cold miss in this process — but the cwd's project file may
      // already exist on disk from previous runs. Pull the persisted
      // message chain so we extend it rather than starting fresh.
      const hydration = this.deps.hydrate?.(resolvedCwd)
      project = {
        projectId: projectIdForCwd(resolvedCwd),
        startedAt: now,
        cwd: resolvedCwd,
        messages: hydration?.messages.map((m) => ({ ...m })) ?? [],
      }
      this.projects.set(resolvedCwd, project)
      // Only mark as new when there's nothing on disk yet — that's the
      // signal proxy.ts uses to write the `project` header record.
      isNewProject = !hydration
    }
    if (cwd) this.lastCwd = cwd

    // ── pick / open message inside project
    const reqUserPrompts = countUserPrompts(req.messages)
    let message: Message | undefined
    for (const m of project.messages) {
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
        index: project.messages.length,
        lastMessages: req.messages,
        userPromptCount: reqUserPrompts,
        interactionCount: 0,
      }
      project.messages.push(message)
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
      projectId: project.projectId,
      messageId: message.messageId,
      messageIndex: message.index,
      isNewProject,
      isNewMessage,
      interactionIndex,
      firstUserText: preview,
      isFirstCall: req.messages.length === 1 && req.messages[0]?.role === 'user',
      cwd: resolvedCwd,
    }
  }

  snapshot() {
    return Array.from(this.projects.values()).map((p) => ({
      projectId: p.projectId,
      cwd: p.cwd,
      messageCount: p.messages.length,
    }))
  }
}
