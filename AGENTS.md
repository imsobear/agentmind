# AGENTS.md

For AI coding agents working on this repo. The README covers the
**product**; this file covers the **internals and conventions** an
agent needs to avoid breaking invariants. Don't restate the README — if
it's there, link to it.

## Status notes (read first)

- The multi-agent layer landed in v0.2: capture both `/v1/messages`
  (Anthropic Messages API) and `/v1/responses` (OpenAI Responses API)
  through the same project/message/interaction model. See `Multi-agent
  architecture` below before touching `proxy.ts`, `grouping.ts`, or
  `aggregate.ts`.
- Action segments are only computed for Claude Code (Anthropic).
  Computing the equivalent `function_call`→`function_call_output`
  pairing for Codex is on the v0.3 list — see the early-return in
  `aggregate.computeActionSegments`.

## Core data model

```
project (cwd, agnostic of agent)
  └── message (one user prompt)
        └── interaction (one HTTP round-trip, tagged with agentType)
              ├── request / response   ← shape varies by agentType
              └── action segment       ← Anthropic-only today
```

- **project** — pure cwd → project, no idle window: every request from
  the same working directory, across runs and across days, lands in the
  same project. `projectId = sha256(cwd).slice(0,16)` — see
  `src/server/projectId.ts`. Each project stamps `primaryAgent` at
  creation time (the first agent that wrote to it); per-interaction
  `agentType` records the true protocol for that specific round-trip
  so a mixed-agent project (claude in cwd today, codex tomorrow) still
  renders both correctly. Helper calls without their own cwd attach to
  the most recent cwd this proxy process saw.
- **message** — opens when the request's transcript (Anthropic
  `messages` / Responses `input`, normalised through the protocol
  adapter) isn't a prefix-extension of any existing message in the
  project, OR the appended slice contains a new user-typed prompt.
- **interaction** — one HTTP round-trip. An N-step ReAct loop = N
  interactions on the same message. Carries `agentType` ∈
  `'claude-code' | 'codex-cli' | 'unknown'` — pre-0.2 records lack
  this field, readers must default to `'claude-code'`.
- **action segment** — reconstructed by pairing iter N's `tool_use`
  blocks with iter N+1's `tool_result` blocks; see
  `aggregate.ts:computeActionSegments`. **Anthropic only today** — the
  function builds nothing for Codex traffic and returns `[]`. The gap
  duration is the local tool-execution wall-clock.

Neither protocol carries a project/session header — everything above
is **inferred** from request shape, by the protocol adapter. Read the
comments in `adapters.ts` + `grouping.ts` before touching the
inference rules.

## Multi-agent architecture

The proxy must speak both Anthropic Messages API and OpenAI Responses
API. The split lives behind `src/server/adapters.ts`:

```
ProtocolAdapter:
  agentType        'claude-code' | 'codex-cli'
  endpointPath     '/v1/messages' | '/v1/responses'
  parseRequest()   Buffer → typed request | undefined
  extractCwd()     request → cwd (best-effort)
  extractModel()   request → model
  normaliseMessages()
                   request → MessageParam[] (Anthropic-shaped, for prefix-
                   equality grouping; lossy but stable across iters)
  createAccumulator()
                   protocol-specific SSE accumulator
```

`proxy.ts:createProtocolProxy(adapter, deps)` is generic — it does
parse → resolve in Grouper → write partial record → forward to
upstream → tee SSE → finalise. **All protocol-specific logic lives in
the adapter.** Adding a third agent (e.g. OpenCode) means writing a
third adapter; nothing in proxy.ts changes.

Per-protocol view extractors (`interaction-view.ts`) translate a
`CapturedInteraction` into protocol-agnostic accessors (`modelOf`,
`stopReasonOf`, `usageOf`, `countToolUses`, `transcriptLength`,
`latestUserTextFromRequest`). All of `aggregate.ts` and `middleware.ts`
goes through these — none of them touch `it.request.messages` or
`it.response.content` directly any more.

Upstream URL precedence (per adapter):
```
claude-code:  AGENTMIND_UPSTREAM_ANTHROPIC > AGENTMIND_UPSTREAM > https://api.anthropic.com
codex-cli (API key, Bearer sk-…):
              AGENTMIND_UPSTREAM_OPENAI                          > https://api.openai.com
codex-cli (ChatGPT OAuth, Bearer eyJ…):
              AGENTMIND_UPSTREAM_OPENAI_CHATGPT                  > https://chatgpt.com/backend-api/codex
```

Codex routing is **per-request** based on the Authorization header
shape, not a startup-time decision. `resolveUpstream` in `proxy.ts`
inspects `Authorization: Bearer <token>` on each request:

- `eyJ…` prefix → JWT → ChatGPT OAuth flow → chatgpt.com path (`/responses`)
- `sk-…` or anything else → API key → api.openai.com path (`/v1/responses`)

This matches what `codex-rs/model-provider-info/src/lib.rs`
(`CHATGPT_CODEX_BASE_URL`) does internally for the built-in `openai`
provider when `requires_openai_auth = true`. Our launcher sets exactly
that flag (see `bin/cli.js`), so the user's existing `codex login`
session works against the proxy with no extra setup. The smoke test
covers both branches (see `scripts/smoke-codex.mjs`).

Header forwarding is a **deny-list** (`NON_FORWARDED_HEADERS`), not an
allow-list. ChatGPT's backend is pickier about exotic headers
(`originator`, `version`, residency, Cloudflare cookies) than
api.openai.com — fewer surprises if we just relay whatever Codex sent.
The deny-list is restricted to the hop-by-hop headers undici needs to
own (`host`, `connection`, `content-length`, `transfer-encoding`, etc.)
plus `accept-encoding` (we want plaintext for the SSE tee).

### Codex CLI setup quirks (read before debugging "nothing captured")

Pointing Codex CLI at AgentMind is **not** as simple as setting
`OPENAI_BASE_URL`. Three things work against the obvious approach:

1. **`OPENAI_BASE_URL` is deprecated and only honored on the API-key path.**
   Codex CLI v0.118+ defaults to ChatGPT OAuth login. That auth flow
   ignores the env var and routes through `chatgpt.com/backend-api/codex/…`
   regardless. The fix is a custom provider with
   `requires_openai_auth = true`, which keeps Codex's normal auth
   selection but forces the request through *our* `base_url`. Critically,
   we **do not** want `env_key = "OPENAI_API_KEY"` on the provider — that
   forces the API-key path and breaks ChatGPT-only users.

2. **WebSocket transport is preferred.** Codex tries
   `wss://<base_url>/responses` first and only falls back to HTTP/SSE
   after `stream_max_retries` × 15s timeouts (~75s). AgentMind only
   speaks HTTP/SSE, so without `supports_websockets = false` users see
   no traffic until the WS budget exhausts. `prod-entry.ts` listens for
   the `upgrade` event and replies 426 + a hint body so the failure
   is loud, but a properly configured provider skips the WS attempt
   altogether.

3. **The upstream URL must change based on auth flavor.** API-key
   requests go to `api.openai.com/v1/responses`; ChatGPT-OAuth requests
   go to `chatgpt.com/backend-api/codex/responses`. Same Responses-API
   body schema either way, just different hosts and path prefixes. The
   proxy disambiguates per-request by sniffing the Authorization header
   (see `resolveUpstream` in `proxy.ts`).

The user-facing fix for all three is `agentmind-cli codex` (see
[Launcher subcommands](#launcher-subcommands) below), which spawns
Codex with `-c` overrides that install the right provider for that
single run only — no `~/.codex/config.toml` mutation, nothing to
restore on crash. Manual users get a documented `[model_providers.agentmind]`
recipe in the README.

## Launcher subcommands

`bin/cli.js` accepts two subcommands that take the manual env / config
dance off the user's plate:

- `agentmind-cli claude [args…]` — boots the dashboard, then `spawn`s
  `claude` with `ANTHROPIC_BASE_URL` injected. Trivial.
- `agentmind-cli codex [args…]` — boots the dashboard, then `spawn`s
  `codex` with these `-c` flags prepended to the user's args:
  ```
  -c model_provider="agentmind"
  -c model_providers.agentmind.name="AgentMind"
  -c model_providers.agentmind.base_url="<dashboard URL>/v1"
  -c model_providers.agentmind.requires_openai_auth=true
  -c model_providers.agentmind.wire_api="responses"
  -c model_providers.agentmind.supports_websockets=false
  ```
  `requires_openai_auth=true` is the key bit — it tells Codex to keep
  its normal auth selection (cached ChatGPT login *or* `OPENAI_API_KEY`)
  but route via *our* base_url. We **do not** inject a fake key; the
  proxy sniffs the bearer token shape per-request and routes either to
  `api.openai.com/v1/responses` (sk-…) or
  `chatgpt.com/backend-api/codex/responses` (eyJ…). End result: works
  with `codex login` alone, no API-key wrangling.

Three things to know if you touch this code:

1. **Stdio handoff.** Children get `stdio: 'inherit'` so their TUI gets
   the real TTY. AgentMind's own `console.*` / `process.stdout.write`
   calls would otherwise paint over the TUI, so the launcher
   monkey-patches them to write to `~/.agentmind/logs/<agent>-<ts>.log`
   for the duration of the agent run. Method-level redirects don't
   affect the child because `inherit` dups our underlying fd 1 / fd 2
   at spawn time.

2. **Signal handling has two phases.** While the agent is running,
   SIGINT is delivered by the terminal to the whole foreground process
   group — the child handles its own cleanup, the parent installs a
   no-op handler so Node doesn't auto-exit. SIGTERM only targets the
   parent, so we explicitly propagate it to the child. After the child
   exits, both signals tear the dashboard down cleanly.

3. **Dashboard outlives the agent.** Once the agent exits we print
   `✓ ${agent} exited. Trace ready at <url>. Press Ctrl+C to stop
   AgentMind.` and `await new Promise(() => {})` — the dashboard keeps
   serving so the user can browse the captured trace until they're
   done. Don't add a "kill on agent exit" shortcut without a flag —
   we've already weighed that tradeoff and explicit Ctrl+C wins.

The launcher is dashboard-mode aware: it requires `dist/` (i.e. only
works against the built CLI, not `pnpm dev`). The dev path stays
manual on purpose — devs hacking on agentmind don't need wrappers.

Smoke coverage: `scripts/smoke-launcher.mjs` shims `codex` and
`claude` on `PATH` with a node script that records its argv + env,
then asserts the launcher invoked them with the expected overrides.
Skipped on Windows (the PATH-shim trick needs `.cmd` plumbing).

### cwd extraction recipe per agent

| Agent       | Where the cwd lives                                                    |
| ----------- | ---------------------------------------------------------------------- |
| Claude Code | `system` prompt text. Match `/(?:cwd|working_?directory)\s*[:=]\s*(.+)/i`. |
| Codex CLI   | An `<environment_context><cwd>…</cwd>…</environment_context>` XML-ish block injected as a user-role input message. Match `/<cwd>([^<\n]+)<\/cwd>/`. Source: `openai/codex:codex-rs/core/src/context/environment_context.rs`. |

## Two state lanes

Persisted and realtime are decoupled. Both lanes must stay correct:

- **Persisted** — append-only JSONL at `~/.agentmind/projects/<projectId>.jsonl`.
  `projectId` is `sha256(cwd).slice(0,16)`, so the same cwd always lands
  in the same file. Two writes per interaction: partial (request only)
  at start, final (request + response + sseEvents) at stream end.
  Reader merges last-wins on `interactionId`. Never seek-and-rewrite.
  Legacy `~/.agentmind/sessions/` + `{type:"session", sessionId}`
  records are one-shot migrated into the new layout on Storage init
  (see `migrateLegacy` in `storage.ts`); reads also tolerate them in
  place if the migration couldn't move a file.
- **Realtime** — `LiveRegistry` in-process map (lost on restart). The
  proxy feeds every upstream chunk through a `LiveSession`; the
  registry re-emits throttled (150ms per iid) `live-update` and
  terminal `live-done` events. `middleware.ts` multiplexes those —
  together with `capture` events — onto the single shared
  `GET /api/events` SSE endpoint. Every browser tab opens **exactly
  one** SSE connection regardless of how many in-flight cards it has
  open; without the multiplex we burned through Chrome's per-origin
  HTTP/1.1 cap (6) almost immediately. The `LiveSession` is created
  **before** `onEvent` fires so subscribers can't race-miss it, and
  `getInteraction` splices the current registry snapshot into the
  initial HTTP fetch so mid-stream tabs paint immediately instead of
  waiting for the next throttled tick.

When editing `proxy.ts`: **every** early-return / error path must call
`live.finish()` + `liveRegistry.remove()`, otherwise subscribers hang
forever.

## Helper-call filtering

Both agents fire side-calls on the same endpoint they use for main
traffic (Claude Code's haiku title-gen / topic classifier; Codex CLI's
compaction / summariser). `isMainInteraction()` in `aggregate.ts` is
the predicate — currently `request.tools.length >= 1`, applied
identically across protocols (no real agent ships without at least one
tool defined). Don't surface helper calls in any UI without an explicit
reason. Per-protocol overrides go through `interaction-view.ts` if/when
the heuristic needs to differ between agents.

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

## Operator-triggered workflows

These are the exact sequences to follow when the user issues one of
these intents. Don't improvise — the steps exist because each one
caught a real footgun.

### When the user says "release" / "发布" / "出版本"

The user has finished work on a `release/x.y.z` branch and wants it
shipped. **Do not merge anything until the user has explicitly
confirmed the PR summary.**

1. **Pre-flight checks** (parallel):
   - `git status --short` — must be empty. If not, surface the dirty
     files and stop; the user decides whether to commit, stash, or
     discard.
   - `git rev-parse --abbrev-ref HEAD` — must be `release/x.y.z`. If
     not, stop and ask.
   - `node -p "require('./package.json').version"` — must match the
     `x.y.z` in the branch name. Mismatch → stop.
   - `git log origin/<branch>..HEAD --oneline` — must be empty (all
     local commits already pushed). If not, push first.
   - `gh pr list --head <branch> --base main --json number,url,title,state`
     — there must be exactly one open PR. If zero, create one with
     `gh pr create --base main --title "Release x.y.z" --body …`.
2. **Verify PR is mergeable**: `gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup`.
   `mergeable` must be `MERGEABLE`, `mergeStateStatus` should be
   `CLEAN` (or at most `UNSTABLE` if only non-required checks are
   yellow), and `check` must be `SUCCESS`. If CI is still running,
   wait for it.
3. **Summarize for the user**: report the PR URL, version, commit
   count, and a 1–2 line summary of what's in the release. Then
   **stop and wait for explicit confirmation.** No merge yet.
4. **After confirmation**, squash-merge and let `release.yml` do the
   rest:
   ```bash
   gh pr merge <n> --squash --delete-branch
   ```
   Then watch the Release workflow run:
   ```bash
   gh run watch --exit-status \
     "$(gh run list --workflow=Release --branch=main --limit=1 --json databaseId -q '.[0].databaseId')"
   ```
   Report success (npm version live, tag pushed, GitHub release
   drafted) or the failure details.

### When the user says "open a new version x.y.z" / "开新版本"

1. Confirm there's no uncommitted work: `git status --short` must be
   empty.
2. Sync main and branch off:
   ```bash
   git checkout main && git pull
   git checkout -b release/x.y.z
   ```
3. Bump the version:
   ```bash
   pnpm version x.y.z --no-git-tag-version
   ```
   That edits `package.json` (and `pnpm-lock.yaml` if needed) but
   does **not** create a git tag — tagging is the Release workflow's
   job.
4. Commit and push:
   ```bash
   git commit -am "chore: bump version to x.y.z"
   git push -u origin release/x.y.z
   ```
5. Open the PR:
   ```bash
   gh pr create --base main --title "Release x.y.z" \
     --body "Release x.y.z. Squash-merging this PR triggers publish."
   ```
6. Report the PR URL back to the user. They'll iterate on the branch
   and eventually issue the "release" intent above.

## Verifying a change

1. `pnpm typecheck` must be clean.
2. If you touched `server/`: trace one streaming round-trip end-to-end
   in your head — request → partial write → `onEvent` → upstream stream
   → `live.feed` → final write → `onEvent`. Check every error path
   cleans up the `LiveSession`.
3. If you touched UI: run `pnpm dev`, observe **both** an in-flight
   iter and a completed one. Regressions tend to surface in only one
   phase.
