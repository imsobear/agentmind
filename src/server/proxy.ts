// HTTP proxy for upstream LLM agent APIs.
//
// One proxy handler per protocol adapter (see `adapters.ts`). The handler
// is structurally identical across protocols — the only protocol-specific
// surface lives behind the Adapter interface. To add a new protocol you
// write an Adapter; you do not touch this file.
//
// Currently mounted:
//   POST /v1/messages    → Anthropic Messages API (Claude Code)
//   POST /v1/responses   → OpenAI Responses API   (Codex CLI)

import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as undiciRequest } from 'undici'
import { Storage, newId } from './storage'
import { Grouper } from './grouping'
import { LiveRegistry } from './liveRegistry'
import type { ProtocolAdapter } from './adapters'

const PROXY_VERSION = '0.2.0'

// Per-adapter upstream base URL. Order of precedence:
//   1. agent-specific env override (AGENTMIND_UPSTREAM_<AGENT>)
//   2. legacy AGENTMIND_UPSTREAM (Anthropic only, kept for back-compat)
//   3. hardcoded default
function upstreamBase(adapter: ProtocolAdapter): string {
  if (adapter.agentType === 'claude-code') {
    return (
      process.env.AGENTMIND_UPSTREAM_ANTHROPIC ||
      process.env.AGENTMIND_UPSTREAM ||
      'https://api.anthropic.com'
    )
  }
  if (adapter.agentType === 'codex-cli') {
    return process.env.AGENTMIND_UPSTREAM_OPENAI || 'https://api.openai.com'
  }
  return 'https://api.anthropic.com'
}

// Headers we forward as-is to upstream. Deliberately NOT forwarded:
//   • host / connection / content-length → recomputed by undici
//   • accept-encoding → we want plaintext from upstream so our SSE tee can
//     pass bytes straight through to the agent.
//
// Union of headers both Anthropic and OpenAI clients send. We're permissive
// — anything not on this list never reaches upstream, which is fine for
// the headers that exist purely to drive the local CLI's behavior.
const FORWARD_HEADERS = new Set([
  // Anthropic
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  // OpenAI
  'openai-organization',
  'openai-project',
  'openai-beta',
  // Shared
  'authorization',
  'content-type',
  'user-agent',
  'accept',
  // Codex CLI session/thread plumbing — pass through so backend
  // correlates retries / sub-requests.
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-openai-subagent',
  // x-stainless-* — Anthropic and OpenAI both use these for telemetry
  // disambiguation; forward verbatim so server-side metrics aren't
  // mis-attributed to "agentmind proxy".
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'x-app',
])

function pickForwardHeaders(incoming: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(incoming.headers)) {
    if (v == null) continue
    if (FORWARD_HEADERS.has(k.toLowerCase())) {
      out[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }
  }
  return out
}

function safeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key') {
      out[k] = redact(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function redact(v: string): string {
  if (!v) return v
  if (v.length <= 12) return '***'
  return v.slice(0, 8) + '…' + v.slice(-4)
}

export interface ProxyDeps {
  storage: Storage
  grouper: Grouper
  liveRegistry: LiveRegistry
  onEvent?: (e: { kind: 'project' | 'message' | 'interaction'; projectId: string; id: string }) => void
}

// Factory: returns one Node-style request handler per adapter. The shared
// dependencies (Grouper, Storage, LiveRegistry) get a single instance
// across all protocols; that's the whole point — both `/v1/messages` and
// `/v1/responses` for the same cwd land in the same project.
export function createProtocolProxy(adapter: ProtocolAdapter, deps: ProxyDeps) {
  const { storage, grouper, liveRegistry, onEvent } = deps

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'method_not_allowed' }))
      return
    }

    // 1. Read body.
    const bodyChunks: Buffer[] = []
    for await (const chunk of req) bodyChunks.push(chunk as Buffer)
    const bodyBuf = Buffer.concat(bodyChunks)

    const parsed = adapter.parseRequest(bodyBuf)
    if (parsed == null) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'invalid_json' }))
      return
    }

    const now = Date.now()
    const cwd = adapter.extractCwd(parsed)
    const resolution = grouper.resolve({
      messages: adapter.normaliseMessages(parsed),
      now,
      newId,
      cwd,
      agentType: adapter.agentType,
    })
    const interactionId = newId()
    const startedAtIso = new Date(now).toISOString()

    // 2. Persist project/message records if new.
    if (resolution.isNewProject) {
      storage.appendRecord(resolution.projectId, {
        type: 'project',
        projectId: resolution.projectId,
        startedAt: startedAtIso,
        firstSeenModel: adapter.extractModel(parsed),
        cwd: resolution.cwd,
        proxyVersion: PROXY_VERSION,
        primaryAgent: resolution.primaryAgent,
      })
      onEvent?.({ kind: 'project', projectId: resolution.projectId, id: resolution.projectId })
    }
    if (resolution.isNewMessage) {
      storage.appendRecord(resolution.projectId, {
        type: 'message',
        messageId: resolution.messageId,
        projectId: resolution.projectId,
        index: resolution.messageIndex,
        startedAt: startedAtIso,
        firstUserText: resolution.firstUserText,
      })
      onEvent?.({ kind: 'message', projectId: resolution.projectId, id: resolution.messageId })
    }

    const forwardHeaders = pickForwardHeaders(req)
    const safeHeaders = safeRequestHeaders(forwardHeaders)

    // 3. Persist a partial interaction record so the UI sees it immediately.
    storage.appendRecord(resolution.projectId, {
      type: 'interaction',
      interactionId,
      projectId: resolution.projectId,
      messageId: resolution.messageId,
      index: resolution.interactionIndex,
      startedAt: startedAtIso,
      agentType: adapter.agentType,
      request: parsed,
      requestHeaders: safeHeaders,
    })
    const live = liveRegistry.create(interactionId, resolution.projectId, adapter.createAccumulator())
    onEvent?.({ kind: 'interaction', projectId: resolution.projectId, id: interactionId })

    // 4. Forward upstream.
    let upstream
    try {
      const base = upstreamBase(adapter)
      const upstreamHost = new URL(base).host
      upstream = await undiciRequest(`${base}${adapter.endpointPath}`, {
        method: 'POST',
        headers: {
          ...forwardHeaders,
          host: upstreamHost,
          'accept-encoding': 'identity',
        },
        body: bodyBuf,
        bodyTimeout: 0,
        headersTimeout: 30_000,
      })
    } catch (e: any) {
      const errMsg = e?.message ?? String(e)
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'upstream_unreachable', message: errMsg }))
      live.finish({ message: errMsg })
      liveRegistry.remove(interactionId)
      storage.appendRecord(resolution.projectId, {
        type: 'interaction',
        interactionId,
        projectId: resolution.projectId,
        messageId: resolution.messageId,
        index: resolution.interactionIndex,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - now,
        agentType: adapter.agentType,
        request: parsed,
        requestHeaders: safeHeaders,
        error: { message: errMsg },
      })
      onEvent?.({ kind: 'interaction', projectId: resolution.projectId, id: interactionId })
      return
    }

    // 5. Mirror upstream headers / status to client.
    res.statusCode = upstream.statusCode
    const upstreamHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (v == null) continue
      const val = Array.isArray(v) ? v.join(', ') : String(v)
      upstreamHeaders[k] = val
      const lower = k.toLowerCase()
      if (lower === 'content-encoding' || lower === 'transfer-encoding' || lower === 'content-length') continue
      res.setHeader(k, val)
    }

    const isSse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
    const isStream = isStreamingRequest(parsed) || isSse

    if (isStream) {
      const acc = live.accumulator
      try {
        for await (const chunk of upstream.body) {
          const buf = chunk as Buffer
          const text = buf.toString('utf8')
          live.feed(text)
          res.write(buf)
        }
        acc.flush()
      } catch (e: any) {
        const errMsg = e?.message ?? String(e)
        live.finish({ message: errMsg, status: upstream.statusCode })
        liveRegistry.remove(interactionId)
        try { res.end() } catch {}
        storage.appendRecord(resolution.projectId, {
          type: 'interaction',
          interactionId,
          projectId: resolution.projectId,
          messageId: resolution.messageId,
          index: resolution.interactionIndex,
          startedAt: startedAtIso,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - now,
          agentType: adapter.agentType,
          request: parsed,
          requestHeaders: safeHeaders,
          responseHeaders: upstreamHeaders,
          sseEvents: acc.events,
          response: acc.getResponse(),
          error: { message: errMsg, status: upstream.statusCode },
        })
        onEvent?.({ kind: 'interaction', projectId: resolution.projectId, id: interactionId })
        return
      }
      live.finish()
      liveRegistry.remove(interactionId)
      try { res.end() } catch {}
      storage.appendRecord(resolution.projectId, {
        type: 'interaction',
        interactionId,
        projectId: resolution.projectId,
        messageId: resolution.messageId,
        index: resolution.interactionIndex,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - now,
        agentType: adapter.agentType,
        request: parsed,
        requestHeaders: safeHeaders,
        responseHeaders: upstreamHeaders,
        sseEvents: acc.events,
        response: acc.getResponse(),
      })
      onEvent?.({ kind: 'interaction', projectId: resolution.projectId, id: interactionId })
      return
    }

    // Non-streaming path.
    const respChunks: Buffer[] = []
    try {
      for await (const chunk of upstream.body) respChunks.push(chunk as Buffer)
    } catch (e: any) {
      live.finish({ message: e?.message ?? String(e), status: upstream.statusCode })
      liveRegistry.remove(interactionId)
      try { res.end() } catch {}
      storage.appendRecord(resolution.projectId, {
        type: 'interaction',
        interactionId,
        projectId: resolution.projectId,
        messageId: resolution.messageId,
        index: resolution.interactionIndex,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - now,
        agentType: adapter.agentType,
        request: parsed,
        requestHeaders: safeHeaders,
        responseHeaders: upstreamHeaders,
        error: { message: e?.message ?? String(e), status: upstream.statusCode },
      })
      onEvent?.({ kind: 'interaction', projectId: resolution.projectId, id: interactionId })
      return
    }
    live.finish()
    liveRegistry.remove(interactionId)
    const respBuf = Buffer.concat(respChunks)
    res.end(respBuf)

    let parsedResp: any
    try {
      parsedResp = JSON.parse(respBuf.toString('utf8'))
    } catch {
      parsedResp = undefined
    }
    storage.appendRecord(resolution.projectId, {
      type: 'interaction',
      interactionId,
      projectId: resolution.projectId,
      messageId: resolution.messageId,
      index: resolution.interactionIndex,
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - now,
      agentType: adapter.agentType,
      request: parsed,
      requestHeaders: safeHeaders,
      responseHeaders: upstreamHeaders,
      response: pickValidResponse(parsedResp, adapter.agentType),
      error: upstream.statusCode >= 400 ? { message: respBuf.toString('utf8').slice(0, 1024), status: upstream.statusCode } : undefined,
    })
    onEvent?.({ kind: 'interaction', projectId: resolution.projectId, id: interactionId })
  }
}

function isStreamingRequest(req: unknown): boolean {
  if (!req || typeof req !== 'object') return false
  const v = (req as { stream?: unknown }).stream
  return v === true
}

// Only persist a non-streaming response body when it looks shape-correct
// for the protocol. Garbage bodies (HTML error pages, partial reads)
// shouldn't end up under `response`.
function pickValidResponse(body: any, agent: 'claude-code' | 'codex-cli' | 'unknown'): unknown {
  if (!body || typeof body !== 'object') return undefined
  if (agent === 'claude-code') return body.type === 'message' ? body : undefined
  if (agent === 'codex-cli') return body.object === 'response' || typeof body.output !== 'undefined' ? body : undefined
  return undefined
}
