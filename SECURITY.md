# Security

Please report security issues privately through GitHub's security-advisory form
for this repository. Do not open a public issue containing credentials,
customer telemetry, or a reproducible exploit.

The MCP server stores an ingest key only in process memory and writes it only to
the local client configuration explicitly selected by the user. Tool results
are scrubbed before they are returned to the model.
