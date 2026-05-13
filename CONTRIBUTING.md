# Contributing

## Branch model

- `main` is protected: no direct pushes, ever. Everything lands via PR.
- Two **required status checks** gate every PR into main:
  - `check` — produced by the **CI** workflow (build + typecheck).
  - `release` — produced by the **Release** workflow (npm publish).
- Day-to-day work happens on `release/x.y.z` branches. `x.y.z` is the
  version the work is targeting — keep it in sync with `package.json`'s
  `version` field.
- `main` is treated as **a log of what has shipped**: a commit only lands
  on main once the corresponding npm version is already live.

## Release flow (one button on the PR)

Conceptual sequence: `CI → click "Enable auto-merge" → npm publish → PR
auto-merges → branch auto-deleted → tag vX.Y.Z`. All three workflows
participate.

```bash
# 1. Branch off main; bake the next version into the branch name.
git checkout main && git pull
git checkout -b release/0.2.0

# 2. Bump package.json version and commit your changes.
#    (Optional helper: pnpm version <patch|minor|major> --no-git-tag-version)

# 3. Push and open a PR into main.
git push -u origin release/0.2.0
gh pr create --base main --title "Release 0.2.0" --body "…"

# 4. Wait for the `check` status (CI: build + typecheck) to go green on
#    the PR. The `release` status will still show "pending / expected"
#    — that's by design.

# 5. On the PR, click "Enable auto-merge" and pick "Squash and merge".
#    From here, no further human action is needed:
#      a. The Release workflow runs, re-verifies the branch ↔ version,
#         re-builds, re-typechecks, refuses if 0.2.0 is already on npm,
#         and `npm publish --provenance`s the package.
#      b. The `release` status goes green.
#      c. GitHub's auto-merge sees both required checks green and
#         squash-merges the PR; the release branch is auto-deleted.
#      d. The Tag workflow tags `v0.2.0` on main and drafts a GitHub
#         release with auto-generated notes.

# 6. If publish fails, `release` stays red. Auto-merge keeps waiting.
#    Fix the branch, push, and the Release workflow re-runs on
#    `synchronize`. main is untouched until publish actually succeeds.
```

## How publishes are gated

| Check | Workflow | Trigger |
| --- | --- | --- |
| `check` | `ci.yml` | every non-main push and every PR to main |
| `release` | `release.yml` | only when auto-merge has been enabled on a `release/x.y.z → main` PR |

The `release` check is intentionally absent until you opt-in via
"Enable auto-merge". That keeps random PRs from triggering an npm
publish on every push.

## Local development

```bash
pnpm install
pnpm dev          # http://127.0.0.1:8088 with HMR
pnpm typecheck    # strict tsc --noEmit
pnpm build        # produce dist/ — what npm publishes
pnpm start        # run the production bundle locally (no vite)
```

## Required repo secrets

For the Release workflow to publish, the repo needs an `NPM_TOKEN` secret
with publish rights to `agentmind-cli`. Create it on npmjs.com:

1. Sign in → _Account_ → _Access Tokens_ → _Generate New Token_.
2. Pick the **Automation** type (skips 2FA, scoped to CI).
3. Grant **Publish** permission, scope it to the `agentmind-cli` package.
4. Copy the token, then on GitHub: _Repo settings → Secrets and variables
   → Actions → New repository secret_, name it `NPM_TOKEN`.

Once it's there, every `release/*` merge to `main` ships a new version.
