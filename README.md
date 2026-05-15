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
npx agentmind-cli claude       # launch Claude Code through AgentMind
npx agentmind-cli codex        # or any codex args: …codex exec "ship the PR"
```

That's it. AgentMind boots the dashboard, injects the right env / config
so your agent talks to the proxy, and hands the terminal off to the
agent's TUI. Every prompt you type shows up in the dashboard as a new
project — live, while the agent is still streaming. When the agent
exits the dashboard keeps running so you can browse the captured trace.
Hit Ctrl+C to stop AgentMind.

> Both agents reuse their **existing logins** — `claude login` for
> Claude Code, `codex login` for Codex CLI. No API key wrangling. The
> proxy sniffs the auth flavor (ChatGPT OAuth vs `sk-…`) and forwards
> to the correct upstream automatically.
>
> Anything after the subcommand is forwarded verbatim to the agent, so
> wrappers like `npx agentmind-cli codex --model gpt-5 --resume` work.

Want it permanently on PATH? `npm i -g agentmind-cli` once, then drop
the `npx` prefix everywhere below.

### Just want the dashboard?

```bash
npx agentmind-cli --no-agent              # dashboard on http://127.0.0.1:8088
npx agentmind-cli --no-agent --port 9090  # custom port
```

Then point any agent at `http://127.0.0.1:8088` — see
[Manual setup](#manual-setup) below.

Projects are keyed by `(cwd, agent)` — running both Claude and Codex in
the same directory produces two distinct projects so each one's
conversation chain stays coherent. The sidebar tags every project with
a small agent chip (Claude = peach, Codex = lavender) so a mixed inbox
stays scannable at a glance.

Flags (must come BEFORE the subcommand):

| Flag             | Default        | Notes                                                  |
| ---------------- | -------------- | ------------------------------------------------------ |
| `--port <n>`     | `8088`         | Listen port (and the URL we hand the agent)            |
| `--data <dir>`   | `~/.agentmind` | Where the JSONL projects live                          |
| `--no-agent`     | _off_          | Skip launching an agent — dashboard only               |
| `--no-open`      | _off_          | Skip the auto-open browser step (`--no-agent` only)    |

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
    └── <projectId>.jsonl     # projectId = sha256(cwd, agent).slice(0,16)
```

One file per `(cwd, agent)` pair — every `claude` run in the same
directory appends to the Claude file for that cwd, every `codex` run
to the Codex file. Pre-0.2.0 single-cwd files are migrated to the new
scheme on first boot. Each line is one JSON record:

| `type`        | When written                              | Purpose                          |
| ------------- | ----------------------------------------- | -------------------------------- |
| `project`     | first time a `cwd` is seen                | project metadata                 |
| `message`     | once per user prompt                      | groups iterations                |
| `interaction` | twice per HTTP round-trip (start + final) | last-wins merge on `interactionId` |

API keys in captured headers are redacted to `sk-…NNNN` — you can safely
share a JSONL with a teammate without leaking your key.

## Privacy & safety

- **Local only.** AgentMind binds to `127.0.0.1`. The only outbound
  traffic is the proxied call your agent was going to make anyway —
  `api.anthropic.com` for Claude Code, `api.openai.com` or
  `chatgpt.com/backend-api/codex` for Codex CLI (we route by the
  bearer-token shape, not by config).
- **No telemetry.** Not now, not later. The only network calls are the ones
  you can see in the inspector.
- **Read-only on disk.** Captured JSONL is append-only; AgentMind never
  edits or deletes files you didn't ask it to. The one exception is the
  one-shot legacy migration at startup, which rewrites pre-0.2.0 files
  into the new `(cwd, agent)` layout — see `migrateLegacy` in
  `src/server/storage.ts`.

## Supported agents

| Agent                           | Status                                       |
| ------------------------------- | -------------------------------------------- |
| Claude Code                     | First-class — `agentmind-cli claude`         |
| Codex CLI                       | First-class — `agentmind-cli codex`          |
| Claude SDK / API direct callers | Works — see [Manual setup](#manual-setup)    |
| OpenCode                        | Roadmap                                      |
| Codex Desktop / Claude Desktop  | Not yet (no documented proxy hook)           |

Anything that speaks the Anthropic Messages API (`POST /v1/messages`)
or the OpenAI Responses API (`POST /v1/responses`) is captured.
Adding a third protocol is one `ProtocolAdapter` away — see
`src/server/adapters.ts`.

## Manual setup

Most users don't need this — `npx agentmind-cli claude` /
`npx agentmind-cli codex` handles the env/config wiring transparently.
Reach for manual setup only if you're running the dashboard with
`--no-agent` and want to start the agent yourself.

**Claude Code** — one env var:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude
```

**Codex CLI** — add a custom provider to `~/.codex/config.toml`:

```toml
model_provider = "agentmind"

[model_providers.agentmind]
name = "AgentMind"
base_url = "http://127.0.0.1:8088/v1"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false
```

`requires_openai_auth = true` keeps Codex's normal auth selection
(`codex login` OAuth *or* `OPENAI_API_KEY`) but routes through our
`base_url`. `supports_websockets = false` is required because Codex
prefers `wss://…/responses` first and AgentMind only speaks HTTP/SSE.

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
    ├── grouping.ts               (cwd, agent)-based project/message inference
    ├── projectId.ts              sha256(cwd, agent) ↔ projectId
    ├── aggregate.ts              raw capture → display model
    ├── interaction-view.ts       per-protocol view extractors
    ├── sse.ts                    Anthropic SSE parser
    ├── responses-sse.ts          OpenAI Responses SSE parser
    ├── prod-entry.ts             production CLI entrypoint (bundled into dist/)
    └── storage.ts                JSONL persistence + one-shot legacy migration

bin/cli.js                        global `agentmind-cli` entry
                                  (subcommands: `claude`, `codex`, `--no-agent`)
scripts/smoke-codex.mjs           e2e capture smoke (Codex + Anthropic + migration)
scripts/smoke-launcher.mjs        PATH-shim launcher smoke
```

## Development

```bash
pnpm install
pnpm dev          # http://127.0.0.1:8088 with HMR (uses vite)
pnpm typecheck    # strict tsc --noEmit
pnpm build        # produces dist/ — what npm publishes
pnpm start        # run the production bundle locally (no vite)
pnpm smoke        # build + end-to-end smoke (Codex + Anthropic + launcher)
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

- [x] OpenAI Responses API capture (Codex CLI) — v0.2.0
- [x] Codex CLI: action segments (function_call → function_call_output pairing) — v0.2.0
- [x] Default `agentmind-cli` to launching Claude Code — v0.2.1
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
