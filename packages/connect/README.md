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
