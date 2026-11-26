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

Kiro collects metadata only by default. `login --client kiro --enrich` also sends
prompt text and supported tool arguments, with the same best-effort credential
scrubbing as Cursor: a shell command that passes a secret as an argument is
withheld whole, which also withholds harmless commands such as `psql -p 5432`.
`--no-enrich` turns capture off again; with neither flag the stored choice is kept.

## Organization projects

Use `npx -y @codetelemetry/connect@0.7.0 join --organization-id tm_example --client codex --project .`
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

`npx -y @codetelemetry/connect login --client cursor` adds eight entries to
`~/.cursor/hooks.json` (your other hooks are kept), installs a hook program and
starts a background collector: a systemd user service on Linux, a LaunchAgent on
macOS. Run it on the machine where the workspace lives; with Remote-SSH, WSL or a
Dev Container, Cursor runs hooks on that host. Requires Node.js 24 or newer.
Verified on Linux. macOS is in preview. Windows is not supported.

A new install sends prompt text, the reply and the model's reasoning for each
turn, tool commands, tool output, the error text of a failed call, file paths, the
content of files read and written, the workspace path and your Cursor account
email, with prompt length, tool names, durations, exit codes, models and token
counts. `--no-enrich` stops the prompt, reply and reasoning text, tool commands,
tool output, error text, file paths, file content and workspace path;
`--no-identity` stops the email. `--enrich` and `--identity` turn them back on,
and a later `login` with neither flag keeps the stored choice. Text that looks
like a credential is scrubbed on a best-effort basis; a secret in an unrecognized
shape is sent as typed. Headless runs (`cursor-agent -p`) report tools, their
output and durations, but no prompts, no replies and no tokens. After upgrading
Connect, run `login --client cursor` again to install the current hook program
and hook entries.

`cursor status` shows collector, hook and delivery health. `cursor uninstall`
removes the hooks, the hook program, the launchers and the service and lists every
path it left; `cursor uninstall --purge` also deletes the settings, the stored key
and unsent records. The repository README covers proxies, hosts without a service
manager, and a `hooks.json` that must be edited by hand.
