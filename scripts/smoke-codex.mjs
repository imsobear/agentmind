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
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const here = resolve(fileURLToPath(import.meta.url), '..')
const repo = resolve(here, '..')

const UPSTREAM_PORT = 18290
const PROXY_PORT = 18291
const CHATGPT_UPSTREAM_PORT = 18294
const FAKE_CWD = '/private/var/codex-smoke/' + Math.random().toString(36).slice(2, 8)
const dataDir = mkdtempSync(join(tmpdir(), 'agentmind-codex-smoke-'))

function log(...a) {
  process.stdout.write(`[smoke] ${a.join(' ')}\n`)
}

// 1. Stub upstream — mirrors POST /v1/responses with a canned stream.
//    Important: this stub matches the REAL wire shape Codex/ChatGPT
//    actually emit, which is *more sparse* than the OpenAI docs:
//      * events do NOT carry `output_index` (only `item_id`)
//      * `response.completed` does NOT carry `output[]` — only the
//        envelope metadata (`id`, `usage`, `status`). The actual
//        output is the union of preceding `output_item.done` events.
//    If you reintroduce `output_index` or a populated
//    `response.completed.output` you'll mask the accumulator bugs this
//    file was written to catch.
//
// Behaviour branches on whether the incoming request contains any
// `function_call_output` in `input[]`:
//   - First turn (no tool result yet) → emit [message, function_call]
//     so the agent must execute a tool and come back with the output.
//   - Second turn (carries the result) → emit a final [message] with no
//     more tool calls, so action segment computation has a complete
//     iter1 → iter2 pair to render.
const upstream = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.statusCode = 404
    res.end()
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    let isFollowUp = false
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      isFollowUp = Array.isArray(body.input)
        && body.input.some((i) => i && i.type === 'function_call_output')
    } catch {}
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    if (isFollowUp) {
      write({
        type: 'response.created',
        response: { id: 'resp_smoke_2', model: 'gpt-5-codex', status: 'in_progress' },
      })
      await delay(10)
      write({
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_smoke_2', role: 'assistant', content: [] },
      })
      write({ type: 'response.output_text.delta', item_id: 'msg_smoke_2', delta: 'Done. ' })
      write({ type: 'response.output_text.delta', item_id: 'msg_smoke_2', delta: 'Bye.' })
      write({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'msg_smoke_2',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done. Bye.' }],
        },
      })
      write({
        type: 'response.completed',
        response: {
          id: 'resp_smoke_2',
          object: 'response',
          model: 'gpt-5-codex',
          status: 'completed',
          usage: { input_tokens: 50, output_tokens: 3, total_tokens: 53 },
        },
      })
      res.end()
      return
    }
    write({
      type: 'response.created',
      response: { id: 'resp_smoke_1', model: 'gpt-5-codex', status: 'in_progress' },
    })
    await delay(20)
    write({
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_smoke_1', role: 'assistant', content: [] },
    })
    write({ type: 'response.output_text.delta', item_id: 'msg_smoke_1', delta: 'Hello ' })
    write({ type: 'response.output_text.delta', item_id: 'msg_smoke_1', delta: 'from Codex.' })
    await delay(10)
    write({
      type: 'response.output_item.done',
      item: {
        type: 'message',
        id: 'msg_smoke_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from Codex.' }],
      },
    })
    write({
      type: 'response.output_item.added',
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
      item_id: 'fc_smoke_1',
      delta: '{"command":["echo",',
    })
    write({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_smoke_1',
      delta: '"hi"]}',
    })
    write({
      type: 'response.output_item.done',
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
        // Deliberately no `output` field — matches chatgpt.com/
        // backend-api/codex and forces the accumulator to materialise
        // output from the preceding `output_item.done` events.
        usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
      },
    })
    res.end()
  })
})
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))
log('upstream stub listening on', UPSTREAM_PORT)

// 1b. Second stub pretending to be chatgpt.com/backend-api/codex —
//     this is where Codex CLI's ChatGPT-OAuth traffic gets routed
//     when the proxy sees a JWT-shaped bearer token. The path
//     differs (`/responses` instead of `/v1/responses`) — that's
//     exactly the routing decision we're trying to verify.
let chatGptHits = 0
const chatGptStub = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/responses') {
    res.statusCode = 404
    res.end()
    return
  }
  chatGptHits++
  // Drain body and reply with a minimal completed-response SSE.
  req.on('data', () => {})
  req.on('end', async () => {
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    write({
      type: 'response.created',
      response: { id: 'resp_chatgpt_1', model: 'gpt-5-codex', status: 'in_progress' },
    })
    await delay(10)
    write({
      type: 'response.completed',
      response: {
        id: 'resp_chatgpt_1',
        object: 'response',
        model: 'gpt-5-codex',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_chatgpt_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello from chatgpt route' }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      },
    })
    res.end()
  })
})
await new Promise((r) => chatGptStub.listen(CHATGPT_UPSTREAM_PORT, '127.0.0.1', r))
log('chatgpt-route stub listening on', CHATGPT_UPSTREAM_PORT)

// 1b. Plant a legacy mixed-agent project file BEFORE the CLI starts,
//     so the storage migration runs on it at boot. We use the pre-0.2.2
//     id scheme (sha(cwd) only) which the migration is supposed to
//     detect and split per-agent.
//
// We compute the legacy id by running the same hash the OLD code used,
// inline — that way this test stays standalone and doesn't depend on
// the runtime still exporting the legacy helper.
{
  const { createHash } = await import('node:crypto')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const projectsDir = join(dataDir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  const LEGACY_CWD = '/private/var/agentmind-legacy-smoke/mixed'
  const legacyId = createHash('sha256').update(LEGACY_CWD).digest('hex').slice(0, 16)
  const lines = [
    JSON.stringify({
      type: 'project', projectId: legacyId, cwd: LEGACY_CWD,
      startedAt: '2025-01-01T00:00:00.000Z', primaryAgent: 'claude-code',
    }),
    JSON.stringify({
      type: 'message', projectId: legacyId, messageId: 'msg-cc', index: 0,
      startedAt: '2025-01-01T00:00:01.000Z', firstUserText: 'claude side',
    }),
    JSON.stringify({
      type: 'interaction', projectId: legacyId, messageId: 'msg-cc',
      interactionId: 'it-cc', index: 0, agentType: 'claude-code',
      startedAt: '2025-01-01T00:00:01.500Z',
      request: { model: 'claude-3-5', messages: [{ role: 'user', content: 'hi' }] },
    }),
    JSON.stringify({
      type: 'message', projectId: legacyId, messageId: 'msg-cx', index: 1,
      startedAt: '2025-01-01T00:01:00.000Z', firstUserText: 'codex side',
    }),
    JSON.stringify({
      type: 'interaction', projectId: legacyId, messageId: 'msg-cx',
      interactionId: 'it-cx', index: 0, agentType: 'codex-cli',
      startedAt: '2025-01-01T00:01:00.500Z',
      request: { model: 'gpt-5-codex', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    }),
    '',
  ]
  writeFileSync(join(projectsDir, `${legacyId}.jsonl`), lines.join('\n'))
  log('planted legacy mixed-agent file', `${legacyId}.jsonl`, 'cwd=', LEGACY_CWD)
  // Stash for the post-boot assertion below.
  globalThis.__legacy = { legacyId, cwd: LEGACY_CWD }
}

// 2. Boot agentmind-cli pointed at BOTH stubs.
// `--no-agent` is the 0.2.1 way to ask for dashboard-only mode. Without
// it the CLI would try to launch claude, which (a) we don't want here
// — these tests drive the HTTP proxy directly with stub bodies, not a
// real agent — and (b) would fail immediately on a CI runner that has
// no `claude` binary or no stdin attached.
const cli = spawn(process.execPath, [resolve(repo, 'bin', 'cli.js'),
  '--port', String(PROXY_PORT),
  '--data', dataDir,
  '--no-agent',
  '--no-open',
], {
  cwd: repo,
  env: {
    ...process.env,
    AGENTMIND_UPSTREAM_OPENAI: `http://127.0.0.1:${UPSTREAM_PORT}`,
    AGENTMIND_UPSTREAM_OPENAI_CHATGPT: `http://127.0.0.1:${CHATGPT_UPSTREAM_PORT}`,
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

// Migration smoke: the legacy mixed-agent file planted above MUST have
// been split into one (cwd, agent) file per agent at Storage boot.
{
  const { readdirSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const projectsDir = join(dataDir, 'projects')
  const { legacyId, cwd } = globalThis.__legacy
  if (existsSync(join(projectsDir, `${legacyId}.jsonl`))) {
    throw new Error('legacy file was not removed after migration: ' + legacyId)
  }
  const { createHash } = await import('node:crypto')
  const newCcId = createHash('sha256').update(cwd).update('\0').update('claude-code').digest('hex').slice(0, 16)
  const newCxId = createHash('sha256').update(cwd).update('\0').update('codex-cli').digest('hex').slice(0, 16)
  const names = new Set(readdirSync(projectsDir))
  if (!names.has(`${newCcId}.jsonl`)) {
    throw new Error('migration did not produce claude file ' + newCcId)
  }
  if (!names.has(`${newCxId}.jsonl`)) {
    throw new Error('migration did not produce codex file ' + newCxId)
  }
  log('OK — legacy mixed-agent file split on boot:')
  log('  claude id =', newCcId)
  log('  codex  id =', newCxId)
}

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

// 4c. Action segments — fire a follow-up turn carrying the
//     `function_call_output` for the iter1 shell call so the aggregator
//     can pair iter1's tool call with iter2's result and emit one
//     ActionSegment. This is the "Execute tools" overview the UI
//     renders between adjacent iteration cards.
log('action segment (iter1 -> iter2) check...')
const followUpBody = {
  ...codexBody,
  input: [
    ...codexBody.input,
    {
      type: 'function_call_output',
      call_id: 'call_smoke_1',
      output: JSON.stringify({
        output: 'hi\n',
        metadata: { exit_code: 0, duration_seconds: 0.01 },
      }),
    },
  ],
}
const post2 = await streamPost('/v1/responses', followUpBody)
if (post2.status !== 200) throw new Error('iter2 proxy returned ' + post2.status)
await delay(150)
const detail2 = await request('GET', `/api/projects/${proj.projectId}`)
if (detail2.status !== 200) throw new Error('detail2 status ' + detail2.status)
const msg = detail2.body.messages[0]
if (!msg) throw new Error('no aggregated message after iter2')
if (msg.interactions.length !== 2) {
  throw new Error('expected 2 interactions after iter2, got ' + msg.interactions.length)
}
const segs = msg.actionSegments ?? []
if (segs.length !== 1) {
  throw new Error('expected 1 actionSegment, got ' + JSON.stringify(segs))
}
const seg = segs[0]
if (seg.actions.length !== 1) throw new Error('expected 1 action in segment')
const action = seg.actions[0]
if (action.toolUseId !== 'call_smoke_1') throw new Error('toolUseId mismatch: ' + action.toolUseId)
if (action.name !== 'shell') throw new Error('action.name mismatch: ' + action.name)
// Shell envelope unwrapping — preview should be the inner `output`,
// not the JSON-stringified wrapper.
if (action.resultPreview !== 'hi\n') {
  throw new Error('expected resultPreview="hi\\n", got: ' + JSON.stringify(action.resultPreview))
}
if (action.isError) throw new Error('exit_code=0 should not mark error')
if (seg.pending) throw new Error('segment must not be pending — iter2 captured')
log('OK — action segment paired iter1 function_call -> iter2 function_call_output')
log('  action    = shell -> "hi"')

// 4a. ChatGPT-OAuth routing. When the incoming Authorization header
//     carries a JWT-shaped bearer (real users get this from
//     `codex login`), the proxy must route to the chatgpt.com path
//     instead of api.openai.com. We send a request with a fake JWT
//     and verify it lands on the chatgpt stub, not the openai one.
log('OAuth (JWT) -> chatgpt.com routing check...')
const openaiHitsBefore = 0 // not tracked; we use chatGptHits delta to assert
const chatGptHitsBefore = chatGptHits
const FAKE_JWT_CWD = '/private/var/codex-oauth-smoke/' + Math.random().toString(36).slice(2, 8)
const oauthRes = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    // `eyJ…` is a valid JWT header prefix (`{` base64-encoded). The
    // proxy uses ONLY this prefix to disambiguate from `sk-…`.
    authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.fakeBody.fakeSig',
  },
  body: JSON.stringify({
    ...codexBody,
    // Different cwd so this lands in a fresh project we can spot.
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              '<environment_context>\n' +
              `  <cwd>${FAKE_JWT_CWD}</cwd>\n` +
              '  <shell>zsh</shell>\n' +
              '</environment_context>',
          },
        ],
      },
    ],
  }),
})
// Drain.
const _oauthReader = oauthRes.body.getReader()
while (true) {
  const { done } = await _oauthReader.read()
  if (done) break
}
await delay(100)
if (oauthRes.status !== 200) throw new Error('OAuth path returned ' + oauthRes.status)
if (chatGptHits !== chatGptHitsBefore + 1) {
  throw new Error(
    `OAuth routing wrong: chatgpt stub hits ${chatGptHitsBefore} -> ${chatGptHits} (want +1)`,
  )
}
const listAfterOAuth = await request('GET', '/api/projects')
const oauthProj = listAfterOAuth.body.find((p) => p.cwd === FAKE_JWT_CWD)
if (!oauthProj) throw new Error('OAuth-route project not captured')
log('OK — OAuth (JWT) routed to chatgpt.com path; project captured:')
log('  cwd =', oauthProj.cwd)

// 4b. WebSocket upgrade must be refused with 426 + a hint body. Codex
//     CLI defaults to WS transport for the Responses API; without this
//     rejection the agent stalls for ~75s before falling back to HTTP
//     and the user thinks AgentMind is broken. We send a raw handshake
//     on a fresh socket and assert the response.
log('WS upgrade rejection check...')
await new Promise((resolve, reject) => {
  const sock = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
    sock.write(
      'GET /v1/responses HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${PROXY_PORT}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
    )
  })
  const chunks = []
  sock.on('data', (c) => chunks.push(c))
  sock.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.startsWith('HTTP/1.1 426')) {
      reject(new Error('expected 426 Upgrade Required, got: ' + text.slice(0, 80)))
      return
    }
    if (!text.toLowerCase().includes('supports_websockets')) {
      reject(new Error('WS refusal body missing hint about supports_websockets'))
      return
    }
    log('  WS upgrade -> 426 Upgrade Required (with config hint)')
    resolve()
  })
  sock.on('error', reject)
  sock.setTimeout(5000, () => {
    sock.destroy(new Error('WS check timed out'))
  })
})

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
  '--no-agent',
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
// 3 projects expected: codex-apikey path + codex-oauth path + anthropic.
// The two split-from-legacy projects exist on disk but their planted
// interactions carry no tools (= no main interactions) so the default
// `messageCount > 0` filter hides them. They're verified separately
// via the filesystem assertion above and the showAll listing below.
if (list2.body.length !== 3) {
  throw new Error(
    'expected 3 projects after anthropic call, got ' +
      list2.body.length +
      ': ' +
      JSON.stringify(list2.body.map((p) => `${p.cwd}|${p.agentType}`)),
  )
}
const anthropicProj = list2.body.find((p) => p.agentType === 'claude-code')
if (!anthropicProj) throw new Error('claude-code project not found')
if (anthropicProj.cwd !== ANTH_CWD) throw new Error('anthropic cwd mismatch: ' + anthropicProj.cwd)
log('OK — Anthropic regression passes:')
log('  projectId =', anthropicProj.projectId)
log('  cwd       =', anthropicProj.cwd)
log('  agent     =', anthropicProj.agentType)

// 6. Noise filters. Two paths to verify in one shot:
//    a) `isMainInteractionFor` rejects Claude Code's framework-internal
//       prompts (suggestion-mode / recap / compaction). The captured
//       project ends up with messageCount=0 main interactions and
//       isn't surfaced in the sidebar.
//    b) `/api/projects` hides such empty projects by default, but
//       returns them with `?showAll=1` so a debug deep-link still works.
log('noise filter checks (framework-internal prompts + ?showAll)...')
const NOISE_CWD = '/private/var/agentmind-noise-smoke/' + Math.random().toString(36).slice(2, 8)
const noisePost = await streamPost('/v1/messages', {
  model: 'claude-3-5-sonnet-test',
  max_tokens: 100,
  stream: true,
  // Same shape as the regression call above but with the
  // recap-after-idle prompt Claude Code emits when the user comes back
  // from a coffee break — should be filtered out.
  system: `You are Claude. cwd: ${NOISE_CWD}`,
  tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object' } }],
  messages: [
    {
      role: 'user',
      content:
        'The user stepped away and is coming back. Recap in under 40 words, ' +
        '1-2 plain sentences, no markdown. Lead with the task.',
    },
  ],
})
if (noisePost.status !== 200) throw new Error('noise call proxy returned ' + noisePost.status)
await delay(150)
const listDefault = await request('GET', '/api/projects')
// Default list: 3 substantive projects (noise project + migrated empty
// projects all hidden by the messageCount filter).
if (listDefault.body.length !== 3) {
  throw new Error(
    'expected 3 projects in filtered list, got ' +
      listDefault.body.length +
      ': ' +
      JSON.stringify(listDefault.body.map((p) => p.cwd)),
  )
}
if (listDefault.body.some((p) => p.cwd === NOISE_CWD)) {
  throw new Error('framework-internal project leaked into default list')
}
// showAll: noise project + the two migrated legacy halves all show up.
const listAll = await request('GET', '/api/projects?showAll=1')
if (listAll.body.length !== 6) {
  throw new Error(
    'expected 6 projects with showAll=1, got ' +
      listAll.body.length +
      ': ' +
      JSON.stringify(listAll.body.map((p) => p.cwd)),
  )
}
const noiseProj = listAll.body.find((p) => p.cwd === NOISE_CWD)
if (!noiseProj) throw new Error('noise project missing from showAll list')
if (noiseProj.messageCount !== 0) {
  throw new Error(
    'expected noise project messageCount=0 (framework prompt filtered), got ' +
      noiseProj.messageCount,
  )
}
log('OK — framework-internal prompt filtered:')
log('  default list  =', listDefault.body.length, 'projects')
log('  showAll list  =', listAll.body.length, 'projects (',
  listAll.body.length - listDefault.body.length, 'hidden)')
log('  noise project = messageCount=0 on disk, visible via showAll')

// 7. Restart the CLI with the codex upstream re-pointed at the stub so
//    we can exercise the Responses path again (the anthropic-only
//    cli2 above has codex routing to a stale env). Re-using the
//    existing cli2 process is fine — its AGENTMIND_UPSTREAM_OPENAI
//    still points at UPSTREAM_PORT.
//
// AGENTS.md-shadowing regression. The Responses extractor used to
// match the FIRST `<cwd>…</cwd>` it saw anywhere in the request,
// which got fooled by repos whose AGENTS.md happened to document
// the extractor with a literal example. Posting a request whose
// `input[]` carries an AGENTS.md-flavoured text BEFORE the real
// `<environment_context>` block is enough to lock the project onto
// the literal `…` cwd. Verify the regex now requires the env_context
// container.
log('AGENTS.md shadowing regression (env_context-scoped cwd extractor)...')
const SHADOW_CWD = '/private/var/codex-shadow-smoke/' + Math.random().toString(36).slice(2, 8)
const shadowBody = {
  model: 'gpt-5-codex',
  instructions: 'You are Codex.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          // Mimic AGENTS.md content quoting the extractor regex.
          // Pre-fix, this `<cwd>…</cwd>` would win and the project
          // would anchor on cwd="…" (U+2026).
          type: 'input_text',
          text:
            '# AGENTS.md\n\nWe extract cwd via the regex matching ' +
            '`<cwd>…</cwd>` inside Codex requests.\n',
        },
      ],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            '<environment_context>\n' +
            `  <cwd>${SHADOW_CWD}</cwd>\n` +
            '  <shell>zsh</shell>\n' +
            '</environment_context>',
        },
      ],
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    },
  ],
  tools: codexBody.tools,
  tool_choice: 'auto',
  parallel_tool_calls: true,
  store: false,
  stream: true,
  include: [],
}
const shadowPost = await streamPost('/v1/responses', shadowBody)
if (shadowPost.status !== 200) throw new Error('shadow call returned ' + shadowPost.status)
await delay(150)
const listShadow = await request('GET', '/api/projects')
const shadowProj = listShadow.body.find((p) => p.cwd === SHADOW_CWD)
if (!shadowProj) {
  throw new Error(
    'env_context-scoped cwd missing from list — extractor probably ' +
      'matched AGENTS.md literal instead. cwds: ' +
      JSON.stringify(listShadow.body.map((p) => p.cwd)),
  )
}
if (listShadow.body.some((p) => p.cwd === '\u2026')) {
  throw new Error('extractor leaked U+2026 cwd despite env_context scoping')
}
log('OK — env_context scoping wins over AGENTS.md literal:')
log('  shadow project cwd =', shadowProj.cwd)

// 8. (cwd, agent) projectId scoping. Pre-0.2.2 the projectId was just
//    sha(cwd), so running both `claude` and `codex` from the same
//    directory merged their traffic into a single project — with a
//    single primaryAgent badge that lied about half the messages.
//    Verify the same cwd now yields two distinct projects.
log('cwd-agent scoping check (two agents, one cwd -> two projects)...')
const MIXED_CWD = '/private/var/agentmind-mixed-smoke/' + Math.random().toString(36).slice(2, 8)
const mixedClaudePost = await streamPost('/v1/messages', {
  model: 'claude-3-5-sonnet-test',
  max_tokens: 100,
  stream: true,
  system: `You are Claude. cwd: ${MIXED_CWD}`,
  tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'hi from claude' }],
})
if (mixedClaudePost.status !== 200) throw new Error('mixed claude returned ' + mixedClaudePost.status)
const mixedCodexBody = {
  ...codexBody,
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            '<environment_context>\n' +
            `  <cwd>${MIXED_CWD}</cwd>\n` +
            '  <shell>zsh</shell>\n' +
            '</environment_context>',
        },
      ],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi from codex' }] },
  ],
}
const mixedCodexPost = await streamPost('/v1/responses', mixedCodexBody)
if (mixedCodexPost.status !== 200) throw new Error('mixed codex returned ' + mixedCodexPost.status)
await delay(200)
const listMixed = await request('GET', '/api/projects')
const projectsAtMixedCwd = listMixed.body.filter((p) => p.cwd === MIXED_CWD)
if (projectsAtMixedCwd.length !== 2) {
  throw new Error(
    'expected 2 projects at MIXED_CWD (one per agent), got ' +
      projectsAtMixedCwd.length +
      ': ' +
      JSON.stringify(projectsAtMixedCwd.map((p) => p.agentType)),
  )
}
const agentsAtMixedCwd = new Set(projectsAtMixedCwd.map((p) => p.agentType))
if (!agentsAtMixedCwd.has('claude-code') || !agentsAtMixedCwd.has('codex-cli')) {
  throw new Error(
    'expected one claude-code and one codex-cli project at the same cwd, got: ' +
      JSON.stringify([...agentsAtMixedCwd]),
  )
}
// And the two projectIds must actually differ (otherwise they'd
// stomp each other on disk).
const [pA, pB] = projectsAtMixedCwd
if (pA.projectId === pB.projectId) {
  throw new Error('same cwd produced identical projectIds for two agents: ' + pA.projectId)
}
log('OK — (cwd, agent) scoping yields two projects:')
log('  claude project =', projectsAtMixedCwd.find((p) => p.agentType === 'claude-code').projectId)
log('  codex  project =', projectsAtMixedCwd.find((p) => p.agentType === 'codex-cli').projectId)

cli2.kill('SIGINT')
upstream.close()
chatGptStub.close()
anthropicUpstream.close()
await delay(50)
rmSync(dataDir, { recursive: true, force: true })
process.exit(0)
