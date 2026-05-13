// In-memory registry of *currently streaming* interactions.
//
// JSONL on disk is intentionally append-only and only gets two writes
// per interaction (partial record at start, finalised record at end).
// That gives us crash-recoverability but means everything that happens
// during the SSE stream — content blocks arriving, tool_use args
// growing, tokens piling up — is invisible to the UI until the upstream
// closes.
//
// The LiveRegistry is the parallel hot-path: while a stream is in
// flight we keep an SseAccumulator alive here and re-emit two
// throttled events back to whatever is listening at the registry
// level:
//
//   - `live-update {iid, sid, snapshot}`  (≤ once per 150ms per iid)
//   - `live-done   {iid, sid}`            (terminal — fires once)
//
// `middleware.ts` subscribes to *those* registry events and multiplexes
// them out over the shared `/api/events` SSE so every tab needs only
// ONE long-lived connection regardless of how many in-flight cards it
// has open. Without this multiplexing the browser quickly burned
// through Chrome's per-origin HTTP/1.1 cap (6) and choked normal
// fetches.

import { EventEmitter } from 'node:events'
import { SseAccumulator } from './sse'
import type { AnthropicResponse } from '../lib/anthropic-types'

export interface LiveSnapshot {
  // The AnthropicResponse-shaped object assembled so far by the
  // SseAccumulator. Undefined until `message_start` arrives.
  response?: AnthropicResponse
  // True once the upstream stream completed (cleanly or via error) and
  // no further updates will arrive. After this fires once, the client
  // should drop the live subscription and refetch the persisted
  // interaction record for the authoritative final state.
  done: boolean
  error?: { message: string; status?: number }
}

export class LiveSession {
  readonly accumulator: SseAccumulator
  readonly emitter: EventEmitter
  done = false
  error?: { message: string; status?: number }
  // The project (cwd-keyed group) this interaction belongs to. We need
  // it so registry-level emits can carry it without consumers having
  // to keep a separate iid → projectId map.
  readonly projectId: string

  constructor(projectId: string) {
    this.projectId = projectId
    this.accumulator = new SseAccumulator()
    this.emitter = new EventEmitter()
    // Multiple browser tabs may subscribe to the same in-flight
    // interaction; lift the default listener cap so we don't trigger
    // Node's "possible memory leak" warning at 10 listeners.
    this.emitter.setMaxListeners(0)
  }

  feed(chunk: string) {
    this.accumulator.feed(chunk)
    this.emitter.emit('update')
  }

  finish(error?: { message: string; status?: number }) {
    this.accumulator.flush()
    this.done = true
    if (error) this.error = error
    // emit `update` first so subscribers throttling snapshots will
    // include this terminal state in their next flush; then `done` so
    // the HTTP layer can close the SSE connection.
    this.emitter.emit('update')
    this.emitter.emit('done')
  }

  snapshot(): LiveSnapshot {
    return {
      response: this.accumulator.getResponse(),
      done: this.done,
      error: this.error,
    }
  }
}

export interface LiveUpdateEvent {
  iid: string
  pid: string
  snapshot: LiveSnapshot
}

export interface LiveDoneEvent {
  iid: string
  pid: string
}

// Per-iid throttle window. 150ms is the same value we used in the
// dedicated /live endpoint before the multiplex refactor — fast
// enough to feel real-time, slow enough that the browser doesn't
// drown in JSON parsing during heavy text deltas.
const THROTTLE_MS = 150

export class LiveRegistry extends EventEmitter {
  private sessions = new Map<string, LiveSession>()
  private throttleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastEmitted = new Map<string, number>()

  constructor() {
    super()
    // Many subscribers can listen at once (one per /api/events
    // connection — i.e. one per browser tab).
    this.setMaxListeners(0)
  }

  create(interactionId: string, projectId: string): LiveSession {
    // `create` is idempotent only insofar as the caller wouldn't reuse
    // an interactionId — they're freshly minted UUIDs in proxy.ts so we
    // assume no collisions and overwrite if one ever exists.
    const session = new LiveSession(projectId)
    this.sessions.set(interactionId, session)

    session.emitter.on('update', () => this.scheduleEmit(interactionId))
    session.emitter.on('done', () => this.handleDone(interactionId))

    return session
  }

  get(interactionId: string): LiveSession | undefined {
    return this.sessions.get(interactionId)
  }

  remove(interactionId: string) {
    const t = this.throttleTimers.get(interactionId)
    if (t) {
      clearTimeout(t)
      this.throttleTimers.delete(interactionId)
    }
    this.lastEmitted.delete(interactionId)
    this.sessions.delete(interactionId)
  }

  private scheduleEmit(iid: string) {
    if (this.throttleTimers.has(iid)) return
    const now = Date.now()
    const last = this.lastEmitted.get(iid) ?? 0
    const wait = Math.max(0, THROTTLE_MS - (now - last))
    const timer = setTimeout(() => {
      this.throttleTimers.delete(iid)
      this.lastEmitted.set(iid, Date.now())
      this.emitUpdate(iid)
    }, wait)
    this.throttleTimers.set(iid, timer)
  }

  private handleDone(iid: string) {
    // Flush any pending throttled update so the terminal snapshot
    // always reaches subscribers before the `done` event.
    const t = this.throttleTimers.get(iid)
    if (t) {
      clearTimeout(t)
      this.throttleTimers.delete(iid)
    }
    this.lastEmitted.set(iid, Date.now())
    this.emitUpdate(iid)
    const live = this.sessions.get(iid)
    if (!live) return
    const ev: LiveDoneEvent = { iid, pid: live.projectId }
    this.emit('live-done', ev)
  }

  private emitUpdate(iid: string) {
    const live = this.sessions.get(iid)
    if (!live) return
    const ev: LiveUpdateEvent = {
      iid,
      pid: live.projectId,
      snapshot: live.snapshot(),
    }
    this.emit('live-update', ev)
  }
}
