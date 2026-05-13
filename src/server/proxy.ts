// HTTP proxy for the Anthropic Messages API.
//
// We listen at /v1/messages, forward to https://api.anthropic.com/v1/messages,
// and tee the response. The Authorization / x-api-key headers come from the
// client (Claude Code), we never inject our own keys.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as undiciRequest } from 'undici'
import type { AnthropicRequest } from '../lib/anthropic-types'
import { Storage, newId } from './storage'
import { Grouper } from './grouping'
import { SseAccumulator } from './sse'

// Hardcoded upstream. The CLAUDE_PROXY_UPSTREAM env override exists for
// integration testing only — do not surface it in user-facing docs.
function upstreamBase(): string {
  return process.env.CLAUDE_PROXY_UPSTREAM || 'https://api.anthropic.com'
}
const PROXY_VERSION = '0.1.0'

// Headers we forward as-is to upstream. Deliberately NOT forwarded:
//   • host / connection / content-length → recomputed by undici
//   • accept-encoding → we want plaintext from upstream so our SSE tee can
//     pass bytes straight through to claude. If we forwarded `gzip`, upstream
//     would compress, and we'd either need to decompress before teeing (heavy)
//     or forward the gzip bytes — but we strip content-encoding on the way
//     out, so the client sees plaintext-labelled gzip and silently fails.
const FORWARD_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'content-type',
  'user-agent',
  'accept',
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
    if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key') {
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
  // signal when a session/message/interaction was captured, for the UI to refresh.
  onEvent?: (e: { kind: 'session' | 'message' | 'interaction'; sessionId: string; id: string }) => void
}

export function createMessagesProxy(deps: ProxyDeps) {
  const { storage, grouper, onEvent } = deps

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

    let parsed: AnthropicRequest
    try {
      parsed = JSON.parse(bodyBuf.toString('utf8'))
    } catch (e) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'invalid_json', message: String(e) }))
      return
    }

    const now = Date.now()
    const cwd = extractCwd(parsed)
    const resolution = grouper.resolve(parsed, now, newId, cwd)
    const interactionId = newId()
    const startedAtIso = new Date(now).toISOString()

    // 2. Persist session/message records if new.
    if (resolution.isNewSession) {
      storage.appendRecord(resolution.sessionId, {
        type: 'session',
        sessionId: resolution.sessionId,
        startedAt: startedAtIso,
        firstSeenModel: parsed.model,
        cwd,
        proxyVersion: PROXY_VERSION,
      })
      onEvent?.({ kind: 'session', sessionId: resolution.sessionId, id: resolution.sessionId })
    }
    if (resolution.isNewMessage) {
      storage.appendRecord(resolution.sessionId, {
        type: 'message',
        messageId: resolution.messageId,
        sessionId: resolution.sessionId,
        index: resolution.messageIndex,
        startedAt: startedAtIso,
        firstUserText: resolution.firstUserText,
      })
      onEvent?.({ kind: 'message', sessionId: resolution.sessionId, id: resolution.messageId })
    }

    const forwardHeaders = pickForwardHeaders(req)
    const safeHeaders = safeRequestHeaders(forwardHeaders)

    // 3. Persist a partial interaction record so the UI sees it immediately.
    storage.appendRecord(resolution.sessionId, {
      type: 'interaction',
      interactionId,
      sessionId: resolution.sessionId,
      messageId: resolution.messageId,
      index: resolution.interactionIndex,
      startedAt: startedAtIso,
      request: parsed,
      requestHeaders: safeHeaders,
    })
    onEvent?.({ kind: 'interaction', sessionId: resolution.sessionId, id: interactionId })

    // 4. Forward upstream.
    let upstream
    try {
      const base = upstreamBase()
      const upstreamHost = new URL(base).host
      upstream = await undiciRequest(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          ...forwardHeaders,
          host: upstreamHost,
          // Force identity so the upstream sends plaintext we can byte-tee.
          'accept-encoding': 'identity',
        },
        body: bodyBuf,
        // Always allow streaming.
        bodyTimeout: 0,
        headersTimeout: 30_000,
      })
    } catch (e: any) {
      const errMsg = e?.message ?? String(e)
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'upstream_unreachable', message: errMsg }))
      // Patch interaction with error.
      storage.appendRecord(resolution.sessionId, {
        type: 'interaction',
        interactionId,
        sessionId: resolution.sessionId,
        messageId: resolution.messageId,
        index: resolution.interactionIndex,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - now,
        request: parsed,
        requestHeaders: safeHeaders,
        error: { message: errMsg },
      })
      onEvent?.({ kind: 'interaction', sessionId: resolution.sessionId, id: interactionId })
      return
    }

    // 5. Mirror upstream headers / status to client.
    res.statusCode = upstream.statusCode
    const upstreamHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (v == null) continue
      const val = Array.isArray(v) ? v.join(', ') : String(v)
      upstreamHeaders[k] = val
      // Skip a few transfer-related headers the runtime will set itself.
      if (k.toLowerCase() === 'content-encoding') continue
      if (k.toLowerCase() === 'transfer-encoding') continue
      if (k.toLowerCase() === 'content-length') continue
      res.setHeader(k, val)
    }

    const isSse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
    const isStream = parsed.stream === true || isSse

    if (isStream) {
      // SSE streaming path.
      const acc = new SseAccumulator()
      try {
        for await (const chunk of upstream.body) {
          const buf = chunk as Buffer
          const text = buf.toString('utf8')
          acc.feed(text)
          // tee to client immediately.
          res.write(buf)
        }
        acc.flush()
      } catch (e: any) {
        // upstream broke mid-stream
        const errMsg = e?.message ?? String(e)
        try {
          res.end()
        } catch {}
        storage.appendRecord(resolution.sessionId, {
          type: 'interaction',
          interactionId,
          sessionId: resolution.sessionId,
          messageId: resolution.messageId,
          index: resolution.interactionIndex,
          startedAt: startedAtIso,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - now,
          request: parsed,
          requestHeaders: safeHeaders,
          responseHeaders: upstreamHeaders,
          sseEvents: acc.events,
          response: acc.getResponse(),
          error: { message: errMsg, status: upstream.statusCode },
        })
        onEvent?.({ kind: 'interaction', sessionId: resolution.sessionId, id: interactionId })
        return
      }
      try {
        res.end()
      } catch {}
      // Finalise.
      storage.appendRecord(resolution.sessionId, {
        type: 'interaction',
        interactionId,
        sessionId: resolution.sessionId,
        messageId: resolution.messageId,
        index: resolution.interactionIndex,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - now,
        request: parsed,
        requestHeaders: safeHeaders,
        responseHeaders: upstreamHeaders,
        sseEvents: acc.events,
        response: acc.getResponse(),
      })
      onEvent?.({ kind: 'interaction', sessionId: resolution.sessionId, id: interactionId })
      return
    }

    // Non-streaming path: buffer & parse JSON.
    const respChunks: Buffer[] = []
    try {
      for await (const chunk of upstream.body) respChunks.push(chunk as Buffer)
    } catch (e: any) {
      try {
        res.end()
      } catch {}
      storage.appendRecord(resolution.sessionId, {
        type: 'interaction',
        interactionId,
        sessionId: resolution.sessionId,
        messageId: resolution.messageId,
        index: resolution.interactionIndex,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - now,
        request: parsed,
        requestHeaders: safeHeaders,
        responseHeaders: upstreamHeaders,
        error: { message: e?.message ?? String(e), status: upstream.statusCode },
      })
      onEvent?.({ kind: 'interaction', sessionId: resolution.sessionId, id: interactionId })
      return
    }
    const respBuf = Buffer.concat(respChunks)
    res.end(respBuf)

    let parsedResp: any
    try {
      parsedResp = JSON.parse(respBuf.toString('utf8'))
    } catch {
      parsedResp = undefined
    }
    storage.appendRecord(resolution.sessionId, {
      type: 'interaction',
      interactionId,
      sessionId: resolution.sessionId,
      messageId: resolution.messageId,
      index: resolution.interactionIndex,
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - now,
      request: parsed,
      requestHeaders: safeHeaders,
      responseHeaders: upstreamHeaders,
      response: parsedResp && parsedResp.type === 'message' ? parsedResp : undefined,
      error: upstream.statusCode >= 400 ? { message: respBuf.toString('utf8').slice(0, 1024), status: upstream.statusCode } : undefined,
    })
    onEvent?.({ kind: 'interaction', sessionId: resolution.sessionId, id: interactionId })
  }
}

// Pull cwd out of Claude Code's system prompt if it's there. Best-effort.
function extractCwd(req: AnthropicRequest): string | undefined {
  const sys = req.system
  let text = ''
  if (typeof sys === 'string') text = sys
  else if (Array.isArray(sys)) text = sys.map((b) => b.text).join('\n')
  if (!text) return undefined
  const m = text.match(/(?:cwd|working[_ ]?directory)\s*[:=]\s*([^\n]+)/i)
  return m?.[1]?.trim() || undefined
}
