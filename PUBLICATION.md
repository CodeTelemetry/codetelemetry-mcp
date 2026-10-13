# Publication boundary

This repository is the public source for `@codetelemetry/mcp`. It starts from
a single allowlisted snapshot of the package, with no history from any other
repository.

The npm artifact is allowlisted independently of the repository. It may contain
only:

- compiled MCP transport and tool-registry modules;
- the minimal local onboarding/configuration helpers those tools call;
- the read-only CodeTelemetry HTTP client and plan input normalizer;
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
