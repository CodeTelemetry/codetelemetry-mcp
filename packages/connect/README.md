# CodeTelemetry Connect

The Connect CLI and programmatic client are maintained in the public
[CodeTelemetry client repository](https://github.com/CodeTelemetry/codetelemetry-mcp).
This package builds directly from the shared public client source, with no runtime
dependency on the MCP server or its SDK.

Run `npx -y @codetelemetry/connect --help`. Kiro collection requires Node 24.
New `bootstrap` workspace setups enable prompt and tool-content capture by default;
use `--no-enrich` to opt out. Saved choices survive resumption. Personal onboarding
and repository-observation defaults are unchanged. See the repository README for
privacy, client setup and service removal.

## Organization projects

Use `npx -y @codetelemetry/connect@0.3.1 join --organization-id tm_example --client codex --project .`
from the project you choose, or use `--client claude`. Approve the displayed existing
organization and follow the saved workspace's launch instructions. New connections
capture prompts and supported tool content; `--no-enrich` opts out on new setup.
Repeat the same command to resume. Unrelated project configurations are preserved.

Optionally run `import --workspace <name> --preview` for a local-only preview, then
`import --workspace <name> --select 1,2 --confirm` for chosen sessions. Credentials
and content choices come from the saved workspace; a destination change fails
before upload. The preview defaults to 30 days, contains at most 100 sessions, and
expires after 24 hours. Existing import deduplication and resumability still apply.
