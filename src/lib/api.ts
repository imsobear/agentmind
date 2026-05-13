// Typed fetch wrappers around /api/*. Mirror the response shapes built in
// src/server/middleware.ts. Keep them additive — the server is authoritative.

import type {
  AnthropicRequest,
  AnthropicResponse,
  CapturedInteraction,
  CapturedMessage,
  CapturedSession,
  SseEvent,
  StopReason,
  Usage,
} from './anthropic-types'

export interface SessionListItem {
  sessionId: string
  startedAt?: string
  cwd?: string
  model?: string
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
  stopReason: StopReason
  usage?: Usage
  hasError: boolean
  // Messages this iter inherited verbatim from the previous main-agent
  // iter — request.messages[0 .. prevMessageCount-1] are the cached prefix,
  // request.messages[prevMessageCount ..] is what was appended in the gap.
  prevMessageCount: number
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

export interface SessionDetail {
  session?: CapturedSession
  messages: MessageWithInteractions[]
}

export type InteractionFull = CapturedInteraction & {
  request: AnthropicRequest
  response?: AnthropicResponse
  sseEvents?: SseEvent[]
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
  listSessions: () => getJson<SessionListItem[]>('/api/sessions'),
  getSession: (id: string) => getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  getInteraction: (sid: string, iid: string) =>
    getJson<InteractionFull>(
      `/api/sessions/${encodeURIComponent(sid)}/interactions/${encodeURIComponent(iid)}`,
    ),
}

// Convenience for SSE event subscription.
export function subscribeEvents(cb: (e: { kind: string; sessionId: string; id: string }) => void) {
  const es = new EventSource('/api/events')
  es.addEventListener('capture', (ev) => {
    try {
      cb(JSON.parse((ev as MessageEvent).data))
    } catch {}
  })
  return () => es.close()
}

// Snapshot of an in-flight interaction. Mirrors the server-side
// LiveSnapshot shape; sent on every throttled tick over the
// /api/sessions/:sid/interactions/:iid/live SSE endpoint.
export interface LiveSnapshot {
  response?: AnthropicResponse
  done: boolean
  error?: { message: string; status?: number }
}

// Tail snapshots for an in-flight interaction. The server emits one
// `snapshot` per ~150ms while the stream is live, plus a terminal
// `done` event when it ends — at which point the caller should drop
// the subscription and refetch the persisted record. The cleanup
// function returned here is safe to call multiple times.
export function subscribeLive(
  sid: string,
  iid: string,
  onSnapshot: (snap: LiveSnapshot) => void,
  onDone?: () => void,
): () => void {
  const url = `/api/sessions/${encodeURIComponent(sid)}/interactions/${encodeURIComponent(iid)}/live`
  const es = new EventSource(url)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      es.close()
    } catch {}
  }
  es.addEventListener('snapshot', (ev) => {
    if (closed) return
    try {
      onSnapshot(JSON.parse((ev as MessageEvent).data) as LiveSnapshot)
    } catch {}
  })
  es.addEventListener('done', () => {
    if (closed) return
    onDone?.()
    close()
  })
  // EventSource will reconnect on transport errors by default; we
  // don't want runaway retries against a stale endpoint, so we close
  // on the first hard error.
  es.addEventListener('error', () => {
    close()
  })
  return close
}
