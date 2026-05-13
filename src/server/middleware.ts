// Connect-style middleware mounted into vite's dev/preview server.
// Handles:
//   POST /v1/messages          → proxy to api.anthropic.com (+ capture to JSONL)
//   GET  /api/sessions         → session list
//   GET  /api/sessions/:id     → session detail (messages + interaction stubs)
//   GET  /api/sessions/:id/interactions/:iid → full interaction record
//   GET  /api/events           → SSE multiplexer:
//                                  `capture`     — session/message/interaction created
//                                  `live-update` — throttled partial-response snapshot for an iid
//                                  `live-done`   — terminal event for an iid
//
// Everything that used to need its own SSE connection — both the
// per-tab capture stream AND the per-card live tail — goes over this
// single endpoint now, so each browser tab consumes exactly one
// long-lived connection out of Chrome's 6-per-origin HTTP/1.1 pool.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { Storage } from './storage'
import { Grouper } from './grouping'
import { createMessagesProxy } from './proxy'
import { aggregateMessages, isMainInteraction } from './aggregate'
import { LiveRegistry, type LiveUpdateEvent, type LiveDoneEvent } from './liveRegistry'
import type { CapturedInteraction } from '../lib/anthropic-types'

// Singletons — middleware lives for the lifetime of the dev server.
const storage = new Storage()
const grouper = new Grouper()
const liveRegistry = new LiveRegistry()
const events = new EventEmitter()
events.setMaxListeners(0)

const proxy = createMessagesProxy({
  storage,
  grouper,
  liveRegistry,
  onEvent: (e) => events.emit('event', e),
})

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse) {
  sendJson(res, 404, { error: 'not_found' })
}

// Build the API list response: a flat array of session summaries.
function listSessions() {
  const rows = storage.listSessions()
  return rows.map(({ sessionId, mtime, size }) => {
    const { session, messages, interactions } = storage.loadSession(sessionId)
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    // Only main-agent interactions feed the summary. Helper haiku side-calls
    // (topic classifier, post-processing) are framework noise; tokens spent
    // on them are real but irrelevant to "what did the agent do".
    const modelOutputTokens = new Map<string, number>()
    let mainCount = 0
    let lastMain: CapturedInteraction | undefined
    for (const it of interactions) {
      if (!isMainInteraction(it)) continue
      mainCount++
      lastMain = it
      const u = it.response?.usage
      if (u) {
        totalInput += u.input_tokens ?? 0
        totalOutput += u.output_tokens ?? 0
        totalCacheRead += u.cache_read_input_tokens ?? 0
        totalCacheWrite += u.cache_creation_input_tokens ?? 0
      }
      const m = it.request?.model
      if (m) {
        modelOutputTokens.set(
          m,
          (modelOutputTokens.get(m) ?? 0) + (u?.output_tokens ?? 0),
        )
      }
    }
    const cwd = resolveSessionCwd(session, interactions)
    let primaryModel = session?.firstSeenModel
    let max = -1
    for (const [m, c] of modelOutputTokens) {
      if (c > max) {
        max = c
        primaryModel = m
      }
    }
    const aggregatedMessages = aggregateMessages(messages, interactions, countToolUseBlocks)
    return {
      sessionId,
      startedAt: session?.startedAt,
      cwd,
      model: primaryModel,
      mtime,
      sizeBytes: size,
      messageCount: aggregatedMessages.length,
      interactionCount: mainCount,
      tokens: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
      isLive: Date.now() - mtime < 30_000,
      lastInteractionAt: lastMain?.endedAt ?? lastMain?.startedAt,
    }
  })
}

function extractCwdFromRequest(req: { system?: unknown } | undefined): string | undefined {
  if (!req) return undefined
  const sys = (req as any).system
  let text = ''
  if (typeof sys === 'string') text = sys
  else if (Array.isArray(sys)) {
    for (const b of sys) {
      const t = (b as any).text
      if (typeof t === 'string') text += t + '\n'
    }
  }
  if (!text) return undefined
  const m = text.match(/(?:cwd|working[_ ]?directory)\s*[:=]\s*([^\n]+)/i)
  return m?.[1]?.trim() || undefined
}

// Best-effort cwd resolution for a stored session. JSONL is append-only
// and the very first request that opens a session sometimes lacks a cwd
// in its system prompt (typical for haiku title-gen helpers), so the
// persisted `session.cwd` can be undefined even though later
// interactions in the same session clearly carry one. Falling back to a
// scan keeps every UI surface (list / detail) showing the same value.
function resolveSessionCwd(
  session: { cwd?: string } | undefined,
  interactions: CapturedInteraction[],
): string | undefined {
  if (session?.cwd) return session.cwd
  for (const it of interactions) {
    const cwd = extractCwdFromRequest(it.request)
    if (cwd) return cwd
  }
  return undefined
}

function getSessionDetail(sessionId: string) {
  const { session, messages, interactions } = storage.loadSession(sessionId)
  if (!session && !messages.length && !interactions.length) return null
  // Aggregate: fold haiku helper calls into the surrounding main agent message
  // so the UI shows one message per user-typed prompt, not one per HTTP round-trip.
  const aggregated = aggregateMessages(messages, interactions, countToolUseBlocks)
  const cwd = resolveSessionCwd(session, interactions)
  return {
    session: session ? { ...session, cwd } : session,
    messages: aggregated,
  }
}

function countToolUseBlocks(it: CapturedInteraction): number {
  const blocks = it.response?.content ?? []
  let n = 0
  for (const b of blocks) if (b.type === 'tool_use') n++
  return n
}

function getInteraction(sessionId: string, interactionId: string) {
  const { interactions } = storage.loadSession(sessionId)
  const it = interactions.find((i) => i.interactionId === interactionId)
  if (!it) return null
  // While the interaction is still streaming the JSONL only has the
  // partial (request-only) record, but the LiveRegistry holds the
  // accumulated response so far. Splice it in here so a tab opening
  // the card mid-stream sees whatever has already been emitted, instead
  // of waiting until the next throttled `live-update` tick on the
  // shared SSE channel for its first paint.
  if (!it.endedAt) {
    const live = liveRegistry.get(interactionId)
    if (live) {
      const snap = live.snapshot()
      if (snap.response) return { ...it, response: snap.response }
    }
  }
  return it
}

const VERBOSE = process.env.AGENTMIND_VERBOSE !== '0'

function logReq(method: string, urlPath: string, extra?: string) {
  if (!VERBOSE) return
  const ts = new Date().toISOString().slice(11, 23)
  // eslint-disable-next-line no-console
  console.log(`[proxy ${ts}] ${method} ${urlPath}${extra ? ' ' + extra : ''}`)
}

export function createCaptureMiddleware() {
  return async function middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next?: () => void,
  ): Promise<void> {
    const urlPath = (req.url ?? '').split('?')[0]

    // Log every /v1/* and /api/* hit so misrouted claude requests are visible.
    if (urlPath.startsWith('/v1/') || urlPath.startsWith('/api/')) {
      logReq(req.method ?? '?', urlPath)
    }

    // Proxy endpoint.
    if (urlPath === '/v1/messages') {
      try {
        await proxy(req, res)
      } catch (e: any) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal', message: String(e?.message ?? e) })
        } else {
          try {
            res.end()
          } catch {}
        }
      }
      return
    }

    // Data API. All others fall through to vite/start.
    if (!urlPath.startsWith('/api/')) {
      next?.()
      return
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    // /api/events — SSE multiplexer (see header comment).
    if (urlPath === '/api/events') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')
      res.flushHeaders?.()

      const safeWrite = (chunk: string) => {
        try {
          res.write(chunk)
        } catch {
          // Connection already closed by the client / runtime — the
          // `close` cleanup below will detach listeners; ignore here.
        }
      }
      const onCapture = (e: any) => {
        safeWrite(`event: capture\ndata: ${JSON.stringify(e)}\n\n`)
      }
      const onLiveUpdate = (e: LiveUpdateEvent) => {
        safeWrite(`event: live-update\ndata: ${JSON.stringify(e)}\n\n`)
      }
      const onLiveDone = (e: LiveDoneEvent) => {
        safeWrite(`event: live-done\ndata: ${JSON.stringify(e)}\n\n`)
      }
      events.on('event', onCapture)
      liveRegistry.on('live-update', onLiveUpdate)
      liveRegistry.on('live-done', onLiveDone)
      const heartbeat = setInterval(() => safeWrite(':keep-alive\n\n'), 15_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        events.off('event', onCapture)
        liveRegistry.off('live-update', onLiveUpdate)
        liveRegistry.off('live-done', onLiveDone)
      })
      return
    }

    // /api/sessions
    if (urlPath === '/api/sessions') {
      sendJson(res, 200, listSessions())
      return
    }

    // /api/sessions/:id
    const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1])
      const detail = getSessionDetail(id)
      if (!detail) return notFound(res)
      sendJson(res, 200, detail)
      return
    }

    // /api/sessions/:id/interactions/:iid
    const interactionMatch = urlPath.match(
      /^\/api\/sessions\/([^/]+)\/interactions\/([^/]+)$/,
    )
    if (interactionMatch) {
      const id = decodeURIComponent(interactionMatch[1])
      const iid = decodeURIComponent(interactionMatch[2])
      const it = getInteraction(id, iid)
      if (!it) return notFound(res)
      sendJson(res, 200, it)
      return
    }

    notFound(res)
  }
}
