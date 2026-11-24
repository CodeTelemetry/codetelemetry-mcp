# @codetelemetry/mcp

The CodeTelemetry MCP server. It lets a coding agent onboard a user to
[CodeTelemetry](https://codetelemetry.com) in **one instruction** — authenticate,
obtain an ingest key, write the Claude Code OTEL config, send a test event, and
confirm telemetry landed — **without the plaintext key ever entering the model's
context.**

This repository contains the complete source that executes in the published npm
artifact. The CodeTelemetry web application, storage, and infrastructure are not
part of this package. See [PUBLICATION.md](PUBLICATION.md) for the enforced
publication boundary.

The zero-config Connect CLI is published independently so onboarding does not
depend on the MCP sizing release:

```bash
npx -y @codetelemetry/connect login
# Add --codex when configuring OpenAI Codex.
# Add --client cursor for Cursor: see "Cursor" below.
```

## Install (Claude Code)

```bash
claude mcp add codetelemetry -- npx -y --package=@codetelemetry/mcp codetelemetry-mcp
```

or in `.mcp.json` — pinning the version you expect, so what a client launches is
deterministic (see [Releases & discovery](#releases--discovery)):

```json
{
  "mcpServers": {
    "codetelemetry": { "command": "npx", "args": ["-y", "--package=@codetelemetry/mcp@0.10.0", "codetelemetry-mcp"] }
  }
}
```

Then just ask the agent: **"Connect me to CodeTelemetry."**

## Join an existing organization

After accepting an invitation, choose **Explore the team’s work** to review existing
sessions without local setup, or **Connect my coding tool** to record your own work.
Run the project connection command from the repository you choose:

```sh
npx -y @codetelemetry/connect@0.6.0 join --organization-id tm_example --client codex --project .
# For Claude Code, use --client claude.
```

Join uses the existing organization's ID and your own device approval. It resumes
a saved connection after interruption, enables prompt/tool capture and repository
observation for new connections, and preserves existing capture choices. Pass
`--no-enrich` when making a new connection to opt out. It never creates an organization,
purchases credits/seats, or executes optional Grader, Terraform or GitHub steps from
an older bootstrap plan. A conflicting project destination is an error.

Setup prints a saved workspace name and its launch instructions. Claude uses local
project settings; Codex uses `connect run <name>` to select its named config-file
profile. An already-open client does not adopt that profile automatically. The
browser progress link checks your real session, captured prompt, and project
identity separately from the connection test. Imported history cannot satisfy live
verification. **My sessions** is scoped to your authenticated ingest ownership;
**Team sessions** shows the selected organization's activity.

Optional history import uses the saved project and credentials, without a key argument:

```sh
npx -y @codetelemetry/connect@0.6.0 import --workspace <name> --preview
# Choose numbers from that preview; no session content uploads until confirmation:
npx -y @codetelemetry/connect@0.6.0 import --workspace <name> --select 1,2 --confirm
```

Preview is local-only and defaults to the last 30 days. It keeps at most 100 session
plans in a private file bounded to 64 KiB and valid for 24 hours. Discovery examines
at most 10,000 directory entries, parsing reads at most 128 MiB with 64 MiB per session,
and one scan is bounded to two minutes. Import rechecks destination and exact selected
plans before uploading, preserves the saved content choice, and reuses deduplication
and resumable delivery. Narrow `--since` and preview again if a bound is reached.
Preview files contain identifiers and counts, never credentials or session content.

## Persistent organization workspaces

Ask the agent: **Create a Acme workspace for this repository and configure its Grader.**
It calls `bootstrap_workspace` with a stable local context name, the repository path,
and either `organizationName` (new) or `organizationId` (existing). Select checks
with `seed_grader_config` and pass the reviewed `checks` and `features`; `publish`
explicitly publishes them, and `terraform` leaves an IaC artifact.

The first call returns one browser approval URL. The page identifies the signed-in
account and destination, supports changing account, and creates a requested new
organization. Resume with just the same `name`. The private checkpoint survives
MCP restarts, expired device codes and interrupted responses. Creation uses the
same operation ID on retries; existing organizations are selected by ID, never name.

```sh
npx -y @codetelemetry/connect bootstrap acme \
  --organization-name "Acme" --client codex --project /path/to/repository
# After approval (or funding), resume the exact saved plan:
npx -y @codetelemetry/connect bootstrap acme
npx -y @codetelemetry/connect workspace list
```

New workspace setups capture prompts and tool content by default so session titles,
replay and command evidence work immediately. Pass `enrich: false` to
`bootstrap_workspace`, or `--no-enrich` to Connect bootstrap, to opt out. The choice
is saved in the setup plan; resuming preserves explicit opt-outs, existing saved
client choices and legacy checkpoints. A new named Codex profile also defaults to
capture when no earlier capture choice exists. This does not change personal
onboarding defaults or another workspace's configuration. Captured team-scoped
content follows the organization's visibility policy; new organizations disclose
member visibility during creation, and administrators can change it in settings.

`--plan file.json` supplies the same bootstrap fields as the MCP tool, including
selected Grader checks. CLI exit 2 means setup is waiting for the returned action;
exit 0 means the requested checks completed. Funding is checked before client
configuration. No credits or seats are purchased. Capture follows the saved choice;
repository observation remains a separate setup option (enabled by project join).

With repository observation enabled, Connect reports the canonical URL of a
GitHub checkout when its origin is an unambiguous HTTPS or SSH clone URL.
Codex history imports can use the origin and parent ID from the rollout
header. To preview just the repository metadata for previously recorded
sessions, run `codetelemetry-connect repository-metadata <rollout files>`.
To deliver the displayed observations to your account, supply its
`CODETELEMETRY_INGEST_KEY` and append `--send`. This command reads only the
first record of each selected file and sends no prompts, calls or usage.
If Codex has retained the Git origin in its SQLite thread database, preview
selected thread IDs with `repository-metadata --state <database> <thread IDs>`.
This mode needs Node's built-in SQLite module and performs read-only lookups.


Credentials are private version-1 JSON files under
`$CODETELEMETRY_CONTEXT_HOME/<name>.json`, defaulting to
`$XDG_CONFIG_HOME/codetelemetry/workspaces` or
`~/.config/codetelemetry/workspaces`. Files are owned, mode 0600 on POSIX, atomically
replaced, and bounded to 64 KiB. There are at most 64 contexts and 192 directory
entries including checkpoints/locks. Unsafe versions, symlinks, mismatched account,
organization, billing account or origin fail closed. Failed authorization never
falls back to personal scope. Expired credentials can be replaced with
`bootstrap_workspace` using `reauthorize: true`; the replacement must attest the
same identity. Remove an unused named context/checkpoint explicitly to free capacity.

The repository's `.codetelemetry/workspace.json` contains only the context name,
service origin and scope. It can be committed; never commit the private context,
client config, Terraform state or plan. Bindings are found from subdirectories up
to the repository root. `CODETELEMETRY_WORKSPACE` selects a context explicitly but
must agree with an existing repository binding. MCP verifies scope at restore and
before use; governance requests also carry the expected scope so a key rescope
cannot race a check and change personal configuration.

For existing auth, call `workspace_context` with `action: "save"`, a name and
`repositoryPath`. `action: "use"` selects an already-saved context. Rebinding a
repository requires explicitly removing its previous binding. Unbound clients
retain the legacy login behavior.

Bootstrap writes Claude settings inside the repository. Codex ignores project-local
`otel`, so bootstrap writes a dedicated user-level profile
`$CODEX_HOME/codetelemetry-<name>.config.toml` (or the default `~/.codex` directory).
Launch with `codetelemetry-connect run <name> -- <arguments>` or
`codex --profile codetelemetry-<name>` in the bound repository. The profile retains
your base sign-in/settings while overriding telemetry and its explicit content
opt-in. It does not rewrite the base config or copy auth tokens. The profile also registers the version-pinned workspace MCP server and disables
the standard global CodeTelemetry MCP entry for that profile. Claude receives a
project `.mcp.json` entry bound to the same context. Optional Codex observation
hooks live in the profile and run only when it is selected.
Codex combines global and profile hooks. Bootstrap upgrades recognized older
CodeTelemetry observation helpers so they abstain in named workspaces; global
hook definitions and personal reporting are preserved. Modified helpers require
review before configuration continues. When opting into new observation hooks,
review and trust them in Codex's `/hooks` interface before expecting observations.
See [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [hooks](https://learn.chatgpt.com/docs/hooks).
Secret-bearing project paths are added to `.gitignore` before configuration.

A requested GitHub gate produces its generated workflow locally. Bootstrap then
reads GitHub through the existing `gh` authentication and checks the default-branch
workflow, required check, and a real organization-scoped PR decision for the local
HEAD and published policy after setup started. It reports pending repository
work explicitly. It does not claim a PR passed merely because a probe landed.
A verified gate decision retains its actual success/failure verdict and score.
Terraform artifact generation is reported separately from applying Terraform.

The public service must deploy `/api/device/code/bootstrap-v1` and the matching
approval route before clients use new-organization creation. Older deployments
refuse the versioned request rather than creating a personal key. Existing-org
contexts use the established scope-v1 device flow.

## Cursor

Cursor has no OpenTelemetry settings to write. Connect installs eight hooks and a
background collector instead:

```sh
npx -y @codetelemetry/connect login --client cursor
# With a key you already hold: npx -y @codetelemetry/connect <cot_key> --client cursor
```

Run it on the machine where the workspace lives. With Remote-SSH, WSL or a Dev
Container that is the remote host, the WSL distribution or the container, not your
laptop: Cursor reads `~/.cursor/hooks.json` and runs hooks there. It requires
Node.js 24 or newer. Verified on Linux. macOS is in preview. Windows is not
supported: the command refuses to install there.

The command checks the machine before it requests a key: the platform, the Node.js
version, a per-user service manager, the paths it would use, and whether
`~/.cursor/hooks.json` can take the entries. A refusal names its reason and writes
nothing. After approval it asks the ingest endpoint whether it accepts Cursor
records, and stores nothing when the answer is no. Then, in this order, it writes
its settings, installs the hook program, starts the collector (a systemd user
service on Linux, a LaunchAgent on macOS) and adds one entry under each of eight
events in `~/.cursor/hooks.json`. Your other hooks are kept, and the file is copied
once to `hooks.json.codetelemetry-backup` before the first edit. An install that
fails part-way removes what it wrote, or puts the previous installation back. The
command then sends a test event, waits for it to arrive, and prints what it
installed, where, the capture mode and how to remove it. The Cursor IDE picks the hooks up at once; restart any running
`cursor-agent` session.

A new install sends everything in this table. Each flag turns one row off.

| What is sent | Turn it off |
| --- | --- |
| Prompt length, tool names, durations, exit codes, sizes, models and token counts. | `cursor disable` |
| Prompt text, the reply of each turn and the model's reasoning. The input of shell, read, write, search and task calls (commands, file paths, patterns and their options), each tool's output, the error text of a failed call, the content of the files the agent reads and writes, and the workspace path, which gives a session its repository. A session then replays as the other assistants' sessions do: what was asked, what the model thought and answered, what each tool ran and returned. Tool output, error text and file content are cut to 8,192 characters each, a reply to 16,384, and reasoning to the newest 32 thoughts of a turn at 2,048 characters each. Credential scrubbing is best effort: text in a known credential shape (key blocks, bearer and authorization values, assignments to secret-named variables, common token formats, passwords in URLs) is replaced in prompts, replies, reasoning, tool output, error text and file content before anything is stored on disk, and a tool input that holds such text, or a command that passes a password option, is withheld whole, with the content a write carried. A secret in a shape the patterns do not know is sent as typed, so pass `--no-enrich` where prompts, commands, output or files may carry secrets. | `--no-enrich` |
| Your Cursor account email, which puts your sessions under your name. | `--no-identity` |

```sh
npx -y @codetelemetry/connect login --client cursor --no-enrich --no-identity   # metadata only
```

`--enrich` and `--identity` turn an option back on. A later `login` with neither
flag keeps the stored choice, so an install made before these options were on by
default stays as it was until you pass `--enrich` or `--identity`. `login` and
`cursor status` print the current choice. With `--no-enrich` a session shows no
repository, and with `--no-identity` no developer. Records captured while an
option was on and not yet sent are reduced before they are sent. Headless runs (`cursor-agent -p`) report tools, their
output and durations, but no prompts, no replies and no tokens. Cursor's cloud and background agents do
not run user-level hooks, so they report nothing.

After upgrading Connect, run `login --client cursor` again. It installs the current
hook program and adds the hook entries a newer version uses; until then
`cursor status` reports that `hooks.json` holds only some of the entries, and the
session parts the missing hooks supply (the reply and reasoning of a turn, the
content of a file read) are not collected.

The hook runs inside the editor, so it is small and cannot block it: it makes no
network call, gives up after 1.5 seconds and always exits 0. Cursor waits for an
answer from one of the eight events, `beforeReadFile`, which is where it hands a
hook the content of a file the agent reads. That entry runs `hook-read.sh`, which
prints `{"permission":"allow"}` as its first act and then records the content, so
the read goes ahead whatever happens to the recording; with `--no-enrich` it
prints that line and starts nothing. The hook appends one record
to a local spool; the collector sends the spool in batches, at most four requests
a minute, so a turn reaches the dashboard about 15 to 35 seconds after it ends.
Unsent records wait in the spool for up to 14 days. The spool holds at most
128 MiB; while it is full, new events are not recorded, and `cursor status` shows
how many were dropped. A record older than 14 days is deleted unsent and counted
as expired, also while the service is refusing records; only the one batch being
retried is kept longer: after six days without an answer its records are sent again
as a new batch. A collector that fails to
start is started again after about a minute, not at once. On Linux a user service
stops at logout unless lingering is enabled for your user; records wait until it
runs again. A home directory on a network file system is not
supported, and Connect does not detect one.

| Path | Holds |
| --- | --- |
| `~/.config/codetelemetry/cursor-hooks-v1.json` (and `.previous`) | settings and the ingest key in plain text, mode 0600 |
| `~/.local/share/codetelemetry/cursor-hooks-v1/` | `hook.sh`, `hook-read.sh`, `hook.cjs`, `collector.sh` and the collector's own copy of Connect |
| `~/.local/state/codetelemetry/cursor-hooks-v1/` | the spool, the batch being sent, refused batches and collector state; these hold prompt and reply text, commands, tool output and file content unless you installed with `--no-enrich` |
| `~/.config/systemd/user/codetelemetry-cursor-hooks.service` or `~/Library/LaunchAgents/com.codetelemetry.cursor-hooks.plist` | the collector service |
| `~/.cursor/hooks.json` | eight CodeTelemetry entries beside your own |
| `~/.cursor/hooks.json.codetelemetry-backup` | your file as it was before the first edit |

```sh
npx -y @codetelemetry/connect cursor status             # collector, hooks and delivery; --json for a script
npx -y @codetelemetry/connect cursor disable            # remove the hook entries and stop the service
npx -y @codetelemetry/connect cursor enable             # start again with the stored key and choices
npx -y @codetelemetry/connect cursor uninstall          # remove hooks, hook program, launchers and service
npx -y @codetelemetry/connect cursor uninstall --purge  # also delete the settings, the key and unsent records
npx -y @codetelemetry/connect cursor retry-rejected     # send batches the service refused once more
```

`cursor uninstall` keeps the settings, the runtime copy and unsent records, and
lists every path it left with what each holds. `--purge` deletes them too. It
never follows a link out of its own directories, and it leaves `hooks.json` alone
apart from removing its own entries.

- **Proxy or private certificate authority.** `login` records `HTTPS_PROXY`,
  `NO_PROXY` and `NODE_EXTRA_CA_CERTS` from its environment for the collector and
  shows a recorded proxy without its credentials. A later login without those
  variables keeps them; `--no-proxy-settings` forgets them. The collector uses
  the recorded proxy settings only: proxy variables it inherits from the service
  manager are ignored. The login command's own requests use a proxy only when
  `NODE_USE_ENV_PROXY=1` is exported.
- **No per-user service manager** (most containers, WSL without systemd). `login
  --client cursor --hooks-only` installs everything except the service. Run the
  launcher it prints, `/bin/sh ~/.local/share/codetelemetry/cursor-hooks-v1/collector.sh`,
  under the host's own supervisor or in a terminal that stays open.
- **A `hooks.json` Connect will not rewrite** (a symbolic link, or a file with
  comments or trailing commas). The refusal prints the eight entries;
  `--hooks-manual` installs everything except that edit.
- **A Node.js upgrade removed the interpreter.** Hooks keep working through
  `PATH` and tell the collector where Node.js is now. `cursor status` then reports
  that the recorded path changed; run `login --client cursor` again to refresh it.

The MCP tools do not install any of this: `onboard` and `write_local_config` with
`client: "cursor"` return the command above for the user to run, and `status` with
`client: "cursor"` reads the settings afterwards.

## Tools

| Tool | What it does |
| --- | --- |
| `count_reply_phrases` | Count how often your own phrases appear in your Claude model replies, per day or week and per model (turns, turns with a match, per-phrase counts). Plain-text phrases with `{a|b}` / `[a|b]` groups, whole-word and case-insensitive; main-thread replies only; counts and session references, never reply text. |
| `estimate_history` | Price this machine's past Claude Code / Codex sessions before importing them: sessions and tokens per source, UTC month and day, oldest and newest session, last-30-day pace, priced with the public price list. Needs no key and sends nothing else; says from when a Claude Code session survives only if it was captured live or is still on disk (`cleanupPeriodDays`). |
| `import_history` | Import this machine's past Claude Code / Codex sessions (`~/.claude/projects`, `~/.codex/sessions`) through the normal ingest, tagged as imported. Dry run by default; skips sessions captured live or already imported; resumes interrupted imports; pages with `remaining`. Content defaults to `live` (what your live exporters send); `none` opts out. Imported tokens are billed like live usage: the result's `billing` prices the run, and a real import starts no session the prepaid credit cannot cover. Rows carry the signed-in account's identity as live rows do (`identity: false` omits it). |
| `workspace_context` | Save, list or select persistent verified workspace contexts. Repository bindings contain no credentials; cold MCP processes restore the bound context. |
| `bootstrap_workspace` | Create or select an organization, authorize once, and resume funding, repository-local telemetry, Grader publication, Terraform artifacts and GitHub gate verification. |
| `authenticate` | Start device-code auth; returns a URL + short code for the human to approve. Optional `organizationId` connects one of the user's organizations; optional `workspaceUrl` picks a CodeTelemetry server (codetelemetry.com hosts only). |
| `auth_status` | Poll the approval; on success captures the key into the session (masked-only to the model). |
| `get_ingest_key` | Record a pasted key (fast path) or report the authenticated one — masked + hash only. |
| `write_local_config` | Merge the OTEL config + key into Claude Code's or Codex's config (the default, or an explicit `path` to a `settings.json`/`settings.local.json` in a `.claude` directory or a `config.toml` in a `.codex` directory); preserves + backs up. Does not set up Cursor: `client: "cursor"` returns the Connect command to run. |
| `send_test_event` | Fire one OTLP probe log with a unique id. |
| `verify_telemetry` | Poll the connectivity check until the probe lands. |
| `onboard` | One-shot: key → config → test → verify, returns a checklist. Does not set up Cursor: `client: "cursor"` returns the Connect command to run. |
| `status` | Read-only diagnostics (no secrets). |
| `get_cost_signal` | Read recent tokens and observed model cost for the caller's own telemetry, with what CodeTelemetry meters for those tokens shown separately. |
| `search_sessions` | Search the same bounded session index as the UI by prompt/title text, assistant, repo, model, duration, and sort order; returns metadata and match fields, never prompt text. Results are ordered by `lastSeen` (most recently active, not started or finished); `activity: "substantive"` keeps only sessions with observed agent work and counts what it left out. Optional `start` / `end` (Unix seconds) keep sessions last active in that window. |
| `read_session_events` | Read one of your sessions' recorded events in order (prompts, assistant text, commands, tool inputs and outputs, exit codes), after privacy filtering and independent of any interpretation. Pages with a cursor, jumps by position or time, filters by kind, recorded outcome, tool or text, shows the context around an event, and expands one event's full retained text. |
| `interpret_session` | Read CodeTelemetry's own bounded, materialized interpretation of a session: optional hints to verify against the recorded events. Evidence cards are opt-in, privacy-filtered and pointer-resolved; the tool never replays raw telemetry. |
| `compare_sessions` | Compare 2–10 distinct materialized personal sessions. Returns descriptive repeated patterns, evidence pointers, denominators, observed outcome counterexamples, one-offs and confidence limits; it never replays raw telemetry or claims causation. |
| `plan_next_session` | Produce a bounded, read-only next-session recommendation from authorized materialized precedents. Historical advice is cited, generic fallback is labelled, and it never executes work or mutates plans/issues. |
| `get_session_performance` | Measure a session timeline's fresh/cache latency, rows, bytes, and query phases without returning content. |
| `find_similar_session_errors` | Find other personal-scope sessions with matching normalized failure signatures and report query performance. |
| `estimate_task_size` | T-shirt size a proposed task (free-form text or a Linear-shaped issue) from the caller's own history. |
| `estimate_plan` | T-shirt size a coding assistant's **plan** (plain text or ordered steps) from the caller's own history. |
| `estimate_linear_issue` | T-shirt size an **existing Linear issue** by URL or identifier, resolved through the workspace the user already connected. |
| `seed_grader_config` | Inspect local agent instructions, selected skills, and project task files; return source text and command-check candidates for the user's requested grading focus. Reads files without running commands or uploading them. |
| `publish_grader_config` | Publish the reviewed draft as a new policy version using its exact revision. Completes setup through MCP; historical scores remain unchanged. |
| `write_grader_config_artifact` | Write selected checks as Terraform JSON or a standalone Pulumi YAML program, choosing the format from repository context. Refuses overwrites; runs no commands. |
| `discover_grader_checks` | Discover common checks from recorded repository history; returns an asynchronous run ID. |
| `backtest_grader_checks` | Backtest candidate IDs or saved draft checks using pinned evidence and the live evaluator. |
| `get_grader_run` | Read progress, coverage, candidates and paged results, plus the current draft revision. |
| `save_grader_draft` | Save selected backtested candidates with revision protection; preserves unrelated checks and does not publish. |
| `get_grader_config` | Read a page of the workspace's Grader draft, its revision, and published version. |
| `update_grader_config` | Add, update, or remove selected draft checks while preserving others. Records the user's requested instruction features and rejects stale revisions. Use publish_grader_config with the returned revision to apply it to future scoring. |
| `get_github_pr_gate` | Read the workspace's GitHub PR gate as its settings page shows it: the policy, trusted repositories, the GitHub Actions workflow file to commit, the check to require, outstanding steps, and recent decisions. |
| `configure_github_pr_gate` | Set up or change the GitHub PR gate: trust repositories (`owner/repo` or `owner/*`), set the policy, enable it. Once the gate is on, a change that loosens it is refused (`requires_dashboard`) and the user makes it on the settings page. No GitHub token is involved: the workflow authenticates with GitHub's own OIDC token. |
| `list_public_sessions` | List CodeTelemetry's public sample sessions. Needs no sign-in or key. |
| `get_public_session` | Summary of one public session: a sample, or a session its owner published (`pub_…` id). Needs no sign-in or key, and never sends a held key. |
| `read_public_session_events` | A bounded page (max 50) of a public session's recorded events. Samples page by `position`/`limit`/`kinds`; published sessions take `read_session_events` paging, after the owner's privacy filter. Needs no sign-in or key. |
| `publish_session` | Make one of your sessions readable by anyone holding the returned `pub_…` id. Requires `acknowledgePublic: true`; idempotent; at most 20 public sessions per owner. |
| `unpublish_session` | Take one of your public sessions back; its link stops working on the next read. |
| `list_published_sessions` | List the sessions you published, with their ids and links. |

Typical agent flow: `authenticate` → (human approves) → `auth_status` →
`onboard`. Or, if the user pastes a key: `onboard { key }`.

Public sessions need no account. From a terminal:

```bash
npx -y @codetelemetry/connect public-sessions list
```

```bash
npx -y @codetelemetry/connect public-sessions events s-4f9c --limit 10
```

A `pub_…` id an owner shared works in place of a sample id. Without any client,
any MCP host can connect to `https://codetelemetry.com/public-mcp` (Streamable
HTTP, no sign-in); it serves the same three read tools. Publishing, what becomes
public, and the limits are described in the
[public sessions guide](https://codetelemetry.com/docs/integrations/public-sessions).

GitHub PR gate flow, run from inside the repository to gate:
`configure_github_pr_gate { addRepositories: ["owner/repo"], enabled: true }` →
commit `gate.actions.workflow.content` at `gate.actions.workflow.path` (a PR
the user merges) → once it has run, the user requires
`codetelemetry/validation` from GitHub Actions on the default branch (`howTo`
gives the `gh api` ruleset command to run with their permission).

## Discover and backtest the Grader

For history-based setup, call `discover_grader_checks` with the recorded
`repository` label and requested `features`. The service defaults to 30 days of
PR-producing sessions; `cohort: "substantive"` includes all observed work.
Poll `get_grader_run`, follow `nextCursor`, and review candidate IDs, package
scope, ambiguities and coverage. Call `backtest_grader_checks` with the discovery
ID and selected candidate IDs, then poll the new run. Completion and final
edit-to-push timing are separate verdicts. Unknown and partial evidence remain
explicit. To backtest existing configuration, follow `draftChecksCursor` from
`get_grader_run` for saved check IDs/names and the current `draftRevision`, then
pass that revision, selected `checkIds` and `repository` to `backtest_grader_checks`.

Save selected candidates with `save_grader_draft`, passing the backtest ID and
current `draftRevision` from `get_grader_run` as `expectedRevision`. Saving
preserves unrelated checks and does not publish or change enforcement. Runs
expire after 24 hours. Scans, normalization and evaluation run on the service;
this workflow needs no checkout, shell, custom scripts or client matcher JSON.
The backend must support the Grader history routes before these tools can run.
Existing local seeding and direct configuration remain available below.

## Seed and update the Grader

Ask, for example: **"Use AGENTS.md and our security-review skill to grade unit
tests, lint, and security-review skill invocation. Ignore the writing style rules."**

The agent calls `seed_grader_config` with the repository directory and your
`features` description. Discovery includes nested packages and repository skills
under `.agents/skills`, `.claude/skills`, and `.codex/skills`. Additional user
skills can be selected explicitly through `skillPaths`; your home directory is
never scanned automatically.

Command candidates come from npm/pnpm/yarn/bun scripts, Composer scripts,
Make/Just/Rake targets, pytest/Ruff/mypy configuration, tox/nox, Go, Cargo,
Maven/Gradle, .NET project files, Swift, Mix, and CMake test configuration.
Declared tasks and inferred conventions are labelled separately. Discovery is
bounded, skips dependency/generated/hidden directories, does not follow links,
and reports truncation or unreadable sources. Narrow the repository directory
when a large monorepo hits the limits. No task is executed.

The calling agent uses your description to select relevant checks and translate
instruction features into observable command or tool-use matchers. It should
explain prose requirements the deterministic Grader cannot establish. Invoking a
skill can be checked; compliance with all its written guidance cannot be inferred
from invocation alone. Review inferred commands and adapt local working-directory
matchers if your sessions run at another path. Pass `repositoryId` from session
metadata to scope checks to the recorded repository. Give a check `issues`
(`["owner/repo#N"]`, lowercase) to make it a task check: it is required only for a
pull request that GitHub reports closes one of those issues, and it adds to the
organization and repository checks. The PR gate reads GitHub's closing-issue
references; when a repository has task checks, unknown or unmapped linkage fails
closed.

The agent then reads `get_grader_config` (follow `nextOffset` for remaining checks)
and sends selected `upsertChecks` and/or `removeCheckIds` to
`update_grader_config`, with `features` and the read's `revision` as
`expectedRevision`. Existing checks are preserved unless named. A concurrent
edit returns `conflict`; read again before retrying. An uncertain save must also
be read back before retrying. Only selected check definitions and your feature
description go to the server; source file text stays local to the MCP response.

Changes are initially saved as a draft. To activate them, call
`publish_grader_config` with the exact `expectedRevision` returned by
`update_grader_config` or a fresh `get_grader_config`. The complete workflow —
seed, select checks, save, review, publish — works through MCP without the UI.
Publish only when the user wants activation; saving a draft stays separate.
Publication creates a new policy version for future evaluations and leaves
historical scores unchanged. Concurrent edits or a repeated publish using the
same revision return `conflict`. After `publish_uncertain`, read
`get_grader_config` and compare `publishedVersion` and `revision` before retrying.
The [Grader page](https://codetelemetry.com/app/validation) remains an alternative. Remote configuration requires a backend implementing
`POST /api/agent/grader`, `POST /api/agent/grader/configure`, and
`POST /api/agent/grader/publish`; older deployments
return `not_supported` or `not_configured`. Local seeding works without a key.


Leave selected checks in the repository with `write_grader_config_artifact`:

```json
{
  "repositoryPath": "/path/to/project",
  "features": "Require successful unit tests and lint from AGENTS.md",
  "checks": ["<selected complete check objects from the seed or draft>"]
}
```

The example's `checks` placeholder must be replaced with actual check objects.
Auto detection scans at most 4,000 entries, five directories deep, skipping links,
dependencies and state directories. `.tf` / `.tf.json` selects Terraform;
`Pulumi.yaml` / `Pulumi.yml` selects Pulumi. Mixed, missing or incomplete context
requires `format: "terraform"` or `format: "pulumi"`, or a narrower directory.

Terraform writes `codetelemetry-grader.tf.json`, for use with the local
`codetelemetry_grader_config` provider resource. Configure the provider using
[codetelemetry-providers](https://github.com/ElliotGardiner/codetelemetry-providers)
before planning; it is not a published registry integration.
Pulumi writes `codetelemetry-grader.pulumi.yaml` as JSON, a valid YAML subset.
Move it to a **separate directory** as `Pulumi.yaml`, build the provider binary
there at `./bin/terraform-provider-codetelemetry`, then run `pulumi install` and
`pulumi preview`. This standalone YAML program works alongside repositories using
any Pulumi language; it does not rewrite an existing Pulumi program.

Both resources own their listed check IDs, preserve unrelated checks, and use
revision checks on writes. An identical draft saved by the MCP can be adopted
without a write. Conflicting existing IDs require explicit import and review.
Destroy removes only managed draft checks. Use one state owner per workspace;
review plans and protect production resources as needed.

The requested focus is retained in Terraform locals or the Pulumi program
description. The IaC dashboard API preserves the draft's existing
`requestedFeatures`; use `update_grader_config` to change that remote intent.
Artifacts contain selected check definitions, not raw instructions or skills.
Template-like source strings remain literal. Files are created with restrictive
permissions and never overwrite an existing file, including symlinks. Edit an
existing artifact with normal file tools. The artifact tool does not execute IaC or publish a
policy; use `publish_grader_config` for activation. Apply with `CODETELEMETRY_ENDPOINT` and a **Cognito ID token** in
`CODETELEMETRY_TOKEN`, supplied through your secret manager; the MCP's ingest key
is not the IaC credential. Keep secrets out of check definitions and protect state.

## Organizations

Without an `organizationId`, the key goes wherever the user picks while approving:
their personal workspace or one of their organizations. To connect an
organization on purpose, pass its id, shown in parentheses next to each
organization on the approval page:

```jsonc
// tool: authenticate
{ "organizationId": "<organization id>" }
```

The approval link then pre-selects that organization, the sign-in runs on the
scope-fenced route, and `auth_status` keeps the key only when CodeTelemetry
attests that it belongs to that organization. Otherwise it answers `wrong_scope`
(or `scope_unverified` when the organization could not be confirmed) and discards
the key. `onboard` and `verify_telemetry` repeat the check against
the connectivity endpoint. `workspaceUrl` is unrelated: it picks the CodeTelemetry
server, not an organization.

## Data and local changes

The default setup writes only the OpenTelemetry exporter endpoint and ingest
credential to the selected client's config file: Claude Code's user or
current-project `settings.json`, or Codex's active `config.toml`. An explicit
`path` may name another config file of the same client, and nothing else: a
`settings.json` or `settings.local.json` inside a `.claude` directory (or
`$CLAUDE_CONFIG_DIR`), or a `config.toml` inside a `.codex` directory (or
`$CODEX_HOME`). A leading `~` is the home directory; links, network paths and
anything but a regular file are refused, and a path the host pins outranks the
model's. Authentication uses `https://codetelemetry.com` unless `authenticate` is
given a `workspaceUrl`, which must be an https URL on codetelemetry.com or one of
its subdomains and cannot override a server the MCP configuration pins. Moving to
another server drops any key from the old one, and telemetry goes to the ingest
endpoint the new server issues with its key. Existing config is preserved, backed
up before a change, and the resulting file is made owner-readable only where the
platform supports it.

Two higher-sensitivity features are off by default and require separate boolean
opt-ins:

- `enrich: true` enables content telemetry. For Claude Code this uploads prompt
  text, tool details and content, and raw API request/response bodies. For Codex
  it uploads prompt text. Those fields can contain source code, shell commands,
  file contents, secrets, or other sensitive data.
- `repositoryObservation: true` installs local lifecycle/tool hooks. When a
  session starts or resumes, or its repository/workspace changes, the hook sends
  the absolute repository root and working-directory paths, repository name, a
  hashed repository id, session id, and hook event to CodeTelemetry. The hook
  keeps a bounded local hash-only cache to avoid duplicate observations.

These options are independent: opting into repository observation does not turn
on prompt/body telemetry, and `enrich` does not install repository hooks. A later
run with `repositoryObservation` omitted or false removes only CodeTelemetry's
managed hook entries and helper/state files; unrelated user hooks are preserved.

## Price and import past sessions

Both assistants keep local history that CodeTelemetry can import, but it does
not keep forever. Price it first; nothing is sent and no key is needed:

```bash
npx -y @codetelemetry/connect estimate            # the whole retained year (364 days)
npx -y @codetelemetry/connect estimate --since 90d --source claude-code
npx -y @codetelemetry/connect estimate --json
```

The estimate reads `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and
`~/.codex/sessions` (or `$CODEX_HOME/sessions`) with the importer's own parsers
and reports sessions and tokens per source and per UTC month, the oldest and
newest session, what uploading them would cost, and the monthly cost of one seat
at the last 30 days' pace. Tokens are input + output + cache read + cache
creation, each counted once. Its only request is the public price list
(`GET /api/pricing`); without it, the estimate prints the token totals and a
link to the pricing page. In a browser, `estimateFiles` from
`@codetelemetry/mcp/client/import/browser` estimates dropped files the same way;
`runEstimate` (`@codetelemetry/mcp/client/import/run`) is the Node entry point and
`@codetelemetry/mcp/client/import/estimate` holds the shared core
(`HistoryEstimate`, `EstimateBuilder`, `fetchPricing`, `priceEstimate`).

Some data is gone for good. Claude Code deletes a transcript at startup once it
is `cleanupPeriodDays` (settings.json, default 30) past its last activity, so a
session from before then can be imported only if its transcript is still on disk
(the sweep leaves subagent transcripts and can miss a file); the estimate names
the cutoff date. Codex keeps rollouts until they are removed. No
import recovers what only live telemetry carries: per-request latency and
retries, permission decisions, active time, lines-of-code / commit /
pull-request counters, model responses and tool output content.

Imported tokens are billed like live usage: they count toward the current
month, seat-included tokens first, then the per-million token price from
prepaid credit. When the import-status read reports the workspace's billing
state, `import --dry-run` shows the run's estimated cost and whether the credit
covers it, and a real import never starts a session whose cumulative cost
would exceed the included allowance plus credit: the rest are skipped as
`budget` (`stoppedBy: "budget"`) and the same command continues once credit is
added. Without billing state the import behaves as before.

Imported rows carry the identity attributes the live exporters send, on every
record: Claude Code's `organization.id`, `user.account_id`,
`user.account_uuid`, `user.email` and `user.id` from `~/.claude.json` (or
`$CLAUDE_CONFIG_DIR`), and Codex's `user.account_id` and `user.email` from the
ChatGPT sign-in in `~/.codex/auth.json` (or `$CODEX_HOME`; the id token is
decoded locally and never sent or logged). Output shows the identity masked.
`--email` overrides `user.email`; `--no-identity` (MCP: `identity: false`)
omits the rest. A browser upload stamps only the email it is given
(`importFiles(files, { identity: { email } })`).

## Estimating a plan

`estimate_plan` predicts the **coding-assistant token effort** of a plan from the
user's own similar past sessions — not elapsed time or human engineering hours.
The client must submit the plan content **explicitly** (the server never reads the
agent's hidden state), and the whole plan is sized as **one** unit: submitted step
boundaries are preserved in `source` for provenance but are never summed as
independent estimates. It is read-only — it never edits the plan, creates issues,
or starts work. Weak or contradictory history yields a **low-confidence** result
carrying a small calibration task rather than a falsely precise number.

**Claude Code** — after Claude drafts a plan, ask it to size that plan. Claude
passes its own plan text/steps explicitly:

```jsonc
// tool: estimate_plan
{
  "title": "Add a rate limiter to the ingest API",
  "steps": [
    { "title": "Token bucket", "detail": "per-tenant bucket in the ingest middleware" },
    { "title": "Config", "detail": "expose the limit + window as env vars" },
    "Add unit and integration tests for the limiter"
  ],
  "repo": "acme-api",
  "provider": "claude",
  "model": "claude-opus-4-8"
}
```

**Codex** — the same tool from a Codex session. Pass the plan as plain text (or
steps) and set `provider: "codex"`:

```jsonc
// tool: estimate_plan
{
  "title": "Backfill Linear estimates",
  "planText": "1. Read settled sessions for the window\n2. Size each by actual token usage\n3. Write the estimate + provenance back to Linear behind a confirm gate",
  "repo": "acme-api",
  "provider": "codex"
}
```

The result carries the shared sizing schema (`estimate`: size, predicted token
range, confidence with reasons, comparable-work evidence, optional calibration
task), plus normalized `source` metadata (title, format, preserved step
boundaries, repo/project/provider/model) and a `note` restating that the number is
token effort, not time.

## Estimating a Linear issue

`estimate_linear_issue` sizes an issue that **already exists** in Linear, so you
never paste its contents into a prompt. You pass a reference; CodeTelemetry
resolves it through the Linear workspace the user connected in Settings. **No
Linear token is ever sent** — the request carries only the reference and optional
hints, and it is read-only: the issue's estimate, description, labels, state and
comments are left untouched.

**Claude Code** — ask it to size the ticket you're about to pick up. An issue URL
names its own workspace, so nothing else is needed:

```jsonc
// tool: estimate_linear_issue
{
  "reference": "https://linear.app/acme/issue/ELL-44/add-an-mcp-tool-to-estimate-linear-issues",
  "repo": "acme-api"
}
```

**Codex** — the same tool from a Codex session, using the bare identifier. A
Linear identifier is only unique *within* a workspace, so if more than one
workspace is connected, name the one to use:

```jsonc
// tool: estimate_linear_issue
{
  "reference": "ELL-44",
  "workspace": "acme",
  "repo": "acme-api"
}
```

Omit `workspace` when only one workspace is connected. With several, the call
fails with `ambiguous_connection` and returns the candidates, so you can retry
naming one — the tool never guesses which workspace's `ELL-44` you meant.
Pass **either** `workspace` **or** `connectionId`, not both: hints don't outrank
each other, so any two that name different workspaces (including the workspace in
an issue URL) fail with `conflicting_selection` rather than one silently winning.

```jsonc
{
  "ok": false,
  "error": "ambiguous_connection",
  "message": "... name one with connectionId or workspace: \"acme\", \"globex\"",
  "connections": [
    { "connectionId": "conn-…", "workspace": { "urlKey": "acme",   "name": "Acme Inc" }, "isDefault": true,  "status": "connected" },
    { "connectionId": "conn-…", "workspace": { "urlKey": "globex", "name": "Globex"   }, "isDefault": false, "status": "connected" }
  ]
}
```

A success carries the shared sizing schema (`estimate`: size, sizing-model
version, predicted token range, confidence with reasons, comparable-work
evidence, optional calibration task, and the size projected onto the issue's own
team scale), plus `source` — the reference as submitted, the issue's identifier,
URL, title, labels, project, team, the workspace it came from, and the
`normalizedText` actually matched. `source` deliberately omits the issue's
**description**: every tool result is serialized twice (text *and*
`structuredContent`), so repeating it would double an already-doubled body.

Read the body from `estimate.issueSource.description` — **capped at 4,000
characters**, with `descriptionChars` (its true length) and
`descriptionTruncated` alongside it. Linear puts no ceiling on a description and
a tool result lands in your context twice, so the server bounds it rather than
letting one long issue exhaust your tool-result budget. When
`descriptionTruncated` is true you have a prefix, not the issue — open the `url`
if you need the rest.

Other failures each keep their own code, so the next action is unambiguous:
`no_connected_workspace`,
`connection_not_found`, `workspace_not_connected`, `conflicting_selection`,
`connection_needs_reconnect`, `issue_inaccessible` (the *connection* can't read —
reconnect it rather than trying other identifiers), `issue_not_found` (Linear
reports "no such issue" and "invisible to this credential" identically, so this
one means either — check the identifier *or* connect a workspace that can see it),
`empty_issue`, `invalid_reference`, `invalid_workspace`, `read_limit_exceeded`,
`unauthenticated`, `rate_limited`, `read_timeout`, `linear_unavailable`
(transient — retry), `linear_not_configured` (a deployment fault; retrying will
not help), and `sizing_failed` for anything unmapped.

## Security

The plaintext `cot_…` key lives only inside the server process's session
(`#private` field). Every tool result carries a **masked** preview (`cot_…b3F9`)
and the key hash — never the plaintext. `callTool` additionally scrubs the
serialized result as a backstop. This invariant is asserted throughout
[`test/tools.test.ts`](test/tools.test.ts).

The public MCP schemas deliberately expose neither endpoint overrides nor
arbitrary config paths. Test harnesses and trusted embedders can inject those
values through the programmatic `ToolContext`; they are not model-controlled.

## Releases & discovery

A tool only exists for a customer once it reaches the **published** package. Three
inventories have to agree, and `npm run verify:registry` fails when they don't:

| Inventory | What it is |
| --- | --- |
| source | `TOOLS` in `src/tools.ts`, pinned by the committed `tool-manifest.json` |
| packaged | what `npm pack` produces and actually serves when launched |
| published | the version on npm that `npx -y @codetelemetry/mcp` downloads |

```bash
npm run manifest:write            # after intentionally changing a tool; commit the diff
npm run verify:registry           # source ↔ committed manifest ↔ the two tool tables
npm run verify:registry -- --packaged    # + pack, launch, diff tools/list
npm run verify:registry -- --published   # + compare against npm (inventory, artifact, `latest` tag)
npm run smoke -- --npx --endpoint https://codetelemetry.com   # the customer path
npm run smoke -- --install                                    # deps via a real `npm install`
npm run smoke -- --tarball out.tgz --require-auth             # exactly these bytes (the release gate)
```

`registryHash` identifies an **inventory** (sha256 over the wire-visible fields);
`version` identifies a **build**. Both are readable from any client — call `status`
and read `server`:

```jsonc
"server": { "name": "codetelemetry", "version": "0.3.11", "registryHash": "cb420922…", "toolCount": 23 }
```

**When a long-running client sees a new tool.** `tools/list` is requested once, at
connect time, and the server declares `capabilities.tools` *without* `listChanged`
— accurately: its registry is fixed for the life of the process, so nothing will
push an update to a connected client. A new tool therefore arrives only when a new
server process starts with the new package:

- **new client session** — nothing to do; it discovers the current inventory.
- **already-connected session** — restart the client (Claude Code: quit and
  relaunch, or reconnect the server from `/mcp` if your version offers it; Codex:
  restart the session).
- **restarted and still missing** — the launcher is reusing an older download. Pin
  the version in `.mcp.json` (or append `@latest`) and confirm with `status`:
  `server.version` / `server.registryHash` name the build that answered.

Publishing is the deploy: there is no server-side runtime that serves this
registry. The release runs that smoke against production **before** it publishes,
with `--require-auth` — which fails unless every sizing route actually answered, so
an immutable version cannot ship ahead of the backend its tools call. For
`estimate_linear_issue`, a workspace-shaped refusal (no workspace connected, issue
not found) counts as an answer; a deployment fault, an unavailable upstream, or a
404 does not.
`CODETELEMETRY_INGEST_KEY` comes from the environment — never a flag. Publication
is manual; see [PUBLICATION.md](PUBLICATION.md) for the review and release gates.

## Develop

Requires **Node ≥ 22.6** to run the sources; the published artifact is compiled JS
(`npm run build` → `dist/`), because Node will not strip types inside
`node_modules`.

```bash
npm test               # dep-free: tool registry, the no-leak invariant, manifest pins
npm install            # pulls @modelcontextprotocol/sdk
npm run test:protocol  # drives the tools through a real MCP client/server pair
npm run test:packaged  # packs, launches the artifact, runs the release smoke
npm run typecheck
```

`npm test` and `test:protocol` load `test/support/isolateHome.ts`, which
points `HOME`, `USERPROFILE` and `CODEX_HOME` at a throwaway directory, so a test can
never rewrite your own `~/.claude/settings.json` or Codex config. The collector
tests also pass their own home directory, clock, fetch and service-manager runner,
so none of them reaches `~/.cursor`, `systemctl` or `launchctl`.

## Client implementation ownership

This public repository owns the local client implementation. `src/client` contains
configuration, privacy controls, HTTP adapters, history upload, and the bounded
Kiro and Cursor collectors. The MCP server and Connect CLI share that implementation. Server
authorization, analytics, dispatch policy and production operations are maintained
separately and are not included in either package.

Run the Connect CLI with `npx -p @codetelemetry/mcp codetelemetry-connect --help`.
Kiro uses `codetelemetry-connect login --client kiro` and requires Node 24.
`kiro status`, `kiro disable`, and `kiro uninstall` inspect or stop its owned service.
Kiro reads local V3 transcripts with prompt/tool content disabled by default;
`--enrich` explicitly opts into those fields. Linux/macOS support an owned user
service; Windows uses foreground `kiro collect`. Configuration lives separately
from Kiro itself. Checkpoints and owned runtime files survive service removal.

With `--enrich`, Kiro sends prompt text and the arguments of shell, read, write and
replace calls. Credential scrubbing is best effort and uses the same rules as the
Cursor collector: text in a known credential shape (key blocks, bearer and
authorization values with their scheme word, assignments to secret-named variables,
`X-...:` request headers, a password given in prose, common token formats, a
password in a URL of any scheme) is replaced in prompts, and a tool input that
holds such text is withheld whole. A shell command that passes a secret as an
argument (`curl -u name:password`, an authenticating `-H` header, `mysql -p...`,
`docker login -p`, an option named for a secret) is also withheld whole. That rule
cannot tell a password from another use of the same option, so harmless commands
such as `psql -p 5432` or `zip -p` are withheld too; the call is still reported
with its tool name and result. A secret in a shape the patterns do not know is
sent as typed, so leave `--enrich` off where prompts or commands may carry secrets.

`login --client kiro --no-enrich` turns capture off again; with neither flag the
stored choice is kept. A login that changes the choice, in either direction, says
so and records the choice it replaced. Kiro does not rewrite an upload that was
already prepared. When the collector next starts, it discards the one unsent
upload prepared under the replaced choice and reads those records again under the
new one; source offsets advance only on acknowledgement, so no record is lost and
no manual step is needed. An upload that was being sent while the choice changed
may already have reached the service; its records are then sent a second time,
in the new form.

An unsent upload whose capture choice differs from the current one for any other
reason, such as a hand-edited configuration, is still refused: the collector
stops with `invalid Kiro retry spool contract` and sends nothing. Removing
`pending.json` from the collector's state directory makes it read those records
again under the current choice.

The Kiro collector sends bounded, sanitized source records. Event interpretation,
call/result association, usage aggregation and analytics run in the service.
The service must support `kiro-v3-source-v1` before this collector is released;
unsupported responses leave the pending upload and source offsets intact.
Checkpoint versions 1 and 2 upgrade to version 3; older collector binaries refuse
version 3. Existing canonical pending uploads retain their exact retry bytes.

Collector health version 2 reports local capture and delivery counters. It omits
call-association counts that are now computed by the service.

The Cursor collector is described under [Cursor](#cursor). It sends bounded,
sanitized `cursor-hooks-source-v1` records: the hook copies allow-listed fields
only, and what a record means (token arithmetic, outcomes, model choice) is decided
by the service. The service must support that format before this collector is
released. A collector that reaches a service without it keeps its records in the
spool and retries every 15 minutes; it sets a batch aside only when the service
refuses that batch for 24 hours, and `cursor retry-rejected` sends set-aside
batches again.
