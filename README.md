# claude-proxy-cli

Local proxy that captures every Claude Code ↔ Anthropic API exchange and
visualises it as a three-pane web inspector. Sibling to `claude-demo` —
that one reads `~/.claude/projects/*.jsonl` after-the-fact; this one sits
between Claude Code and the API at request time, so it sees the things
the JSONL doesn't persist (full system prompt, full tool JSON Schemas,
the raw SSE stream).

## Quick start

```bash
pnpm install

# in terminal A — the proxy
pnpm dev                    # listens on http://127.0.0.1:8088

# in terminal B — point Claude Code at it
ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude
```

Each `claude` invocation becomes one **session** in the sidebar. Each
prompt you type is one **message**. Click a message to see every
HTTP round-trip Claude Code made to fulfil it — request (model, system
prompt, tools with full JSON Schema, messages) on the left, response
(thinking / text / tool_use blocks, usage, stop reason, raw SSE timeline)
on the right.

## As a global CLI

```bash
pnpm link --global
claude-proxy --help
```

This makes `claude-proxy` available everywhere. Flags:

- `--port 9000` — change listening port
- `--data <dir>` — change JSONL storage location (default `~/.claude-proxy`)
- `--no-open` — don't auto-open the browser

## Data layout

`~/.claude-proxy/sessions/<sessionId>.jsonl`. Each line is one of:

- `{ type: "session", … }` — first line of the file
- `{ type: "message", … }` — once per user prompt
- `{ type: "interaction", … }` — once per HTTP round-trip; written twice
  (start + finalised), last-wins merge on `interactionId`

API keys in the captured `requestHeaders` are redacted —
e.g. `sk-test-…7890`.

## Stack

- TanStack Start (Vite-based SSR) · React 19 · TanStack Router (file-based)
- Tailwind v4 · shadcn/ui (new-york) · lucide-react · date-fns
- undici (upstream HTTP forwarding with SSE pass-through)
- pnpm · TypeScript 5.9

## Layout

```
src/
├── routes/                       file-based routes
│   ├── __root.tsx                three-pane shell
│   ├── index.tsx                 "/" empty state
│   ├── sessions.$sid.tsx         "/sessions/:sid" passthrough
│   ├── sessions.$sid.index.tsx   "pick a message" empty state
│   └── sessions.$sid.messages.$mid.tsx
│                                 message detail (the centerpiece)
├── components/
│   ├── SessionsSidebar.tsx       left pane
│   ├── MessagesPane.tsx          middle pane
│   ├── MessageDetail.tsx         right pane wrapper + header
│   ├── InteractionCard.tsx       one HTTP round-trip
│   ├── RequestPanel.tsx          full request rendering
│   ├── ResponsePanel.tsx         full response rendering + SSE timeline
│   └── ui/                       shadcn primitives
├── lib/
│   ├── anthropic-types.ts        Anthropic Messages API schema
│   ├── api.ts                    typed fetch wrappers around /api/*
│   └── utils.ts                  cn()
├── server/                       pure node — no React
│   ├── middleware.ts             Connect middleware (mounted in vite.config.ts)
│   ├── proxy.ts                  /v1/messages forwarder + SSE tee
│   ├── grouping.ts               session/message inference
│   ├── sse.ts                    Anthropic SSE parser
│   └── storage.ts                JSONL persistence
└── styles.css

bin/cli.js                        global "claude-proxy" entry
```

## What's not done yet

- Live tail of an in-flight interaction (interactions only refresh on poll).
- Diff view between adjacent iterations' `messages` arrays.
- Cross-session search, filter, sort.
- The bin/cli.js ships with `vite dev` — fine for a local tool, but a
  prebuilt Nitro deployment would start faster.
