# CodeTelemetry Connect

The Connect CLI and programmatic client are maintained in the public
[CodeTelemetry client repository](https://github.com/CodeTelemetry/codetelemetry-mcp).
This package builds directly from the shared public client source, with no runtime
dependency on the MCP server or its SDK.

Run `npx -y @codetelemetry/connect --help`. Kiro and Cursor collection require Node 24.
New `bootstrap` workspace setups enable prompt and tool-content capture by default;
use `--no-enrich` to opt out. Saved choices survive resumption. Personal onboarding
and repository-observation defaults are unchanged. See the repository README for
privacy, client setup and service removal.

## Organization projects

Use `npx -y @codetelemetry/connect@0.4.0 join --organization-id tm_example --client codex --project .`
from the project you choose, or use `--client claude`. Approve the displayed existing
organization and follow the saved workspace's launch instructions. New connections
capture prompts and supported tool content; `--no-enrich` opts out on new setup.
Repeat the same command to resume. Unrelated project configurations are preserved.

Optionally run `import --workspace <name> --preview` for a local-only preview, then
`import --workspace <name> --select 1,2 --confirm` for chosen sessions. Credentials
and content choices come from the saved workspace; a destination change fails
before upload. The preview defaults to 30 days, contains at most 100 sessions, and
expires after 24 hours. Existing import deduplication and resumability still apply.

## Cursor

`npx -y @codetelemetry/connect login --client cursor` adds six entries to
`~/.cursor/hooks.json` (your other hooks are kept), installs a hook program and
starts a background collector: a systemd user service on Linux, a LaunchAgent on
macOS. Run it on the machine where the workspace lives; with Remote-SSH, WSL or a
Dev Container, Cursor runs hooks on that host. Requires Node.js 24 or newer.
Verified on Linux. macOS is in preview. Windows is not supported.

By default only metadata is collected: prompt length, tool names, durations, exit
codes, models and token counts. `--enrich` also sends prompt text, tool commands,
file paths and the workspace path, with best-effort scrubbing of text that looks
like a credential (a secret in an unrecognized shape is sent as typed);
`--identity` also sends your Cursor account email. `--no-enrich` and `--no-identity` turn them off again. File contents, command
output, model replies and reasoning are never collected. Headless runs
(`cursor-agent -p`) report tools and durations, but no prompts and no tokens.

`cursor status` shows collector, hook and delivery health. `cursor uninstall`
removes the hooks, the hook program, the launchers and the service and lists every
path it left; `cursor uninstall --purge` also deletes the settings, the stored key
and unsent records. The repository README covers proxies, hosts without a service
manager, and a `hooks.json` that must be edited by hand.
