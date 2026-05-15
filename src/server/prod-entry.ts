// Production CLI entry. Runs the built TanStack app + our capture
// middleware on a real node:http server — no vite, no devDependencies.
//
// Layout at runtime (after `pnpm build`):
//
//   <pkg>/dist/agentmind/cli.mjs   ← THIS FILE (bundled)
//   <pkg>/dist/server/server.js    ← TanStack fetch handler (default export)
//   <pkg>/dist/client/             ← static client assets (hashed)
//
// Request routing order:
//   1. capture middleware  → /v1/messages, /v1/responses, /api/*
//   2. static file server  → dist/client/* (long-cache)
//   3. TanStack handler    → SSR HTML for everything else

import * as http from 'node:http'
import {
  createReadStream,
  existsSync,
  statSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { NodeRequest, sendNodeResponse } from 'srvx/node'

import { createCaptureMiddleware } from './middleware'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// cli.mjs lives at <pkg>/dist/agentmind/cli.mjs — pkg root is two up.
const distDir = resolve(__dirname, '..')
const clientDir = resolve(distDir, 'client')
const serverEntryPath = resolve(distDir, 'server', 'server.js')

const capture = createCaptureMiddleware()

type FetchHandler = { fetch: (req: Request) => Promise<Response> }
let cachedServer: FetchHandler | undefined
async function loadServerEntry(): Promise<FetchHandler> {
  if (cachedServer) return cachedServer
  if (!existsSync(serverEntryPath)) {
    throw new Error(
      `agentmind: SSR entry not found at ${serverEntryPath}. ` +
        `Did the build step run? Try \`pnpm build\`.`,
    )
  }
  const mod = await import(pathToFileURL(serverEntryPath).toString())
  cachedServer = mod.default as FetchHandler
  return cachedServer
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function tryServeStatic(pathname: string, res: ServerResponse): boolean {
  // Hashed asset paths (e.g. /assets/index-DHaF7x8N.js) live under
  // dist/client/assets — anything else routes to SSR so client-side
  // routes like /projects/:id still hit the React app.
  let safe = pathname
  try {
    safe = decodeURIComponent(safe)
  } catch {
    return false
  }
  if (safe === '/' || !safe.startsWith('/')) return false
  // Strip query (already stripped upstream usually, but be defensive).
  safe = safe.split('?')[0]
  // Normalize as a POSIX URL path so `..` segments collapse identically
  // on every host OS — then a relative-check against clientDir catches
  // anything that still tries to escape. The previous version compared
  // a `normalize()`d path against `clientDir + '/'`; on Windows that
  // literal `/` never matches the `\` separator, which made *every*
  // static asset request 404. Hence the explicit `posix.normalize`
  // here.
  const normalized = posix.normalize(safe)
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/..')) {
    return false
  }
  const candidate = join(clientDir, normalized)
  const rel = relative(clientDir, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  if (!existsSync(candidate)) return false
  const stat = statSync(candidate)
  if (!stat.isFile()) return false
  const ext = extname(candidate).toLowerCase()
  res.statusCode = 200
  res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream')
  res.setHeader('content-length', String(stat.size))
  // Hashed bundles under /assets are immutable; everything else gets a
  // short revalidate so updates to e.g. favicon.ico aren't sticky.
  if (safe.startsWith('/assets/')) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('cache-control', 'public, max-age=60')
  }
  createReadStream(candidate).pipe(res)
  return true
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let didNext = false
  await capture(req, res, () => {
    didNext = true
  })
  if (!didNext) return
  if (res.writableEnded) return

  const url = req.url ?? '/'
  const pathname = url.split('?')[0]
  if (tryServeStatic(pathname, res)) return

  const entry = await loadServerEntry()
  const webReq = new NodeRequest({ req, res })
  const webRes = await entry.fetch(webReq)
  if (webRes.headers.get('content-type')?.startsWith('text/html')) {
    res.setHeader('content-encoding', 'identity')
  }
  res.setHeaders(webRes.headers)
  res.writeHead(webRes.status, webRes.statusText)
  await sendNodeResponse(res, webRes)
}

export interface StartOpts {
  port: number
  host?: string
}

export async function start(opts: StartOpts): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1'
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[agentmind] request error', err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('Internal Server Error\n')
      } else {
        try {
          res.end()
        } catch {}
      }
    })
  })

  // WebSocket upgrade handler. Node routes `Upgrade: websocket` requests
  // to the `upgrade` event, NOT to the normal request handler — so without
  // this listener, Codex CLI's default WS attempt against
  // `ws://127.0.0.1:<port>/v1/responses` just hangs and consumes the full
  // stream_max_retries × 15s timeout budget (~75s) before falling back to
  // HTTP. Most users give up long before that and report "AgentMind
  // captured nothing". We respond with HTTP 426 + a one-line hint so the
  // failure mode is loud and actionable; Codex sees the non-101 response
  // and bails immediately, falling through to HTTP/SSE only if the user
  // has configured `supports_websockets = false` in their Codex provider
  // (we recommend that in the hint).
  server.on('upgrade', (req, socket) => {
    const ts = new Date().toISOString().slice(11, 23)
    const urlPath = (req.url ?? '').split('?')[0]
    // eslint-disable-next-line no-console
    console.warn(
      `[agentmind ${ts}] WebSocket upgrade to ${urlPath} — refusing.\n` +
        `  AgentMind only speaks HTTP/SSE. Codex CLI tries WS first and won't\n` +
        `  fall back until 5×15s retries elapse. The fix is one of:\n\n` +
        `    A. Use the launcher (handles everything):\n` +
        `         agentmind-cli codex\n\n` +
        `    B. Add this provider block to ~/.codex/config.toml:\n` +
        `         model_provider = "agentmind"\n` +
        `         [model_providers.agentmind]\n` +
        `         base_url = "http://${host}:${opts.port}/v1"\n` +
        `         requires_openai_auth = true   # use cached codex login\n` +
        `         wire_api = "responses"\n` +
        `         supports_websockets = false\n`,
    )
    const body =
      'AgentMind speaks HTTP/SSE, not WebSocket.\n' +
      'Set `supports_websockets = false` on your Codex provider config.\n'
    socket.write(
      'HTTP/1.1 426 Upgrade Required\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body,
    )
    socket.destroy()
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(opts.port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  return server
}
