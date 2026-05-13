# AGENTS.md

For AI coding agents working on this repo. The README covers the
**product**; this file covers the **internals and conventions** an
agent needs to avoid breaking invariants. Don't restate the README — if
it's there, link to it.

## Status notes (read first)

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

- **Persisted** — append-only JSONL at `~/.agentmind/sessions/<sid>.jsonl`.
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
