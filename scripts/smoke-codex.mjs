// End-to-end smoke for Codex CLI capture.
//
//   1. Start a stub upstream that pretends to be api.openai.com — accepts
//      POST /v1/responses and streams a canned SSE script back.
//   2. Boot agentmind-cli pointing at it via AGENTMIND_UPSTREAM_OPENAI
//      (and at a fresh temp data dir so we don't clobber the user's
//      ~/.agentmind).
//   3. Hit the proxy with a request that mimics a real Codex CLI turn —
//      including the <environment_context><cwd>…</cwd></environment_context>
//      block we extract cwd from.
//   4. Verify the /api/projects + /api/projects/:id + interaction lookups
//      come back with the expected shape (agentType=codex-cli, cwd
//      extracted, output[] reconstructed from the stream).
//
// Run: `node scripts/smoke-codex.mjs` (CLI must be built — `pnpm build`).

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const here = resolve(fileURLToPath(import.meta.url), '..')
const repo = resolve(here, '..')

const UPSTREAM_PORT = 18290
const PROXY_PORT = 18291
const FAKE_CWD = '/private/var/codex-smoke/' + Math.random().toString(36).slice(2, 8)
const dataDir = mkdtempSync(join(tmpdir(), 'agentmind-codex-smoke-'))

function log(...a) {
  process.stdout.write(`[smoke] ${a.join(' ')}\n`)
}

// 1. Stub upstream — mirrors POST /v1/responses with a canned stream.
const upstream = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.statusCode = 404
    res.end()
    return
  }
  // Drain body (we don't validate it here — the proxy already did).
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    write({
      type: 'response.created',
      response: { id: 'resp_smoke_1', model: 'gpt-5-codex', status: 'in_progress' },
    })
    await delay(20)
    write({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_smoke_1', role: 'assistant', content: [] },
    })
    write({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello ' })
    write({ type: 'response.output_text.delta', output_index: 0, delta: 'from Codex.' })
    await delay(10)
    write({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_smoke_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from Codex.' }],
      },
    })
    write({
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_smoke_1',
        call_id: 'call_smoke_1',
        name: 'shell',
        arguments: '',
      },
    })
    write({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      delta: '{"command":["echo",',
    })
    write({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      delta: '"hi"]}',
    })
    write({
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_smoke_1',
        call_id: 'call_smoke_1',
        name: 'shell',
        arguments: '{"command":["echo","hi"]}',
      },
    })
    write({
      type: 'response.completed',
      response: {
        id: 'resp_smoke_1',
        object: 'response',
        model: 'gpt-5-codex',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_smoke_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello from Codex.' }],
          },
          {
            type: 'function_call',
            id: 'fc_smoke_1',
            call_id: 'call_smoke_1',
            name: 'shell',
            arguments: '{"command":["echo","hi"]}',
          },
        ],
        usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
      },
    })
    res.end()
  })
})
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))
log('upstream stub listening on', UPSTREAM_PORT)

// 2. Boot agentmind-cli pointed at the stub.
const cli = spawn(process.execPath, [resolve(repo, 'bin', 'cli.js'),
  '--port', String(PROXY_PORT),
  '--data', dataDir,
  '--no-open',
], {
  cwd: repo,
  env: {
    ...process.env,
    AGENTMIND_UPSTREAM_OPENAI: `http://127.0.0.1:${UPSTREAM_PORT}`,
    AGENTMIND_VERBOSE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let cliReady = false
cli.stdout.on('data', (d) => {
  const t = d.toString()
  process.stdout.write('[cli stdout] ' + t)
  if (t.includes('agentmind-cli ready')) cliReady = true
})
cli.stderr.on('data', (d) => process.stderr.write('[cli stderr] ' + d.toString()))

for (let i = 0; i < 50 && !cliReady; i++) await delay(100)
if (!cliReady) throw new Error('CLI never reported ready')

async function request(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return { status: res.status, body: await res.json() }
  const text = await res.text()
  return { status: res.status, body: text, headers: res.headers }
}

async function streamPost(path, body) {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let acc = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    acc += dec.decode(value)
  }
  return { status: r.status, sse: acc }
}

// 3. Fake Codex request — env block contains the cwd we want to extract.
const codexBody = {
  model: 'gpt-5-codex',
  instructions: 'You are Codex.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            '<environment_context>\n' +
            `  <cwd>${FAKE_CWD}</cwd>\n` +
            '  <shell>zsh</shell>\n' +
            '</environment_context>',
        },
      ],
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '## My request for Codex:\n\nSay hi.' }],
    },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'shell',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'array' } } },
      },
    },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  store: false,
  stream: true,
  include: [],
}
log('POSTing fake codex request...')
const post = await streamPost('/v1/responses', codexBody)
if (post.status !== 200) throw new Error('proxy returned ' + post.status)
if (!post.sse.includes('response.completed')) throw new Error('SSE missing response.completed')
log('proxy streamed', post.sse.length, 'bytes of SSE')

// Give storage a tick to flush.
await delay(150)

// 4. Verify list + detail + interaction.
const list = await request('GET', '/api/projects')
log('projects list:', JSON.stringify(list.body))
if (list.status !== 200 || !Array.isArray(list.body) || list.body.length !== 1) {
  throw new Error('expected 1 project, got ' + JSON.stringify(list.body))
}
const proj = list.body[0]
if (proj.agentType !== 'codex-cli') throw new Error('agentType mismatch: ' + proj.agentType)
if (proj.cwd !== FAKE_CWD) throw new Error('cwd mismatch: ' + proj.cwd + ' (want ' + FAKE_CWD + ')')
if (proj.model !== 'gpt-5-codex') throw new Error('model mismatch: ' + proj.model)
if (proj.interactionCount !== 1) throw new Error('expected 1 main interaction, got ' + proj.interactionCount)

const detail = await request('GET', `/api/projects/${proj.projectId}`)
if (detail.status !== 200) throw new Error('detail status ' + detail.status)
if (detail.body.project.primaryAgent !== 'codex-cli') {
  throw new Error('primaryAgent mismatch: ' + detail.body.project.primaryAgent)
}
const messages = detail.body.messages
if (messages.length !== 1) throw new Error('expected 1 message, got ' + messages.length)
const stub = messages[0].interactions[0]
if (stub.agentType !== 'codex-cli') throw new Error('stub agentType mismatch')
if (stub.toolCount !== 1) throw new Error('expected toolCount=1, got ' + stub.toolCount)
if (stub.stopReason !== 'tool_use') throw new Error('expected stopReason=tool_use (mapped), got ' + stub.stopReason)

const full = await request('GET', `/api/projects/${proj.projectId}/interactions/${stub.interactionId}`)
if (full.status !== 200) throw new Error('full status ' + full.status)
if (full.body.agentType !== 'codex-cli') throw new Error('full agentType mismatch')
const resp = full.body.response
if (!resp || resp.id !== 'resp_smoke_1') throw new Error('response.id mismatch: ' + JSON.stringify(resp))
if (!Array.isArray(resp.output) || resp.output.length !== 2) {
  throw new Error('expected output length 2, got ' + JSON.stringify(resp.output))
}
if (resp.output[0].type !== 'message' || resp.output[1].type !== 'function_call') {
  throw new Error('output order/types wrong: ' + JSON.stringify(resp.output.map((o) => o.type)))
}
if (resp.usage?.input_tokens !== 42) throw new Error('usage mismatch')

log('OK — Codex traffic captured end-to-end:')
log('  projectId =', proj.projectId)
log('  cwd       =', proj.cwd)
log('  model     =', proj.model)
log('  agent     =', proj.agentType)
log('  output    =', resp.output.length, 'items')
log('  usage     =', JSON.stringify(resp.usage))

// 5. Regression: same proxy must still capture Anthropic Messages
// traffic correctly. We swap the upstream to mimic api.anthropic.com
// and fire a streaming /v1/messages request with a cwd embedded in
// the system prompt.
log('regression: anthropic capture against same proxy...')
const ANTH_CWD = '/private/var/anthropic-smoke/' + Math.random().toString(36).slice(2, 8)
const anthropicUpstream = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    res.statusCode = 404
    res.end()
    return
  }
  const cs = []
  req.on('data', (c) => cs.push(c))
  req.on('end', async () => {
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    write('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_anth_1', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-test',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    })
    write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ack' } })
    write('content_block_stop', { type: 'content_block_stop', index: 0 })
    write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    write('message_stop', { type: 'message_stop' })
    res.end()
  })
})
const ANTH_PORT = 18292
await new Promise((r) => anthropicUpstream.listen(ANTH_PORT, '127.0.0.1', r))
// Override the env var live — proxy reads on each request.
process.env.AGENTMIND_UPSTREAM_ANTHROPIC = `http://127.0.0.1:${ANTH_PORT}`
// But the proxy reads its own process.env, not ours. We have to
// restart the CLI with the new env. For this smoke we instead
// shortcut: kill + relaunch with the env set.
cli.kill('SIGINT')
await delay(200)
const cli2 = spawn(process.execPath, [resolve(repo, 'bin', 'cli.js'),
  '--port', String(PROXY_PORT),
  '--data', dataDir,
  '--no-open',
], {
  cwd: repo,
  env: {
    ...process.env,
    AGENTMIND_UPSTREAM_OPENAI: `http://127.0.0.1:${UPSTREAM_PORT}`,
    AGENTMIND_UPSTREAM_ANTHROPIC: `http://127.0.0.1:${ANTH_PORT}`,
    AGENTMIND_VERBOSE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let cli2Ready = false
cli2.stdout.on('data', (d) => {
  const t = d.toString()
  if (t.includes('agentmind-cli ready')) cli2Ready = true
})
for (let i = 0; i < 50 && !cli2Ready; i++) await delay(100)
if (!cli2Ready) throw new Error('CLI never came back up')

const anthropicBody = {
  model: 'claude-3-5-sonnet-test',
  max_tokens: 100,
  stream: true,
  system: `You are Claude. cwd: ${ANTH_CWD}`,
  tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'hi' }],
}
const anthropicPost = await streamPost('/v1/messages', anthropicBody)
if (anthropicPost.status !== 200) throw new Error('proxy returned ' + anthropicPost.status)
if (!anthropicPost.sse.includes('message_stop')) throw new Error('SSE missing message_stop')

await delay(150)
const list2 = await request('GET', '/api/projects')
if (list2.body.length !== 2) {
  throw new Error('expected 2 projects after anthropic call, got ' + list2.body.length)
}
const anthropicProj = list2.body.find((p) => p.agentType === 'claude-code')
if (!anthropicProj) throw new Error('claude-code project not found')
if (anthropicProj.cwd !== ANTH_CWD) throw new Error('anthropic cwd mismatch: ' + anthropicProj.cwd)
log('OK — Anthropic regression passes:')
log('  projectId =', anthropicProj.projectId)
log('  cwd       =', anthropicProj.cwd)
log('  agent     =', anthropicProj.agentType)

cli2.kill('SIGINT')
upstream.close()
anthropicUpstream.close()
await delay(50)
rmSync(dataDir, { recursive: true, force: true })
process.exit(0)
