# Releasing

Releases go to npm through [`.github/workflows/release.yml`](.github/workflows/release.yml) with [staged publishing](https://docs.npmjs.com/staged-publishing). Pushing a version tag makes the workflow build the package and stage it. The version only becomes public after a maintainer approves it with 2FA. Nothing is published from a local machine, and a compromised workflow can't publish on its own.

## One-time setup

On npmjs.com, open the `@devmsbtff/devfleet` package → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:

- Organization or user: `MSbtff`
- Repository: `devfleet`
- Workflow filename: `release.yml`
- Environment name: leave empty
- Allowed actions: `npm stage publish` only (the default). Leave `npm publish` unticked.

Once a release has gone out this way, set **Publishing access** to **Require two-factor authentication and disallow tokens**.

## Cutting a release

1. On a branch, move the `[Unreleased]` entries in `CHANGELOG.md` under the new version with today's date, and bump the version:

   ```bash
   npm version 0.3.0 --no-git-tag-version
   ```

2. Open a PR and merge it once CI passes.
3. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v0.3.0 -m "v0.3.0"
   git push origin v0.3.0
   ```

4. The workflow checks that the tag matches the `package.json` version, runs the type check and tests, and stages the package with a provenance attestation.
5. Approve the staged version on npmjs.com with 2FA, or from a terminal:

   ```bash
   npm stage list @devmsbtff/devfleet
   npm stage approve <stage-id>
   ```

Tags matching `v*` are protected by a ruleset, so a tag can't be moved or deleted once it is pushed.

## When a run fails

Fix the problem on `main`, then run the workflow by hand: **Actions** → **Release** → **Run workflow**, and enter the existing tag (e.g. `v0.3.0`). It uses the workflow file from `main` and builds the package from the tag, so the tag doesn't need to move.

```bash
gh workflow run release.yml -f tag=v0.3.0
```
