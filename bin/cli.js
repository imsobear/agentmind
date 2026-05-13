#!/usr/bin/env node
//
// agentmind CLI entrypoint.
//
// Has two modes:
//
//   1. PRODUCTION (default for `npx agentmind-cli` / global installs)
//      Runs the prebuilt `dist/agentmind/cli.mjs` on a plain node:http
//      server. No vite, no devDependencies, ~instant start.
//
//   2. DEV (only when running from a source checkout that doesn't ship
//      a dist/ — i.e. `pnpm dev` was the developer's intent)
//      Spawns `vite dev` so HMR/typecheck work while iterating.
//
// We pick by checking whether `dist/agentmind/cli.mjs` exists relative
// to this file.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

const args = process.argv.slice(2)
const wantsHelp = args.includes('--help') || args.includes('-h')
const noOpen = args.includes('--no-open')
const portFlagIdx = args.indexOf('--port')
const portArg = portFlagIdx >= 0 ? args[portFlagIdx + 1] : '8088'
const dataFlagIdx = args.indexOf('--data')
const dataArg = dataFlagIdx >= 0 ? args[dataFlagIdx + 1] : undefined
const forceDev = args.includes('--dev')

if (wantsHelp) {
  process.stdout.write(`
agentmind-cli — a live window into your agent's mind

USAGE:
  agentmind-cli                 start on port 8088 and open the browser
  agentmind-cli --port 9000     use a specific port
  agentmind-cli --no-open       don't auto-open the browser
  agentmind-cli --data <dir>    persist projects under <dir>/sessions/<id>.jsonl
                                (default ~/.agentmind)
  agentmind-cli --dev           force dev mode (vite + HMR) even if dist/ exists

POINTING CLAUDE CODE AT IT:
  ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude

`)
  process.exit(0)
}

if (dataArg) process.env.AGENTMIND_DATA_DIR = resolve(dataArg)

const port = Number.parseInt(portArg, 10)
const host = '127.0.0.1'
const url = `http://${host}:${port}`

const distCli = resolve(projectRoot, 'dist', 'agentmind', 'cli.mjs')
const useProd = !forceDev && existsSync(distCli)

async function maybeOpenBrowser() {
  if (noOpen) return
  await delay(200)
  process.stdout.write(
    `\n► Point Claude Code at agentmind:\n    ANTHROPIC_BASE_URL=${url} claude\n\n`,
  )
  try {
    const { default: open } = await import('open')
    await open(url)
  } catch (e) {
    process.stdout.write(`(could not auto-open browser: ${e?.message ?? e})\n`)
  }
}

if (useProd) {
  // Production: in-process — no child node, no vite spin-up tax.
  try {
    const mod = await import(pathToFileURL(distCli).toString())
    await mod.start({ port, host })
    process.stdout.write(`  agentmind-cli ready at ${url}\n`)
    void maybeOpenBrowser()
  } catch (err) {
    process.stderr.write(`agentmind-cli: failed to start production server\n${err?.stack ?? err}\n`)
    process.exit(1)
  }
} else {
  // Dev: spawn vite. Only viable when bin/cli.js sits next to the
  // source tree (i.e. you ran `pnpm link --global` from a checkout, or
  // you're using `pnpm dev` directly).
  const viteBin = resolve(projectRoot, 'node_modules', '.bin', 'vite')
  if (!existsSync(viteBin)) {
    process.stderr.write(
      `agentmind-cli: dist/agentmind/cli.mjs missing and vite not installed.\n` +
        `If you're hacking on agentmind, run \`pnpm install && pnpm build\` first.\n`,
    )
    process.exit(1)
  }
  const viteArgs = ['dev', '--host', host, '--port', String(port)]
  const child = spawn(viteBin, viteArgs, {
    cwd: projectRoot,
    stdio: ['inherit', 'pipe', 'inherit'],
    env: process.env,
  })

  let opened = false
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    process.stdout.write(text)
    if (opened || noOpen) return
    if (!text.includes(String(port)) && !text.toLowerCase().includes('local')) return
    opened = true
    void maybeOpenBrowser()
  })

  child.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
}
