# Releasing

Releases are published to npm by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a version tag is pushed. Nothing is published from a local machine.

## One-time setup

On npmjs.com, open the `@devmsbtff/devfleet` package → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:

- Organization or user: `MSbtff`
- Repository: `devfleet`
- Workflow filename: `release.yml`

Once a release has gone out through the workflow, set **Publishing access** to **Require two-factor authentication and disallow tokens**, so the package can only be published by this workflow.

## Cutting a release

1. On a branch, move the `[Unreleased]` entries in `CHANGELOG.md` under the new version with today's date, and bump the version:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

2. Open a PR and merge it once CI passes.
3. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow checks that the tag matches the `package.json` version, runs the type check and tests, and publishes with a provenance attestation. Tags matching `v*` are protected by a ruleset, so a published tag can't be moved or deleted.
