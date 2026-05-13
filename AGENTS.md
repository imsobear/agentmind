# AGENTS.md

For AI coding agents working on this repo. The README covers the
**product**; this file covers the **internals and conventions** an
agent needs to avoid breaking invariants. Don't restate the README — if
it's there, link to it.

## Status notes (read first)

- A product rename `claude-proxy` → `AgentMind` is in flight. Storage
  paths, some env vars (`CLAUDE_PROXY_*`), and a few module names still
  use the old name. Don't auto-fix in unrelated PRs — the rename will
  land in one pass.
- The "one project per cwd, forever" model is the **target**. Today
  `grouping.ts` still keys by `(cwd, 3-min idle window)`, so the same
  cwd across a long gap shows as two projects. Refactor pending.

## Core data model

```
project (cwd)
  └── message (one user prompt)
        └── interaction (one HTTP round-trip)
              ├── request / response
              └── action segment   ← local tool exec between this iter and the next
```

- **project** — currently keyed by cwd + idle window; see
  `src/server/grouping.ts`. Target: cwd alone.
- **message** — opens when the request's `messages` array isn't a
  prefix-extension of any existing message in the project, OR the
  appended slice contains a new user-typed prompt.
- **interaction** — one HTTP round-trip. An N-step ReAct loop = N
  interactions on the same message.
- **action segment** — reconstructed by pairing iter N's `tool_use`
  blocks with iter N+1's `tool_result` blocks; see
  `aggregate.ts:computeActionSegments`. The gap duration is the local
  tool-execution wall-clock.

The Anthropic Messages API has no session header — everything above is
**inferred** from request shape. Read the comments in `grouping.ts`
before touching the inference rules.

## Two state lanes

Persisted and realtime are decoupled. Both lanes must stay correct:

- **Persisted** — append-only JSONL at `~/.claude-proxy/sessions/<sid>.jsonl`.
  Two writes per interaction: partial (request only) at start, final
  (request + response + sseEvents) at stream end. Reader merges
  last-wins on `interactionId`. Never seek-and-rewrite.
- **Realtime** — `LiveRegistry` in-process map (lost on restart). The
  proxy feeds every upstream chunk through a `LiveSession`; the
  `GET /api/sessions/:sid/interactions/:iid/live` SSE endpoint fans
  throttled (150ms) snapshots to subscribed browsers. The `LiveSession`
  is created **before** `onEvent` fires so subscribers can't race-miss
  it.

When editing `proxy.ts`: **every** early-return / error path must call
`live.finish()` + `liveRegistry.remove()`, otherwise subscribers hang
forever.

## Helper-call filtering

Claude Code fires Haiku side-calls (topic classifier, title gen) on the
same `/v1/messages` endpoint. `isMainInteraction()` in `aggregate.ts`
is the predicate — currently `request.tools.length >= 1`. Don't surface
helper calls in any UI without an explicit reason.

## Conventions agents keep tripping over

- **Comments explain WHY, not WHAT.** No `// increment counter`.
  Non-obvious decisions get a 1–2 line rationale; obvious code gets
  nothing.
- **Don't add files unless required.** Editing > extracting. Past
  attempts at premature module-splitting have been reverted.
- **UI hierarchy is sacred.** Product title > selected-thing label >
  metadata. When in doubt, downgrade visual weight rather than upgrade.
  Headers across columns are aligned **structurally** (`min-h-[Npx]`),
  not by matching typography — see the existing pattern in
  `__root.tsx` ↔ `MessagesPane.tsx`.
- **Storage records are forever.** Don't change a record shape without
  also handling old records on read.
- **No tests yet.** Verify with `pnpm typecheck` + manual smoke via
  `pnpm dev`. Add tests only for genuinely test-worthy logic (SSE
  parser, grouping rules) — don't pad coverage.
- **Half-baked beats polished.** When a feature feels "off", the
  default move is to delete it and rethink, not iterate. Confirm
  direction before polishing.

## Verifying a change

1. `pnpm typecheck` must be clean.
2. If you touched `server/`: trace one streaming round-trip end-to-end
   in your head — request → partial write → `onEvent` → upstream stream
   → `live.feed` → final write → `onEvent`. Check every error path
   cleans up the `LiveSession`.
3. If you touched UI: run `pnpm dev`, observe **both** an in-flight
   iter and a completed one. Regressions tend to surface in only one
   phase.
