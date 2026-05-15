#!/usr/bin/env node
//
// agentmind CLI entrypoint.
//
// Has two production runtimes:
//
//   1. PRODUCTION (default for `npx agentmind-cli` / global installs)
//      Runs the prebuilt `dist/agentmind/cli.mjs` on a plain node:http
//      server. No vite, no devDependencies, ~instant start.
//
//   2. DEV (only when running from a source checkout that doesn't ship
//      a dist/ — i.e. `pnpm dev` was the developer's intent)
//      Spawns `vite dev` so HMR/typecheck work while iterating.
//
// And two invocation shapes:
//
//   a. Dashboard-only:  `agentmind-cli [flags...]`
//      Boots the proxy and opens the browser. User wires their agent
//      manually (or already has it pointed at us).
//
//   b. Launcher:        `agentmind-cli {claude|codex} [agent-args...]`
//      Boots the proxy AND spawns the named agent in the foreground
//      with the right env/config overrides so it talks to us. The
//      dashboard stays running after the agent exits so the captured
//      trace stays browsable until the user hits Ctrl+C.
//
// AgentMind flags must come BEFORE the subcommand. Anything after the
// subcommand (including `--`-prefixed args) is forwarded verbatim to
// the agent. Examples:
//
//     agentmind-cli                       # dashboard only
//     agentmind-cli --port 9090           # dashboard on custom port
//     agentmind-cli codex                 # dashboard + codex
//     agentmind-cli codex "fix the build" # passes the prompt through
//     agentmind-cli --port 9090 claude exec --task "ship"

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

const SUBCOMMANDS = new Set(['claude', 'codex'])
const VALUE_FLAGS = new Set(['--port', '--data'])

// Parse argv in two halves: everything up to (and not including) the
// first subcommand belongs to agentmind; everything after belongs to
// the agent. We have to walk left-to-right because `--port 9090` looks
// like a positional `9090` to a naive splitter — same for `--data`.
const rawArgs = process.argv.slice(2)
let subcmdIdx = -1
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]
  if (VALUE_FLAGS.has(a)) {
    i++ // skip the value
    continue
  }
  if (a.startsWith('-')) continue
  if (SUBCOMMANDS.has(a)) {
    subcmdIdx = i
    break
  }
  // Unknown positional before any subcommand — leave it where it is,
  // help text will explain the right shape.
}

const preArgs = subcmdIdx >= 0 ? rawArgs.slice(0, subcmdIdx) : rawArgs
const subcmd = subcmdIdx >= 0 ? rawArgs[subcmdIdx] : null
const agentArgs = subcmdIdx >= 0 ? rawArgs.slice(subcmdIdx + 1) : []

function getFlag(args, name) {
  return args.includes(name)
}
function getFlagValue(args, name, fallback) {
  const idx = args.indexOf(name)
  if (idx >= 0) return args[idx + 1]
  const eq = args.find((a) => a.startsWith(name + '='))
  if (eq) return eq.slice(name.length + 1)
  return fallback
}

const wantsHelp = getFlag(preArgs, '--help') || getFlag(preArgs, '-h')
const noOpen = getFlag(preArgs, '--no-open')
const forceDev = getFlag(preArgs, '--dev')
const portArg = getFlagValue(preArgs, '--port', '8088')
const dataArg = getFlagValue(preArgs, '--data', undefined)

if (wantsHelp) {
  process.stdout.write(`
agentmind-cli — a live window into your agent's mind

USAGE:
  agentmind-cli                     start dashboard, open browser
  agentmind-cli codex [args...]     start dashboard + launch codex
  agentmind-cli claude [args...]    start dashboard + launch claude

OPTIONS (must come BEFORE the subcommand):
  --port <n>        Listen port (default 8088)
  --data <dir>      Persist projects under <dir>/projects/<id>.jsonl
                    (default ~/.agentmind)
  --no-open         Skip auto-opening the browser (dashboard mode only)
  --dev             Force vite dev mode (developers only, dashboard only)
  -h, --help        Show this message

LAUNCHER NOTES:
  * \`agentmind-cli codex\` and \`agentmind-cli claude\` inject the right
    env / config so the agent talks to AgentMind. No manual setup.
  * Anything after the subcommand is forwarded verbatim to the agent.
  * When the agent exits the dashboard stays running so the captured
    trace stays browsable. Press Ctrl+C to stop AgentMind.

MANUAL SETUP (if you'd rather start your own agent):
  Claude Code:  ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude
  Codex CLI:    see README.md "Manual setup" — needs a Codex provider
                block with requires_openai_auth=true and
                supports_websockets=false. Works with existing
                \`codex login\` or OPENAI_API_KEY — no separate API key
                required.

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
    `\n► Point your agent at agentmind:\n\n` +
      `    Claude Code:\n` +
      `      ANTHROPIC_BASE_URL=${url} claude\n\n` +
      `    Codex CLI:  agentmind-cli codex     (one-liner — handles config)\n\n`,
  )
  try {
    const { default: open } = await import('open')
    await open(url)
  } catch (e) {
    process.stdout.write(`(could not auto-open browser: ${e?.message ?? e})\n`)
  }
}

// ─── Launcher ────────────────────────────────────────────────────────────
//
// Spawns the named agent in the foreground with stdio: 'inherit' so its
// TUI gets full control of the terminal. To keep the TUI clean, we
// silence every console.* / process.stdout.write call inside the
// AgentMind process (they'd land on top of the TUI) and tee them to a
// log file under ~/.agentmind/logs/.

async function runLauncher(agent, extraArgs) {
  // 1. Boot the dashboard in-process (same path as dashboard-only mode).
  const mod = await import(pathToFileURL(distCli).toString())
  await mod.start({ port, host })

  // 2. Banner BEFORE we redirect stdio.
  process.stdout.write(`\n► AgentMind dashboard: ${url}\n`)

  // 3. Open a log file for all subsequent server output.
  const dataDir = process.env.AGENTMIND_DATA_DIR || join(homedir(), '.agentmind')
  const logsDir = join(dataDir, 'logs')
  try {
    mkdirSync(logsDir, { recursive: true })
  } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logPath = join(logsDir, `${agent}-${ts}.log`)
  const logFile = createWriteStream(logPath, { flags: 'a' })
  await new Promise((r) => logFile.once('open', r))

  process.stdout.write(`► Server logs:        ${logPath}\n`)
  process.stdout.write(`► Launching ${agent}...\n\n`)

  // 4. Redirect AgentMind's stdout/stderr to the log file. The child
  //    we're about to spawn uses 'inherit' which dups the parent's fd 1
  //    / fd 2 — NOT process.stdout.write — so the agent's TUI is
  //    unaffected by these method-level overrides. We only restore them
  //    after the agent exits.
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  const origConsoleLog = console.log
  const origConsoleWarn = console.warn
  const origConsoleError = console.error
  const teeWrite = (chunk) => {
    try {
      logFile.write(typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '')
    } catch {}
    return true
  }
  process.stdout.write = teeWrite
  process.stderr.write = teeWrite
  console.log = (...a) => logFile.write(a.map(String).join(' ') + '\n')
  console.warn = (...a) => logFile.write('WARN: ' + a.map(String).join(' ') + '\n')
  console.error = (...a) => logFile.write('ERROR: ' + a.map(String).join(' ') + '\n')

  function restoreStdio() {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    console.log = origConsoleLog
    console.warn = origConsoleWarn
    console.error = origConsoleError
  }

  // 5. Build the child process env + argv for this agent.
  const childEnv = { ...process.env }
  let cmd, cmdArgs
  if (agent === 'claude') {
    childEnv.ANTHROPIC_BASE_URL = url
    cmd = 'claude'
    cmdArgs = extraArgs
  } else if (agent === 'codex') {
    // `requires_openai_auth = true` mirrors the built-in `openai`
    // provider's behavior: Codex picks the right auth source on its
    // own — cached ChatGPT OAuth from `codex login` if available,
    // otherwise OPENAI_API_KEY. Either way, the resulting bearer
    // token is forwarded to our proxy unchanged. The proxy then
    // sniffs the token shape (JWT vs `sk-…`) and routes to either
    // `chatgpt.com/backend-api/codex/responses` (OAuth) or
    // `api.openai.com/v1/responses` (API key). End result: the user
    // doesn't have to know or care which auth they're on.
    //
    // `-c key="val"` is Codex's TOML override syntax (dot notation for
    // nested keys). This replaces the entire `[model_providers.agentmind]`
    // section atomically for THIS run only — nothing is persisted to
    // ~/.codex/config.toml, so there's nothing to clean up on crash.
    cmd = 'codex'
    cmdArgs = [
      '-c', `model_provider="agentmind"`,
      '-c', `model_providers.agentmind.name="AgentMind"`,
      '-c', `model_providers.agentmind.base_url="${url}/v1"`,
      '-c', `model_providers.agentmind.requires_openai_auth=true`,
      '-c', `model_providers.agentmind.wire_api="responses"`,
      '-c', `model_providers.agentmind.supports_websockets=false`,
      ...extraArgs,
    ]
  }

  // 6. Spawn. shell: true on Windows so PATH lookups find .cmd shims.
  let child
  try {
    child = spawn(cmd, cmdArgs, {
      stdio: 'inherit',
      env: childEnv,
      shell: process.platform === 'win32',
    })
  } catch (err) {
    restoreStdio()
    process.stderr.write(`\n✗ failed to spawn ${cmd}: ${err?.message ?? err}\n`)
    process.exit(1)
  }

  // 7. Signal handling. Two phases:
  //
  //    agent-running: the child owns the TTY. SIGINT from a terminal
  //      Ctrl+C is delivered to the entire foreground process group
  //      (us AND the child) — the child handles its own cleanup, we
  //      MUST stay alive to print the post-exit banner. We install a
  //      no-op handler so Node doesn't auto-exit on SIGINT. SIGTERM
  //      from `kill <pid>` is only delivered to us, so we propagate it
  //      to the child explicitly.
  //
  //    agent-done: child has exited, we're parked waiting for the user
  //      to release the dashboard. Either signal tears us down cleanly.
  let phase = 'agent-running'
  const stopDashboard = () => {
    restoreStdio()
    process.stdout.write('\nStopping AgentMind...\n')
    try {
      logFile.end()
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', () => {
    if (phase === 'agent-running') return // child gets it from the TTY
    stopDashboard()
  })
  process.on('SIGTERM', () => {
    if (phase === 'agent-running') {
      if (child && !child.killed) child.kill('SIGTERM')
      return
    }
    stopDashboard()
  })

  child.on('error', (err) => {
    restoreStdio()
    if (err.code === 'ENOENT') {
      process.stderr.write(`\n✗ '${cmd}' not found in PATH.\n`)
      const hint =
        agent === 'codex'
          ? '  Install with: npm i -g @openai/codex'
          : '  Install with: npm i -g @anthropic-ai/claude-code'
      process.stderr.write(hint + '\n')
    } else {
      process.stderr.write(`\n✗ failed to launch ${cmd}: ${err.message}\n`)
    }
    try {
      logFile.end()
    } catch {}
    process.exit(127)
  })

  await new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      restoreStdio()
      phase = 'agent-done'
      const mark = signal ? '✗' : code ? '✗' : '✓'
      let detail = ''
      if (signal) detail = ` (signal ${signal})`
      else if (code) detail = ` with code ${code}`
      process.stdout.write(`\n${mark} ${agent} exited${detail}.\n`)
      process.stdout.write(`  Trace ready at ${url}\n`)
      process.stdout.write(`  Press Ctrl+C to stop AgentMind.\n`)
      resolveExit()
    })
  })

  // 8. Park the process until the user hits Ctrl+C. The dashboard is
  //    still running in-process; the SIGINT handler above will tear it
  //    down cleanly.
  await new Promise(() => {})
}

// ─── Dispatch ────────────────────────────────────────────────────────────

if (subcmd) {
  if (!useProd) {
    process.stderr.write(
      `agentmind-cli: the \`${subcmd}\` launcher requires a built dist/.\n` +
        `If you're hacking on agentmind, run \`pnpm build\` first or use\n` +
        `\`agentmind-cli\` (no subcommand) for the vite dev dashboard.\n`,
    )
    process.exit(1)
  }
  try {
    await runLauncher(subcmd, agentArgs)
  } catch (err) {
    process.stderr.write(`agentmind-cli: launcher failed\n${err?.stack ?? err}\n`)
    process.exit(1)
  }
} else if (useProd) {
  // Production dashboard-only: in-process, no child node, no vite.
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
  // Dev dashboard: spawn vite. Only viable when bin/cli.js sits next to
  // the source tree (i.e. `pnpm dev` directly, or `pnpm link --global`
  // from a checkout).
  //
  // We invoke vite's JS entry via process.execPath instead of the
  // platform-specific shim under node_modules/.bin. On Windows that
  // shim is `vite.cmd`, which (a) existsSync misses if you check for
  // a `vite` (no-extension) file, and (b) Node's spawn won't execute
  // a `.cmd` without `shell: true` + escaping gymnastics. Driving the
  // raw JS through node is identical on macOS / Linux / Windows.
  const viteEntry = resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteEntry)) {
    process.stderr.write(
      `agentmind-cli: dist/agentmind/cli.mjs missing and vite not installed.\n` +
        `If you're hacking on agentmind, run \`pnpm install && pnpm build\` first.\n`,
    )
    process.exit(1)
  }
  const viteArgs = ['dev', '--host', host, '--port', String(port)]
  const child = spawn(process.execPath, [viteEntry, ...viteArgs], {
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
