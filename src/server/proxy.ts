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

// Headers we explicitly DO NOT forward. Everything else passes through.
//
// Switched from allow-list to deny-list because chatgpt.com /
// backend-api/codex is more particular than api.openai.com — it
// expects whatever Codex CLI's default reqwest client sends
// (`originator`, residency, Cloudflare cookies, ...) and a tight
// allow-list silently drops headers that turn out to matter. Proxy
// duty is to relay; clients sending malformed/sensitive headers is
// their problem, not ours. We DO still redact `authorization` and
// `x-api-key` in the persisted record (see `safeRequestHeaders`).
const NON_FORWARDED_HEADERS = new Set([
  'host', // we recompute per upstream
  'connection',
  'content-length', // undici computes
  'accept-encoding', // want plaintext from upstream for SSE tee
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function pickForwardHeaders(incoming: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(incoming.headers)) {
    if (v == null) continue
    if (NON_FORWARDED_HEADERS.has(k.toLowerCase())) continue
    out[k] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return out
}

// Pick the upstream URL + Host header per request.
//
// Anthropic is uniform — there's just one endpoint regardless of auth
// flavor (api key vs OAuth via `claude login`), so a single base URL +
// adapter.endpointPath is enough.
//
// Codex CLI is bimodal:
//   - API-key auth     → `Authorization: Bearer sk-...`     → api.openai.com/v1/responses
//   - ChatGPT OAuth    → `Authorization: Bearer eyJ...`     → chatgpt.com/backend-api/codex/responses
// The Responses API schema is identical on both endpoints, only the
// host + path prefix change. We sniff the token shape on each request
// (it's stable: API keys are `sk-…`, OAuth access tokens are JWTs that
// start with `eyJ`) and route accordingly. Falls back to API-key
// behavior for unknown / missing tokens — keeps the existing smoke
// test (which sends no auth header) working unchanged.
//
// Both routes are env-overridable for local testing.
interface UpstreamTarget {
  url: string
  host: string
  isChatGptBackend: boolean
}

function resolveUpstream(
  adapter: ProtocolAdapter,
  forwardedHeaders: Record<string, string>,
): UpstreamTarget {
  if (adapter.agentType === 'claude-code') {
    const base =
      process.env.AGENTMIND_UPSTREAM_ANTHROPIC ||
      process.env.AGENTMIND_UPSTREAM ||
      'https://api.anthropic.com'
    const url = `${base}${adapter.endpointPath}`
    return { url, host: new URL(base).host, isChatGptBackend: false }
  }

  if (adapter.agentType === 'codex-cli') {
    if (isChatGptOAuthToken(forwardedHeaders)) {
      const base =
        process.env.AGENTMIND_UPSTREAM_OPENAI_CHATGPT ||
        'https://chatgpt.com/backend-api/codex'
      const url = `${base}/responses`
      return { url, host: new URL(base).host, isChatGptBackend: true }
    }
    const base = process.env.AGENTMIND_UPSTREAM_OPENAI || 'https://api.openai.com'
    const url = `${base}${adapter.endpointPath}`
    return { url, host: new URL(base).host, isChatGptBackend: false }
  }

  // Unknown adapter — degrade to Anthropic-shaped default.
  return {
    url: `https://api.anthropic.com${adapter.endpointPath}`,
    host: 'api.anthropic.com',
    isChatGptBackend: false,
  }
}

// True iff the Authorization header carries a ChatGPT-style OAuth /
// id_token instead of a `sk-…` platform API key. OAuth tokens are
// JWTs, which always start with `eyJ` after base64 url-encoding the
// `{"alg":...}` header object. We tolerate the `Bearer ` prefix being
// missing (some clients omit it) and case-insensitive header lookup.
function isChatGptOAuthToken(headers: Record<string, string>): boolean {
  let value: string | undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      value = v
      break
    }
  }
  if (!value) return false
  const trimmed = value.replace(/^Bearer\s+/i, '').trim()
  if (!trimmed) return false
  return trimmed.startsWith('eyJ')
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
      const target = resolveUpstream(adapter, forwardHeaders)
      upstream = await undiciRequest(target.url, {
        method: 'POST',
        headers: {
          ...forwardHeaders,
          host: target.host,
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
