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
    "codetelemetry": { "command": "npx", "args": ["-y", "--package=@codetelemetry/mcp@0.3.11", "codetelemetry-mcp"] }
  }
}
```

Then just ask the agent: **"Connect me to CodeTelemetry."**

## Tools

| Tool | What it does |
| --- | --- |
| `count_reply_phrases` | Count how often your own phrases appear in your Claude model replies, per day or week and per model (turns, turns with a match, per-phrase counts). Plain-text phrases with `{a|b}` / `[a|b]` groups, whole-word and case-insensitive; main-thread replies only; counts and session references, never reply text. |
| `import_history` | Import this machine's past Claude Code / Codex sessions (`~/.claude/projects`, `~/.codex/sessions`) through the normal ingest, tagged as imported. Dry run by default; skips sessions captured live or already imported; resumes interrupted imports; pages with `remaining`. Content defaults to `live` (what your live exporters send); `none` opts out. |
| `authenticate` | Start device-code auth; returns a URL + short code for the human to approve. Optional `organizationId` connects one of the user's organizations; optional `workspaceUrl` picks a CodeTelemetry server (codetelemetry.com hosts only). |
| `auth_status` | Poll the approval; on success captures the key into the session (masked-only to the model). |
| `get_ingest_key` | Record a pasted key (fast path) or report the authenticated one — masked + hash only. |
| `write_local_config` | Merge the OTEL config + key into Claude Code's or Codex's config (the default, or an explicit `path` to a `settings.json`/`settings.local.json` in a `.claude` directory or a `config.toml` in a `.codex` directory); preserves + backs up. |
| `send_test_event` | Fire one OTLP probe log with a unique id. |
| `verify_telemetry` | Poll the connectivity check until the probe lands. |
| `onboard` | One-shot: key → config → test → verify, returns a checklist. |
| `status` | Read-only diagnostics (no secrets). |
| `get_cost_signal` | Read recent tokens and observed model cost for the caller's own telemetry, with what CodeTelemetry meters for those tokens shown separately. |
| `search_sessions` | Search the same bounded session index as the UI by prompt/title text, assistant, repo, model, duration, and sort order; returns metadata and match fields, never prompt text. Results are ordered by `lastSeen` (most recently active, not started or finished); `activity: "substantive"` keeps only sessions with observed agent work and counts what it left out. |
| `read_session_events` | Read one of your sessions' recorded events in order (prompts, assistant text, commands, tool inputs and outputs, exit codes), after privacy filtering and independent of any interpretation. Pages with a cursor, jumps by position or time, filters by kind, recorded outcome, tool or text, shows the context around an event, and expands one event's full retained text. |
| `interpret_session` | Read CodeTelemetry's own bounded, materialized interpretation of a session: optional hints to verify against the recorded events. Evidence cards are opt-in, privacy-filtered and pointer-resolved; the tool never replays raw telemetry. |
| `compare_sessions` | Compare 2–10 distinct materialized personal sessions. Returns descriptive repeated patterns, evidence pointers, denominators, observed outcome counterexamples, one-offs and confidence limits; it never replays raw telemetry or claims causation. |
| `plan_next_session` | Produce a bounded, read-only next-session recommendation from authorized materialized precedents. Historical advice is cited, generic fallback is labelled, and it never executes work or mutates plans/issues. |
| `get_session_performance` | Measure a session timeline's fresh/cache latency, rows, bytes, and query phases without returning content. |
| `find_similar_session_errors` | Find other personal-scope sessions with matching normalized failure signatures and report query performance. |
| `estimate_task_size` | T-shirt size a proposed task (free-form text or a Linear-shaped issue) from the caller's own history. |
| `estimate_plan` | T-shirt size a Claude Code / Codex **plan** (plain text or ordered steps) from the caller's own history. |
| `estimate_linear_issue` | T-shirt size an **existing Linear issue** by URL or identifier, resolved through the workspace the user already connected. |
| `get_github_pr_gate` | Read the workspace's GitHub PR gate as its settings page shows it: the policy, trusted repositories, the GitHub Actions workflow file to commit, the check to require, outstanding steps, and recent decisions. |
| `configure_github_pr_gate` | Set up or change the GitHub PR gate: trust repositories (`owner/repo` or `owner/*`), set the policy, enable it. Once the gate is on, a change that loosens it is refused (`requires_dashboard`) and the user makes it on the settings page. No GitHub token is involved: the workflow authenticates with GitHub's own OIDC token. |

Typical agent flow: `authenticate` → (human approves) → `auth_status` →
`onboard`. Or, if the user pastes a key: `onboard { key }`.

GitHub PR gate flow, run from inside the repository to gate:
`configure_github_pr_gate { addRepositories: ["owner/repo"], enabled: true }` →
commit `gate.actions.workflow.content` at `gate.actions.workflow.path` (a PR
the user merges) → once it has run, the user requires
`codetelemetry/validation` from GitHub Actions on the default branch (`howTo`
gives the `gh api` ruleset command to run with their permission).

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
never rewrite your own `~/.claude/settings.json` or Codex config.

## Client implementation ownership

This public repository owns the local client implementation. `src/client` contains
configuration, privacy controls, HTTP adapters, history upload, and the bounded
Kiro collector. The MCP server and Connect CLI share that implementation. Server
authorization, analytics, dispatch policy and production operations are maintained
separately and are not included in either package.

Run the Connect CLI with `npx -p @codetelemetry/mcp codetelemetry-connect --help`.
Kiro uses `codetelemetry-connect login --client kiro` and requires Node 24.
`kiro status`, `kiro disable`, and `kiro uninstall` inspect or stop its owned service.
Kiro reads local V3 transcripts with prompt/tool content disabled by default;
`--enrich` explicitly opts into those fields. Linux/macOS support an owned user
service; Windows uses foreground `kiro collect`. Configuration lives separately
from Kiro itself. Checkpoints and owned runtime files survive service removal.

The Kiro collector sends bounded, sanitized source records. Event interpretation,
call/result association, usage aggregation and analytics run in the service.
The service must support `kiro-v3-source-v1` before this collector is released;
unsupported responses leave the pending upload and source offsets intact.
Checkpoint versions 1 and 2 upgrade to version 3; older collector binaries refuse
version 3. Existing canonical pending uploads retain their exact retry bytes.
