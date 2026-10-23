# Publication boundary

This repository is the authoritative public source for the MCP and Connect clients. It starts from
a single allowlisted snapshot of the package, with no history from any other
repository.

The npm artifact is allowlisted independently of the repository. It may contain
only:

- compiled MCP transport and tool-registry modules;
- local onboarding/configuration, privacy controls, history import and bounded Kiro collection;
- CodeTelemetry HTTP clients, protocol contracts and plan input normalization;
- `package.json`, `README.md`, `LICENSE`, and `tool-manifest.json`.

It must not contain tests, TypeScript sources, release scripts, fixtures,
infrastructure code or backend implementations. `npm run audit:package --
<tarball>` enforces that boundary on the exact tarball used by the release
workflow.

## Release preparation

1. Update MCP `package.json` and `src/version.ts` together, and the standalone
   Connect version in `packages/connect/package.json`. Both versions must be
   unpublished and ahead of their package’s current `latest`.
2. If the tool inventory changed, run `npm run manifest:write` and review it.
3. Open a pull request and wait for CI to pass.
4. Add `CODETELEMETRY_SMOKE_INGEST_KEY` as a repository secret. Publishing
   needs no npm token: configure **both packages’** trusted publishers on npmjs.com
   (Settings → Trusted publishing) is GitHub Actions, `CodeTelemetry` /
   `codetelemetry-mcp`, workflow `release.yml`, environment `npm-production`,
   with `npm publish` among the allowed actions. The `publish` job exchanges its
   GitHub OIDC token for a short-lived, package-scoped publish token.
5. Run **release** with `publish=false` at the intended commit. Each run retains
   both tarballs plus `SHA256SUMS`, audits both file boundaries, installs those
   exact candidates, and runs the authenticated read-only production smoke.
6. After merging the stacked preparation PRs, dispatch `publish=true` from
   `CodeTelemetry/codetelemetry-mcp` **main** at the intended commit. That run
   builds and verifies its own candidates before the existing `npm-production`
   reviewer gate. No token or environment approval is bypassed.
7. Publish standalone Connect before MCP. Downstream jobs check retained hashes;
   confirmation checks both npm `latest` tags and exact SHA-512 tarball integrity,
   then launches pinned and unpinned customer commands with fresh npm caches.

The two npm publications are not atomic. If one publishes and the next fails,
retain the run’s artifacts and diagnose the failed stage before retrying. An
ordinary fresh run intentionally refuses already-published versions; do not
change npm security settings or silently republish/rebuild an immutable version.
Coordinate a recovery using the retained candidate or an explicit forward bump.

## Source ownership

All runtime implementation lives under `src/`, governed by the explicit inventory
in `scripts/publicModules.ts`. `audit:source` rejects extra runtime files, symlinks,
and imports outside that source boundary. `audit:package` checks the independent
compiled-file boundary on the exact tarball. New modules must be deliberately
added to the reviewed inventory; copying a private directory is not a release
procedure. Private repository Git history is never imported.

The public client preserves explicit content and repository-observation opt-ins.
It does not contain authentication server implementations, dispatch policy,
backend estimation/calibration, infrastructure, production acceptance fixtures or
production credentials. Synthetic tests stay in this repository, outside npm.

`packages/connect` builds its client-only artifact from the same `src/client`
modules, with no runtime dependency on the MCP SDK. The packaged smoke compares
every emitted client module byte-for-byte between the two artifacts and checks
the complete Connect file inventory. Neither release builds from a private repo.
