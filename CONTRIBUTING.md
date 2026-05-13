# Contributing

## Branch model

- `main` is protected: no direct pushes, ever. Everything lands via PR.
- The **CI** workflow (`build` + `typecheck`) is a required status check
  on PRs to main, so the "Merge" button only becomes available once it
  passes.
- Day-to-day work happens on `release/x.y.z` branches. `x.y.z` is the
  version being shipped — keep it in sync with `package.json`'s
  `version` field.

## Release flow

`push → CI → click Merge → push-to-main fires Release → npm publish + tag`.
CI being green before merge keeps publish failures rare; if publish does
fail, fix forward with a new `release/x.y.(z+1)` PR.

```bash
# 1. Branch off main, baking the next version into the branch name.
git checkout main && git pull
git checkout -b release/0.2.0

# 2. Bump package.json version and commit your changes.
#    (Optional helper: pnpm version <patch|minor|major> --no-git-tag-version)

# 3. Push and open a PR into main.
git push -u origin release/0.2.0
gh pr create --base main --title "Release 0.2.0" --body "…"

# 4. Wait for `CI / check` to go green. Click "Squash and merge".

# 5. On push-to-main, the Release workflow:
#      - reads version from package.json
#      - skips silently if that version is already on npm (so docs/
#        refactor merges that don't bump version are no-ops)
#      - otherwise: build + typecheck (defensive), npm publish, tag
#        v0.2.0, draft a GitHub release with auto-generated notes
```

## Secrets

`NPM_TOKEN` (Repository → Settings → Secrets and variables → Actions):
an automation token from npm with publish rights for `agentmind-cli`.

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
