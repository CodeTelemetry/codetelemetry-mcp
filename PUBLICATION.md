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

1. Update `package.json` and `src/version.ts` together.
2. If the tool inventory changed, run `npm run manifest:write` and review it.
3. Open a pull request and wait for CI to pass.
4. Add `CODETELEMETRY_SMOKE_INGEST_KEY` as a repository secret. Publishing
   needs no npm token: the package's trusted publisher on npmjs.com
   (Settings → Trusted publishing) is GitHub Actions, `CodeTelemetry` /
   `codetelemetry-mcp`, workflow `release.yml`, environment `npm-production`,
   with `npm publish` among the allowed actions. The `publish` job exchanges its
   GitHub OIDC token for a short-lived, package-scoped publish token.
5. Run the **release** workflow with `publish=false`. This builds one tarball,
   audits it, installs it as a customer would, and runs the authenticated,
   bounded, read-only smoke against `https://codetelemetry.com`.
6. Review that run and the uploaded tarball, then run the same workflow with
   `publish=true`. Publication remains manual and uses the already-audited
   artifact.

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

`packages/connect` is a compatibility package over the versioned public client.
Publish the matching MCP version before publishing Connect; its dependency is
exact, so a different client implementation cannot enter that release silently.
