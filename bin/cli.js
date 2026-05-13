#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

if (wantsHelp) {
  process.stdout.write(`
claude-proxy — local proxy that captures Claude Code <-> Anthropic traffic

USAGE:
  claude-proxy                 start on port 8088 and open the browser
  claude-proxy --port 9000     use a specific port
  claude-proxy --no-open       don't auto-open the browser
  claude-proxy --data <dir>    persist sessions under <dir>/sessions/<id>.jsonl
                               (default ~/.claude-proxy)

POINTING CLAUDE CODE AT IT:
  ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude

`)
  process.exit(0)
}

const env = { ...process.env }
if (dataArg) env.CLAUDE_PROXY_DATA_DIR = resolve(dataArg)

const viteBin = resolve(projectRoot, 'node_modules', '.bin', 'vite')
const viteArgs = ['dev', '--host', '127.0.0.1', '--port', portArg]

const child = spawn(viteBin, viteArgs, {
  cwd: projectRoot,
  stdio: ['inherit', 'pipe', 'inherit'],
  env,
})

const url = `http://127.0.0.1:${portArg}`
let opened = false

child.stdout.on('data', async (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text)
  if (opened || noOpen) return
  if (!text.includes(portArg) && !text.toLowerCase().includes('local')) return
  opened = true
  await delay(200)
  process.stdout.write(`\n► Point Claude Code at this proxy:\n    ANTHROPIC_BASE_URL=${url} claude\n\n`)
  try {
    const { default: open } = await import('open')
    await open(url)
  } catch (e) {
    process.stdout.write(`(could not auto-open browser: ${e?.message ?? e})\n`)
  }
})

child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
