// Connect-style middleware mounted into vite's dev/preview server.
// Handles:
//   POST /v1/messages          → proxy to api.anthropic.com (+ capture to JSONL)
//   POST /v1/responses         → proxy to api.openai.com    (+ capture to JSONL)
//   GET  /api/projects         → project list
//   GET  /api/projects/:id     → project detail (messages + interaction stubs)
//   GET  /api/projects/:id/interactions/:iid → full interaction record
//   GET  /api/events           → SSE multiplexer:
//                                  `capture`     — project/message/interaction created
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
import { createProtocolProxy } from './proxy'
import { adapters, adapterForPath } from './adapters'
import { aggregateMessages, isMainInteraction } from './aggregate'
import { LiveRegistry, type LiveUpdateEvent, type LiveDoneEvent } from './liveRegistry'
import {
  agentTypeOf,
  countToolUses,
  modelOf,
  normaliseRequestForGrouping,
  usageOf,
} from './interaction-view'
import type { AgentType, CapturedInteraction, MessageParam } from '../lib/anthropic-types'

// Singletons — middleware lives for the lifetime of the dev server.
const storage = new Storage()
const grouper = new Grouper({
  // Lazy-hydrate from disk on first sight of a cwd so message indices
  // keep increasing across proxy restarts. Without this hook, restarting
  // mid-project would start indices from 0 and confuse the UI.
  hydrate: (cwd) => hydrateProject(cwd),
})
const liveRegistry = new LiveRegistry()
const events = new EventEmitter()
events.setMaxListeners(0)

// One proxy handler per protocol adapter. The handlers share the same
// Grouper / Storage / LiveRegistry so different protocols' requests for
// the same cwd land in the same project.
const protocolProxies = new Map<string, ReturnType<typeof createProtocolProxy>>()
for (const adapter of adapters) {
  protocolProxies.set(
    adapter.endpointPath,
    createProtocolProxy(adapter, {
      storage,
      grouper,
      liveRegistry,
      onEvent: (e) => events.emit('event', e),
    }),
  )
}

// Re-build enough of a project's message-chain state for the Grouper to
// extend it without resetting indices. The Storage doesn't know about
// adapters, so the per-protocol "normalise messages for grouping" step
// lives here.
function hydrateProject(cwd: string) {
  const { projectIdForCwd } = require('./projectId') as typeof import('./projectId')
  const projectId = projectIdForCwd(cwd)
  const { project, messages, interactions } = storage.loadProject(projectId)
  if (!messages.length && !interactions.length) return undefined
  const byMessage = new Map<string, CapturedInteraction[]>()
  for (const it of interactions) {
    const arr = byMessage.get(it.messageId) ?? []
    arr.push(it)
    byMessage.set(it.messageId, arr)
  }
  const out = messages.map((m) => {
    const its = (byMessage.get(m.messageId) ?? []).sort((a, b) => a.index - b.index)
    const last = its[its.length - 1]
    const lastMessages: MessageParam[] = last ? normaliseRequestForGrouping(last) : []
    let userPromptCount = 0
    for (const mp of lastMessages) {
      if (mp.role === 'user') {
        if (typeof mp.content === 'string') {
          if (mp.content.trim()) userPromptCount++
        } else {
          const hasToolResult = mp.content.some((b: any) => b.type === 'tool_result')
          if (!hasToolResult) userPromptCount++
        }
      }
    }
    return {
      messageId: m.messageId,
      index: m.index,
      lastMessages,
      userPromptCount,
      interactionCount: its.length,
    }
  })
  const primaryAgent: AgentType = project?.primaryAgent ?? 'claude-code'
  return { cwd, primaryAgent, messages: out }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse) {
  sendJson(res, 404, { error: 'not_found' })
}

// Build the API list response: a flat array of project summaries.
function listProjects() {
  const rows = storage.listProjects()
  return rows.map(({ projectId, mtime, size }) => {
    const { project, messages, interactions } = storage.loadProject(projectId)
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    // Only main-agent interactions feed the summary. Helper side-calls
    // (Claude Code's haiku topic classifier; Codex CLI's compaction
    // summariser) are framework noise; tokens spent on them are real
    // but irrelevant to "what did the agent do".
    const modelOutputTokens = new Map<string, number>()
    let mainCount = 0
    let lastMain: CapturedInteraction | undefined
    const agentTallies = new Map<AgentType, number>()
    for (const it of interactions) {
      const a = agentTypeOf(it)
      agentTallies.set(a, (agentTallies.get(a) ?? 0) + 1)
      if (!isMainInteraction(it)) continue
      mainCount++
      lastMain = it
      const u = usageOf(it)
      if (u) {
        totalInput += u.input_tokens ?? 0
        totalOutput += u.output_tokens ?? 0
        totalCacheRead += u.cache_read_input_tokens ?? 0
        totalCacheWrite += u.cache_creation_input_tokens ?? 0
      }
      const m = modelOf(it)
      if (m) {
        modelOutputTokens.set(
          m,
          (modelOutputTokens.get(m) ?? 0) + (u?.output_tokens ?? 0),
        )
      }
    }
    const cwd = resolveProjectCwd(project, interactions)
    let primaryModel = project?.firstSeenModel
    let max = -1
    for (const [m, c] of modelOutputTokens) {
      if (c > max) {
        max = c
        primaryModel = m
      }
    }
    // Prefer the persisted primaryAgent (stamped at project creation);
    // fall back to whichever agent contributed the most interactions in
    // case we're looking at a pre-0.2 file that lacks the field.
    let primaryAgent: AgentType | undefined = project?.primaryAgent
    if (!primaryAgent) {
      let agentMax = -1
      for (const [a, c] of agentTallies) {
        if (c > agentMax) {
          agentMax = c
          primaryAgent = a
        }
      }
      primaryAgent = primaryAgent ?? 'claude-code'
    }
    const aggregatedMessages = aggregateMessages(messages, interactions, countToolUses)
    return {
      projectId,
      startedAt: project?.startedAt,
      cwd,
      model: primaryModel,
      agentType: primaryAgent,
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

// Best-effort cwd resolution for a stored project. The very first
// request that opens a project sometimes lacks a cwd in its system
// prompt (typical for Claude Code's haiku title-gen helpers), so the
// persisted `project.cwd` can be undefined even though later
// interactions in the same project clearly carry one. Falling back to
// a per-protocol scan keeps every UI surface (list / detail) showing
// the same value.
function resolveProjectCwd(
  project: { cwd?: string } | undefined,
  interactions: CapturedInteraction[],
): string | undefined {
  if (project?.cwd) return project.cwd
  for (const it of interactions) {
    const adapter = adapters.find((a) => a.agentType === agentTypeOf(it))
    const cwd = adapter?.extractCwd(it.request)
    if (cwd) return cwd
  }
  return undefined
}

function getProjectDetail(projectId: string) {
  const { project, messages, interactions } = storage.loadProject(projectId)
  if (!project && !messages.length && !interactions.length) return null
  // Aggregate: fold helper calls into the surrounding main-agent message
  // so the UI shows one message per user-typed prompt, not one per HTTP
  // round-trip.
  const aggregated = aggregateMessages(messages, interactions, countToolUses)
  const cwd = resolveProjectCwd(project, interactions)
  return {
    project: project ? { ...project, cwd } : project,
    messages: aggregated,
  }
}

function getInteraction(projectId: string, interactionId: string) {
  const { interactions } = storage.loadProject(projectId)
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

    // Log every /v1/* and /api/* hit so misrouted agent requests are visible.
    if (urlPath.startsWith('/v1/') || urlPath.startsWith('/api/')) {
      logReq(req.method ?? '?', urlPath)
    }

    // Proxy endpoints — one per protocol adapter.
    //
    // WebSocket upgrade attempts (Codex CLI defaults to WS for the Responses
    // API) never reach this handler — Node routes them to the http.Server's
    // `upgrade` event instead. See prod-entry.ts for the WS-refusal handler;
    // it tells Codex users how to disable WS in their config.
    const protocolProxy = protocolProxies.get(urlPath)
    if (protocolProxy && adapterForPath(urlPath)) {
      try {
        await protocolProxy(req, res)
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

    // Anything that came in on POST /v1/* but didn't match a known adapter
    // is almost certainly a typo or a path the agent uses that we don't
    // know about yet (e.g. /v1/responses?xyz, /v1/chat/completions). Log a
    // clearer warning so the user can see WHY their traffic isn't being
    // captured.
    if (urlPath.startsWith('/v1/') && req.method === 'POST') {
      const ts = new Date().toISOString().slice(11, 23)
      // eslint-disable-next-line no-console
      console.warn(
        `[proxy ${ts}] POST ${urlPath} — no adapter for this path. ` +
          `Known: ${adapters.map((a) => a.endpointPath).join(', ')}`,
      )
      sendJson(res, 404, {
        error: 'no_protocol_adapter',
        message: `No AgentMind adapter for path ${urlPath}. Known: ${adapters
          .map((a) => a.endpointPath)
          .join(', ')}`,
      })
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

    // /api/projects
    if (urlPath === '/api/projects') {
      sendJson(res, 200, listProjects())
      return
    }

    // /api/projects/:id
    const projectMatch = urlPath.match(/^\/api\/projects\/([^/]+)$/)
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1])
      const detail = getProjectDetail(id)
      if (!detail) return notFound(res)
      sendJson(res, 200, detail)
      return
    }

    // /api/projects/:id/interactions/:iid
    const interactionMatch = urlPath.match(
      /^\/api\/projects\/([^/]+)\/interactions\/([^/]+)$/,
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
