# Public client boundary

This repository owns public Connect and MCP clients, their installation and
configuration, local collection, privacy controls, delivery and npm releases.

- Keep Kiro and Cursor event interpretation in the private service: canonical event
  mapping, call/result interpretation, credit and token aggregation, completion
  policy and analytics are not public client responsibilities. The client may retain
  bounded source context and validate allowlisted fields to protect privacy and transport.
- Never copy private repository source or Git history here. Authentication server
  implementations, dispatch policy, production acceptance credentials, operational
  fixtures and backend analytics stay private. Use synthetic fixtures in client
  tests and public CI.
- Filter sensitive data before persistence or upload. Preserve content opt-ins,
  credential scrubbing, bounded resource use and exact-byte retry behavior.
- Treat wire formats, package exports and persisted checkpoints as compatibility
  boundaries. Deploy service support before releasing a new source format; require
  explicit acknowledgement. Read old state and make unsafe downgrades fail clearly.
- Maintain the explicit source/import and npm artifact inventories. Run the source
  and package audits when changing shipped files. Do not add a private service
  implementation to an allowlist merely to make the audit pass.

- Code that runs on a customer's machine is injectable and fails open. Tests pass
  their own home directory, clock, fetch and service-manager runner; none may
  reach the real `~/.cursor`, `~/.claude`, `~/.codex` or `~/.kiro`, or call
  `systemctl` or `launchctl`. A hook that runs inside an editor is bounded, makes
  no network call and never blocks the editor.

Use Node 24 and the committed npm lockfile. Validate client changes with typecheck,
unit and protocol tests, packaged MCP tests, installed Connect/Kiro/Cursor smoke and
the source/artifact audits. npm publication belongs to this repository's release
workflow and remains a separate step from preparing a pull request.

## Contributing with an AI agent

- Follow the AI policy in [CONTRIBUTING.md](CONTRIBUTING.md). The contributor
  guide it links to is
  https://codetelemetry.com/docs/open-source/ai-contributions.
- Do not open a pull request, push or comment without the user's approval.
- Never add a Signed-off-by line. Only the human contributor may add theirs.
- Help the user fill in the "AI assistance" section of the pull request.
  Report only checks that were actually run, and say what was not verified.
- Never publish a session without the user's explicit approval.
