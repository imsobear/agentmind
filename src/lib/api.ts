// Typed fetch wrappers around /api/*. Mirror the response shapes built in
// src/server/middleware.ts. Keep them additive — the server is authoritative.

import type {
  AgentType,
  AnthropicRequest,
  AnthropicResponse,
  CapturedInteraction,
  CapturedMessage,
  CapturedProject,
  SseEvent,
  StopReason,
  Usage,
} from './anthropic-types'

export interface ProjectListItem {
  projectId: string
  startedAt?: string
  cwd?: string
  model?: string
  // Which agent owns this project. Pre-0.2 records lack this field —
  // treat missing as `'claude-code'` for back-compat.
  agentType?: AgentType
  mtime: number
  sizeBytes: number
  messageCount: number
  interactionCount: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  isLive: boolean
  lastInteractionAt?: string
}

export interface InteractionStub {
  interactionId: string
  index: number
  startedAt: string
  endedAt?: string
  durationMs?: number
  model?: string
  toolCount: number
  // The Responses API can produce status strings outside Anthropic's
  // closed `stop_reason` union (e.g. "failed", "cancelled"). Widen to
  // string here — UI narrows back to the Anthropic palette when it can.
  stopReason: StopReason | string | null
  usage?: Usage
  hasError: boolean
  // Items this iter inherited verbatim from the previous main-agent
  // iter — request transcript[0 .. prevMessageCount-1] is the cached
  // prefix, transcript[prevMessageCount ..] is what was appended in
  // the gap. "Transcript" = Anthropic's `messages` / Responses' `input`.
  prevMessageCount: number
  // Per-iter agent type. Optional for back-compat; missing = claude-code.
  agentType?: AgentType
}

// One local tool execution that happened between two API calls. Pairs an
// LLM-emitted `tool_use` (iter N response) with the matching `tool_result`
// (iter N+1 request). Server-side reconstruction lives in
// `server/aggregate.ts#computeActionSegments`.
export interface ActionEntry {
  toolUseId: string
  name: string
  input: unknown
  resultPreview?: string
  resultChars?: number
  resultTruncated?: boolean
  isError: boolean
  unmatched?: boolean
  hasImage?: boolean
  hasToolHydration?: boolean
}

export interface ActionSegment {
  fromInteractionId: string
  toInteractionId?: string
  durationMs?: number
  pending?: boolean
  actions: ActionEntry[]
}

export interface MessageWithInteractions extends CapturedMessage {
  interactions: InteractionStub[]
  stopReason: StopReason
  // One segment per gap where the model called tools. Keyed off
  // `fromInteractionId` — the client interleaves a segment after each
  // matching interaction card.
  actionSegments: ActionSegment[]
}

export interface ProjectDetail {
  project?: CapturedProject
  messages: MessageWithInteractions[]
}

// `request`/`response`/`sseEvents` are polymorphic over `agentType`.
// We keep them widened on this client type and let renderers narrow.
// Pre-0.2 records (no `agentType`) are by definition Anthropic-shaped.
export type InteractionFull = CapturedInteraction & {
  request: AnthropicRequest | unknown
  response?: AnthropicResponse | unknown
  sseEvents?: SseEvent[] | unknown[]
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${r.status} ${r.statusText}: ${text}`)
  }
  return (await r.json()) as T
}

export const api = {
  listProjects: () => getJson<ProjectListItem[]>('/api/projects'),
  getProject: (id: string) => getJson<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  getInteraction: (pid: string, iid: string) =>
    getJson<InteractionFull>(
      `/api/projects/${encodeURIComponent(pid)}/interactions/${encodeURIComponent(iid)}`,
    ),
}

// Snapshot of an in-flight interaction. Mirrors the server-side
// LiveSnapshot shape; arrives via `live-update` events on the shared
// /api/events channel. Polymorphic over `agentType` — UI narrows.
export interface LiveSnapshot {
  response?: AnthropicResponse | unknown
  done: boolean
  error?: { message: string; status?: number }
}

// ── Shared /api/events multiplexer ──────────────────────────────────────
//
// Every browser tab used to open one EventSource per `subscribeEvents`
// caller AND one per open in-flight InteractionCard (the `/live`
// endpoint). With three components each calling `subscribeEvents` and
// any non-trivial project having several streaming iters, a single tab
// would hold 6+ SSE connections at once — pinning Chrome's HTTP/1.1
// per-origin cap and queueing normal fetches behind them.
//
// The server now multiplexes capture + live-snapshot + live-done over
// `/api/events`. We mirror that here: ONE EventSource per tab, lazily
// created on first subscription. Component-level `subscribeEvents` /
// `subscribeLive` calls register filtering listeners on top.

export interface CaptureEvent {
  kind: 'project' | 'message' | 'interaction'
  projectId: string
  id: string
}

type LiveUpdatePayload = { iid: string; pid: string; snapshot: LiveSnapshot }
type LiveDonePayload = { iid: string; pid: string }

let sharedSource: EventSource | null = null
const captureListeners = new Set<(e: CaptureEvent) => void>()
const liveUpdateListenersByIid = new Map<string, Set<(snap: LiveSnapshot) => void>>()
const liveDoneListenersByIid = new Map<string, Set<() => void>>()

function ensureSharedSource(): EventSource {
  if (sharedSource) return sharedSource
  const es = new EventSource('/api/events')
  es.addEventListener('capture', (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data) as CaptureEvent
      for (const cb of captureListeners) {
        try { cb(payload) } catch {}
      }
    } catch {}
  })
  es.addEventListener('live-update', (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data) as LiveUpdatePayload
      const set = liveUpdateListenersByIid.get(payload.iid)
      if (!set) return
      for (const cb of set) {
        try { cb(payload.snapshot) } catch {}
      }
    } catch {}
  })
  es.addEventListener('live-done', (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data) as LiveDonePayload
      const set = liveDoneListenersByIid.get(payload.iid)
      if (!set) return
      // Snapshot the set first — listeners typically unsubscribe
      // themselves on `done`, which would otherwise mutate while we're
      // iterating.
      for (const cb of Array.from(set)) {
        try { cb() } catch {}
      }
    } catch {}
  })
  // EventSource auto-reconnects on transport errors with its own
  // exponential-ish backoff. We don't tear down on error: a momentary
  // hiccup would otherwise orphan every component subscription. The
  // server side is idempotent — we just resume getting events.
  sharedSource = es
  return es
}

// Subscribe to capture (project/message/interaction created) events.
// Returns an unsubscribe function. Safe to call multiple times.
export function subscribeEvents(cb: (e: CaptureEvent) => void) {
  ensureSharedSource()
  captureListeners.add(cb)
  return () => {
    captureListeners.delete(cb)
  }
}

// Subscribe to live-snapshot updates for one in-flight interaction.
// `onSnapshot` may fire many times per second; `onDone` fires once
// when the upstream stream ends — the caller should then refetch the
// persisted record for the authoritative final shape. The returned
// cleanup is idempotent.
export function subscribeLive(
  _pid: string,
  iid: string,
  onSnapshot: (snap: LiveSnapshot) => void,
  onDone?: () => void,
): () => void {
  ensureSharedSource()
  let closed = false

  const updates = liveUpdateListenersByIid.get(iid) ?? new Set()
  if (!liveUpdateListenersByIid.has(iid)) liveUpdateListenersByIid.set(iid, updates)
  updates.add(onSnapshot)

  const doneHandler = () => {
    if (closed) return
    onDone?.()
    close()
  }
  const dones = liveDoneListenersByIid.get(iid) ?? new Set()
  if (!liveDoneListenersByIid.has(iid)) liveDoneListenersByIid.set(iid, dones)
  dones.add(doneHandler)

  const close = () => {
    if (closed) return
    closed = true
    updates.delete(onSnapshot)
    if (updates.size === 0) liveUpdateListenersByIid.delete(iid)
    dones.delete(doneHandler)
    if (dones.size === 0) liveDoneListenersByIid.delete(iid)
  }
  return close
}
