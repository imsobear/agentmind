// Smoke test for the `agentmind-cli {codex,claude}` launcher subcommands.
//
// We can't run the real codex/claude binaries in CI, so we shim them
// via PATH: a tiny node script that records its argv + a slice of its
// env to a JSON file and exits 0. Then:
//
//   1. Spawn `agentmind-cli --port <P> <agent> hello` with the shim on
//      PATH. The launcher boots the dashboard, then invokes the shim.
//   2. Wait for the shim's snapshot file to appear.
//   3. Assert that the recorded argv contains all the expected -c
//      overrides (for codex) and that the right env vars were injected.
//   4. SIGTERM the parent. Because the agent already exited it's
//      parked; the SIGTERM handler tears down the dashboard cleanly.
//
// Skipped on Windows — the PATH-shim trick needs different plumbing
// there (`.cmd` shims + shell quoting). The launcher itself handles
// Windows via `shell: true`, but proving that automatically is a
// separate adventure.

import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

if (platform() === 'win32') {
  process.stdout.write('[launcher-smoke] skipped on Windows (PATH shim plumbing differs)\n')
  process.exit(0)
}

const here = resolve(fileURLToPath(import.meta.url), '..')
const repo = resolve(here, '..')

const tmpBin = mkdtempSync(join(tmpdir(), 'agentmind-launcher-shim-'))
const dataDir = mkdtempSync(join(tmpdir(), 'agentmind-launcher-data-'))
const snapshotPath = join(tmpBin, 'snapshot.json')

function log(...a) {
  process.stdout.write(`[launcher-smoke] ${a.join(' ')}\n`)
}

// Tiny node script masquerading as `codex` / `claude`. Records its
// argv + relevant env to `snapshotPath`, then exits.
function makeShim(name) {
  const code =
    `#!/usr/bin/env node\n` +
    `const fs = require('node:fs')\n` +
    `fs.writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({\n` +
    `  argv: process.argv.slice(2),\n` +
    `  env: {\n` +
    `    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,\n` +
    `    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,\n` +
    `  },\n` +
    `}))\n` +
    `process.exit(0)\n`
  const p = join(tmpBin, name)
  writeFileSync(p, code)
  chmodSync(p, 0o755)
}
makeShim('codex')
makeShim('claude')

const cliEntry = join(repo, 'bin', 'cli.js')
const PORT = 18293

async function runOne(agent, opts = {}) {
  if (existsSync(snapshotPath)) rmSync(snapshotPath)
  // When `agent` is `null` we exercise the 0.2.1 default behavior:
  // omit the subcommand entirely, expect the CLI to fill in `claude`
  // on our behalf and pass no extra positional args through.
  const subArgv = agent ? [agent, 'hello'] : []
  const child = spawn(
    process.execPath,
    [cliEntry, '--port', String(PORT), '--data', dataDir, '--no-open', ...subArgv],
    {
      cwd: repo,
      env: {
        ...process.env,
        // Shim takes precedence over any real codex/claude on PATH.
        PATH: `${tmpBin}:${process.env.PATH}`,
        AGENTMIND_VERBOSE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const outChunks = []
  child.stdout.on('data', (c) => outChunks.push(c))
  child.stderr.on('data', (c) => outChunks.push(c))

  // Wait for the shim to drop its snapshot.
  for (let i = 0; i < 200; i++) {
    if (existsSync(snapshotPath)) break
    await delay(50)
  }
  if (!existsSync(snapshotPath)) {
    child.kill('SIGTERM')
    throw new Error(
      `shim never ran for agent=${agent}; cli output:\n${Buffer.concat(outChunks).toString('utf8')}`,
    )
  }
  const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'))

  // Let the launcher print its post-exit banner, then tear down.
  await delay(200)
  child.kill('SIGTERM')
  await new Promise((r) => child.on('exit', r))
  return snap
}

log('testing codex launcher...')
const codexSnap = await runOne('codex')
const argvJoined = codexSnap.argv.join(' ')
const expectedFragments = [
  '-c',
  'model_provider="agentmind"',
  'model_providers.agentmind.name="AgentMind"',
  'model_providers.agentmind.base_url="http://127.0.0.1:18293/v1"',
  'model_providers.agentmind.requires_openai_auth=true',
  'model_providers.agentmind.wire_api="responses"',
  'model_providers.agentmind.supports_websockets=false',
  'hello',
]
for (const f of expectedFragments) {
  if (!argvJoined.includes(f)) {
    throw new Error(`codex argv missing fragment "${f}"\nfull argv: ${argvJoined}`)
  }
}
// We deliberately DO NOT inject any fake API key — Codex picks its own
// auth (cached ChatGPT login or OPENAI_API_KEY) and we just forward
// whatever bearer it sends. Verify nothing leaks here.
if (codexSnap.env.OPENAI_API_KEY && codexSnap.env.OPENAI_API_KEY !== process.env.OPENAI_API_KEY) {
  throw new Error(
    `launcher should not synthesize OPENAI_API_KEY; got ${codexSnap.env.OPENAI_API_KEY}`,
  )
}
log('codex OK — argv has requires_openai_auth=true, no fake key injected')

log('testing claude launcher...')
const claudeSnap = await runOne('claude')
if (claudeSnap.argv.length !== 1 || claudeSnap.argv[0] !== 'hello') {
  throw new Error(`claude argv unexpected: ${JSON.stringify(claudeSnap.argv)}`)
}
if (claudeSnap.env.ANTHROPIC_BASE_URL !== `http://127.0.0.1:${PORT}`) {
  throw new Error(`expected ANTHROPIC_BASE_URL, got ${claudeSnap.env.ANTHROPIC_BASE_URL}`)
}
log('claude OK — argv forwarded verbatim, ANTHROPIC_BASE_URL injected')

// 0.2.1: `agentmind-cli` with NO subcommand should resolve to the
// claude launcher (replaces the pre-0.2.1 dashboard-only default).
// We pass `null` to runOne to omit the subcommand and `hello` arg
// entirely, then assert the shim was invoked with the env Claude Code
// expects.
log('testing default (no subcommand) launcher...')
const defaultSnap = await runOne(null)
if (defaultSnap.argv.length !== 0) {
  throw new Error(`default argv unexpected: ${JSON.stringify(defaultSnap.argv)}`)
}
if (defaultSnap.env.ANTHROPIC_BASE_URL !== `http://127.0.0.1:${PORT}`) {
  throw new Error(
    `default mode should launch claude, ANTHROPIC_BASE_URL got: ${defaultSnap.env.ANTHROPIC_BASE_URL}`,
  )
}
log('default OK — bare `agentmind-cli` launched claude shim')

rmSync(tmpBin, { recursive: true, force: true })
rmSync(dataDir, { recursive: true, force: true })
log('all passed')
process.exit(0)
