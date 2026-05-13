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
// flight we keep an SseAccumulator alive here and notify subscribers
// via an EventEmitter as new chunks arrive. The middleware exposes
// this through `/api/sessions/:sid/interactions/:iid/live`. Once the
// upstream finishes (success or error) we mark the session done; the
// HTTP layer flushes a final snapshot + `done` event and clients fall
// back to the canonical persisted record.

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

  constructor() {
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

export class LiveRegistry {
  private sessions = new Map<string, LiveSession>()

  create(interactionId: string): LiveSession {
    // `create` is idempotent only insofar as the caller wouldn't reuse
    // an interactionId — they're freshly minted UUIDs in proxy.ts so we
    // assume no collisions and overwrite if one ever exists.
    const s = new LiveSession()
    this.sessions.set(interactionId, s)
    return s
  }

  get(interactionId: string): LiveSession | undefined {
    return this.sessions.get(interactionId)
  }

  remove(interactionId: string) {
    this.sessions.delete(interactionId)
  }
}
