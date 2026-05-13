# Contributing

## Branch model

- `main` is protected: no direct pushes, ever. Everything lands via PR.
- Day-to-day work happens on `release/x.y.z` branches. `x.y.z` is the
  version the work is targeting — keep it in sync with `package.json`'s
  `version` field.
- When a `release/x.y.z` PR merges into `main`, GitHub Actions builds,
  typechecks, publishes `agentmind-cli@x.y.z` to npm, tags `vx.y.z`, and
  drafts a GitHub release.
- If `x.y.z` already exists on npm, the publish step is skipped — re-merging
  is safe.

## Release flow

```bash
# 1. Branch off main with the next version baked into the name
git checkout main && git pull
git checkout -b release/0.2.0

# 2. Bump package.json and commit your changes
#    (use `pnpm version <patch|minor|major> --no-git-tag-version` if you like)

# 3. Push and open a PR into main
git push -u origin release/0.2.0
gh pr create --base main --title "Release 0.2.0" --body "…"

# 4. After review, merge. The Release workflow publishes 0.2.0 automatically.
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
