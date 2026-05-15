<div align="center">

# AgentMind

### A live window into your agent's mind.

Watch every thought, tool call and reply your coding agent makes — in real time, on your laptop, with zero cloud.

[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![react](https://img.shields.io/badge/react-19-149eca?logo=react&logoColor=white)](https://react.dev)
[![tanstack](https://img.shields.io/badge/TanStack-Start-ff4154)](https://tanstack.com/start)
[![tailwind](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

<br />

![AgentMind hero](docs/images/hero.png)

</div>

---

## Why?

Claude Code, Codex CLI and friends do _a lot_ between you pressing Enter and
the final reply: read files, run shell commands, reason out loud, retry,
backtrack. The terminal only shows you the polished, redacted top layer.

**AgentMind sits between your agent and the LLM**, so it sees the full
unredacted truth — every request payload, every SSE chunk, every
`tool_use`/`tool_result` pair, every `thinking` block — and lays it out as a
three-pane inspector you can read like a code editor.

Use it to:

- **Debug "why did my agent do _that_?"** — see the exact tool args, the
  thinking that led there, the previous turn's `tool_result` it was
  reacting to.
- **Audit context bloat** — the request shows the full system prompt, every
  tool's JSON Schema, every cached message, and how much each iteration
  inherits.
- **Learn how good agents are built** — flip through Claude Code's real
  prompts and tool definitions, side-by-side with the responses they produce.
- **Replay a project offline** — everything is captured as plain JSONL on
  your disk; no telemetry, no account, no cloud.

## Quick start

```bash
npm install -g agentmind-cli

# Launch your agent through AgentMind — one command, zero config,
# no API keys required.
agentmind-cli claude           # or: agentmind-cli claude "fix the build"
agentmind-cli codex            # or: agentmind-cli codex exec "ship the PR"
```

That's it. AgentMind boots the dashboard, opens it in your browser,
injects the right env / config so your agent talks to the proxy, and
hands the terminal off to the agent's TUI. Every prompt you type shows
up in the dashboard as a new project — live, while the agent is still
streaming. When the agent exits the dashboard keeps running so you can
browse the captured trace. Hit Ctrl+C to stop AgentMind.

> Both agents work with their **existing logins** — `claude login` for
> Claude Code, `codex login` for Codex CLI. No API key wrangling. The
> proxy sniffs the auth flavor (ChatGPT OAuth vs `sk-…`) and forwards
> to the correct upstream automatically.

> Anything after the subcommand is forwarded verbatim to the agent, so
> wrappers like `agentmind-cli codex --model gpt-5 --resume` just work.

Prefer `npx`?

```bash
npx agentmind-cli codex
```

### Just want the dashboard?

```bash
agentmind-cli                  # dashboard on http://127.0.0.1:8088
agentmind-cli --port 9090      # custom port
agentmind-cli --no-open        # don't auto-open the browser
```

Then start your agent yourself — see [Manual setup](#manual-setup) below.

**Supported agents** (v0.2):

| Agent      | Upstream                | Proxy endpoint we capture | Launcher           |
| ---------- | ----------------------- | ------------------------- | ------------------ |
| Claude Code| `api.anthropic.com`     | `POST /v1/messages`       | `agentmind-cli claude` |
| Codex CLI  | `api.openai.com`        | `POST /v1/responses`      | `agentmind-cli codex`  |

Both agents land in the same cwd-keyed project (so if you switch between
them in one directory, you see both threads against the same workspace).
The sidebar tags non-default agents with a small `codex` chip so a mixed
inbox stays scannable.

Flags (must come BEFORE the subcommand):

| Flag             | Default       | Notes                                      |
| ---------------- | ------------- | ------------------------------------------ |
| `--port <n>`     | `8088`        | Listen port (and the URL we hand the agent) |
| `--data <dir>`   | `~/.agentmind` | Where the JSONL projects live              |
| `--no-open`      | _off_         | Skip the auto-open browser step            |

Run `agentmind-cli --help` for the full reference.

## The three panes

<div align="center">
  <img src="docs/images/hero.png" alt="Expanded request / response view" width="100%" />
</div>

1. **Projects** _(left)_ — one card per `cwd` you ran an agent in. Cards
   show the working directory, how long ago you were there, message count,
   total LLM round-trips, and a compact token tally.
2. **Messages** _(middle)_ — one card per prompt you typed. Each card shows
   how many iterations the agent ran to satisfy it and whether it finished
   cleanly.
3. **Conversation** _(right, the centerpiece)_ — one expandable card per
   HTTP round-trip:
   - **REQUEST** — system prompt, full tool JSON Schemas, the `messages`
     array. New messages added this iteration are tagged `new`, so context
     growth is obvious.
   - **EXECUTE TOOLS** — the in-between segment that runs _locally_
     between two API calls. Tool name, arguments, duration, success/error.
   - **RESPONSE** — `thinking`, `text`, `tool_use` blocks rendered as the
     model emitted them, with token counts and stop reason.

## Live streaming

Open a card while the agent is mid-thought — the **RESPONSE** panel fills in
as SSE chunks arrive (token-by-token text, tool args growing one delta at a
time), and the **REQUEST** panel refreshes when the round-trip is sealed.
A pulsing `streaming` badge and a live-ticking duration timer make the state
unambiguous.

## What gets stored, where

All capture is local-first JSONL — never leaves your machine.

```
~/.agentmind/
└── projects/
    └── <projectId>.jsonl     # projectId = sha256(cwd).slice(0,16)
```

One file per cwd — every `claude` run in the same directory, across
days and proxy restarts, appends to the same file. Each line is one
JSON record:

| `type`        | When written                              | Purpose                          |
| ------------- | ----------------------------------------- | -------------------------------- |
| `project`     | first time a `cwd` is seen                | project metadata                 |
| `message`     | once per user prompt                      | groups iterations                |
| `interaction` | twice per HTTP round-trip (start + final) | last-wins merge on `interactionId` |

API keys in captured headers are redacted to `sk-…NNNN` — you can safely
share a JSONL with a teammate without leaking your key.

## Privacy & safety

- **Local only.** AgentMind binds to `127.0.0.1`. There is no outbound
  traffic except the proxied call to `api.anthropic.com` your agent was
  going to make anyway.
- **No telemetry.** Not now, not later. The only network calls are the ones
  you can see in the inspector.
- **Read-only on disk.** Captured JSONL is append-only; AgentMind never
  edits or deletes files you didn't ask it to.

## Supported agents

| Agent                            | Status                                |
| -------------------------------- | ------------------------------------- |
| Claude Code                      | First-class, fully tested — `agentmind-cli claude` |
| Claude SDK / API direct callers  | Works — see [Manual setup](#manual-setup) |
| Codex CLI                        | First-class (v0.2+) — `agentmind-cli codex` |
| OpenCode                         | Roadmap                               |
| Codex Desktop / Claude Desktop   | Not yet (no documented proxy hook)    |

Anything that speaks the Anthropic Messages API (`POST /v1/messages`)
or the OpenAI Responses API (`POST /v1/responses`) is captured today.
Adding a third protocol is one `ProtocolAdapter` away — see
`src/server/adapters.ts`.

## Manual setup

You don't have to use the launchers — `agentmind-cli` (no subcommand)
just runs the dashboard, and you can point any agent at it yourself.

### Claude Code

Set one env var:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude
```

### Codex CLI

Codex needs an explicit provider entry because two defaults work
against us:

1. **`OPENAI_BASE_URL` alone is not enough.** Codex CLI v0.118+ defaults
   to ChatGPT OAuth login. That auth flow ignores the env var and
   routes through `chatgpt.com/backend-api/codex/`. The fix is
   `requires_openai_auth = true`, which keeps Codex's normal auth
   selection (cached ChatGPT login *or* `OPENAI_API_KEY`) but forces
   the request through our `base_url`.
2. **WebSocket transport is preferred.** Codex tries `wss://…/responses`
   first and only falls back to HTTP/SSE after a 5×15s retry budget
   (~75s). AgentMind only speaks HTTP/SSE, so `supports_websockets =
   false` is required.

Easiest is one-shot `-c` overrides — same recipe `agentmind-cli codex`
uses internally:

```bash
codex \
  -c 'model_provider="agentmind"' \
  -c 'model_providers.agentmind.base_url="http://127.0.0.1:8088/v1"' \
  -c 'model_providers.agentmind.requires_openai_auth=true' \
  -c 'model_providers.agentmind.wire_api="responses"' \
  -c 'model_providers.agentmind.supports_websockets=false'
```

Or persist the provider in `~/.codex/config.toml`:

```toml
model_provider = "agentmind"

[model_providers.agentmind]
name = "AgentMind"
base_url = "http://127.0.0.1:8088/v1"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false
```

No API key wrangling either way — Codex sends whichever bearer it
already has (`codex login` or `OPENAI_API_KEY`), and AgentMind
dispatches it to the right upstream:

- **`Bearer eyJ…`** (ChatGPT OAuth JWT) → `chatgpt.com/backend-api/codex/responses`
- **`Bearer sk-…`** (platform API key) → `api.openai.com/v1/responses`

> If you forget `supports_websockets = false`, AgentMind replies `426
> Upgrade Required` to every WebSocket handshake with a hint pointing
> back here, so you'll see the problem instantly in the server logs.

## Tech stack

- **TanStack Start** (Vite-based SSR) · **React 19** · **TanStack Router**
- **Tailwind v4** · **shadcn/ui** · **lucide-react** · **@uiw/react-json-view**
- **undici** for upstream HTTP forwarding with full SSE pass-through
- **pnpm** · **TypeScript 5.7**

## Project layout

```
src/
├── routes/                       file-based routes
│   ├── __root.tsx                three-pane shell + header
│   ├── projects.$pid.tsx         project column wiring
│   └── projects.$pid.messages.$mid.tsx
│                                 message detail (the inspector)
├── components/
│   ├── ProjectsSidebar.tsx       left pane (projects)
│   ├── MessagesPane.tsx          middle pane (prompts)
│   ├── MessageDetail.tsx         right pane wrapper
│   ├── InteractionCard.tsx       one HTTP round-trip card
│   ├── RequestPanel.tsx          request rendering + diff badges
│   ├── ResponsePanel.tsx         response rendering (thinking/text/tool_use)
│   ├── ActionExecutionSegment.tsx local tool execution between calls
│   └── ui/                       shadcn primitives + JSON dialog
├── lib/
│   ├── anthropic-types.ts        Anthropic Messages API schema
│   ├── openai-responses-types.ts OpenAI Responses API schema (Codex)
│   └── api.ts                    typed fetch + subscribeLive helper
└── server/                       pure node, no React
    ├── adapters.ts               protocol adapters (one per agent)
    ├── middleware.ts             Connect middleware (mounted in vite.config.ts)
    ├── proxy.ts                  generic forwarder + SSE tee (per adapter)
    ├── liveRegistry.ts           in-memory live-streaming sessions
    ├── grouping.ts               cwd-based project/message inference
    ├── aggregate.ts              raw capture → display model
    ├── interaction-view.ts       per-protocol view extractors
    ├── sse.ts                    Anthropic SSE parser
    ├── responses-sse.ts          OpenAI Responses SSE parser
    └── storage.ts                JSONL persistence

bin/cli.js                        global `agentmind-cli` entry
```

## Development

```bash
pnpm install
pnpm dev          # http://127.0.0.1:8088 with HMR (uses vite)
pnpm typecheck    # strict tsc --noEmit
pnpm build        # produces dist/ — what npm publishes
pnpm start        # run the production bundle locally (no vite)
```

The published package ships a prebuilt `dist/` — end users running
`npx agentmind-cli` never touch vite, tsx, or any dev dependency. The CLI
boots a plain `node:http` server in under 100ms.

Optional env vars (testing/dev only — not user-facing):

| Var                                  | Default                                  | Effect                                          |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| `AGENTMIND_DATA_DIR`                 | `~/.agentmind`                           | Override storage directory                      |
| `AGENTMIND_UPSTREAM_ANTHROPIC`       | `https://api.anthropic.com`              | Override Anthropic upstream (test harness)      |
| `AGENTMIND_UPSTREAM_OPENAI`          | `https://api.openai.com`                 | Override OpenAI API-key upstream (test harness) |
| `AGENTMIND_UPSTREAM_OPENAI_CHATGPT`  | `https://chatgpt.com/backend-api/codex`  | Override ChatGPT-OAuth upstream (test harness)  |
| `AGENTMIND_UPSTREAM`                 | _(unset)_                                | Legacy alias for `AGENTMIND_UPSTREAM_ANTHROPIC` |
| `AGENTMIND_VERBOSE`                  | `1`                                      | Set to `0` to silence per-request logs          |

## Roadmap

- [x] OpenAI Responses API capture (Codex CLI) — v0.2
- [ ] Codex CLI: action segments (function_call → function_call_output pairing)
- [ ] Codex CLI: helper-call filtering (compaction summariser)
- [ ] OpenCode CLI adapter
- [ ] Cross-project search & filters
- [ ] Diff view between adjacent iterations' transcripts
- [ ] Shareable "trace bundles" (export a sanitized project as a tarball)

## Contributing

Issues and PRs welcome at [imsobear/agentmind](https://github.com/imsobear/agentmind).
If you're hunting for something to do, the roadmap items above all have
clean entry points — happy to mentor you through any of them.

## License

MIT
