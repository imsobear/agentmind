# Contributing

## Branch model

- `main` is protected: no direct pushes, ever. Everything lands via PR.
- The `CI` workflow is a **required status check** — PRs cannot merge
  while it's red or pending.
- Day-to-day work happens on `release/x.y.z` branches. `x.y.z` is the
  version the work is targeting — keep it in sync with `package.json`'s
  `version` field.
- `main` is treated as **a log of what has shipped**: a commit only lands
  on main once the corresponding npm version is already live, not before.

## Release flow

The `Release` workflow is **manual** (`workflow_dispatch`). Publish
happens on the release branch _first_; only on success does the branch
get squash-merged into main, deleted, and tagged. If publish fails,
main is untouched and the operator fixes the branch and re-runs.

```bash
# 1. Branch off main; bake the next version into the branch name.
git checkout main && git pull
git checkout -b release/0.2.0

# 2. Bump package.json version and commit your changes.
#    (Optional helper: pnpm version <patch|minor|major> --no-git-tag-version)

# 3. Push and open a PR into main.
git push -u origin release/0.2.0
gh pr create --base main --title "Release 0.2.0" --body "…"

# 4. Wait for CI to go green on the PR. (Required to merge.)

# 5. When ready to ship: GitHub → Actions → "Release" → Run workflow,
#    pick the release/0.2.0 branch, click Run.
#    The workflow will:
#      - re-verify branch ↔ version
#      - re-run build + typecheck
#      - refuse if 0.2.0 is already on npm
#      - npm publish --provenance
#      - squash-merge the PR
#      - delete release/0.2.0
#      - tag v0.2.0 + draft a GitHub release
```

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
