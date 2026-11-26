# Contributing

This repository holds the source of two npm packages: the CodeTelemetry MCP
server (`@codetelemetry/mcp`) and the Connect CLI (`@codetelemetry/connect`).
Contributions to either are welcome.

## Before you start

- Open an issue, or comment on an existing one, before starting a large
  change, so we can agree on the approach first.
- Report security issues privately, as described in [SECURITY.md](SECURITY.md),
  not in an issue or pull request.
- The CodeTelemetry service is not in this repository. Changes here must not
  depend on unreleased service behaviour, and tests use synthetic data, never
  real telemetry or credentials. See [AGENTS.md](AGENTS.md) and
  [PUBLICATION.md](PUBLICATION.md) for what belongs here.

## Set up and check your change

Use Node 24 and the committed lockfile:

```bash
npm ci
npm test
npm run test:protocol
npm run typecheck
npm run audit:source
```

Pull requests run the full CI workflow, which also packs both packages,
audits their contents and installs them as a customer would. Releases to npm
are a separate step that maintainers run.

## AI-assisted contributions

You may use AI tools to contribute to this project. You are the author of what
you submit and are responsible for it.

- Read and understand every line before you ask for review. Be ready to
  explain it without the help of an AI tool.
- Disclose AI use in the pull request: the tools, what they did, how you
  checked the result, and what you did not verify. The pull request template
  has a section for this.
- Run the checks above yourself.
- Do not let an agent open pull requests or post comments without your
  approval.
- You must have the right to contribute the work under our
  [MIT license](LICENSE).

You may share the AI session, but it is not required. Review it for private
information first.

We may close pull requests that do not follow this policy.

How to disclose AI use and share your process:
https://codetelemetry.com/docs/open-source/ai-contributions

## What you can expect from maintainers

Maintainers follow the same disclosure rules in their own pull requests. When
we review yours:

- We review the change, not the tool, and hold AI-assisted work to the same
  standard as any other.
- We do not use AI detectors. If something is unclear, we ask you to explain it.
- Honest disclosure never counts against a pull request, and not sharing a
  session is not a sign of bad faith.
- We treat a shared session as context, not proof, and run our own checks.
- We may decline a change that would cost more to review or maintain than it
  is worth, however it was made.

How we handle AI-assisted contributions:
https://codetelemetry.com/docs/open-source/maintainers
