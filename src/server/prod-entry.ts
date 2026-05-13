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
//   1. capture middleware  → /v1/messages, /api/*
//   2. static file server  → dist/client/* (long-cache)
//   3. TanStack handler    → SSR HTML for everything else

import * as http from 'node:http'
import {
  createReadStream,
  existsSync,
  statSync,
} from 'node:fs'
import { dirname, extname, join, resolve, normalize } from 'node:path'
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
  // routes like /sessions/:id still hit the React app.
  let safe = pathname
  try {
    safe = decodeURIComponent(safe)
  } catch {
    return false
  }
  if (safe === '/' || !safe.startsWith('/')) return false
  // Strip query (already stripped upstream usually, but be defensive).
  safe = safe.split('?')[0]
  // Path-traversal guard via `normalize` + prefix check.
  const candidate = normalize(join(clientDir, safe))
  if (!candidate.startsWith(clientDir + (clientDir.endsWith('/') ? '' : '/'))) return false
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
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(opts.port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  return server
}
