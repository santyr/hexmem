# Security policy

## Scope

Hexmem is a local durable-memory service. A database, its SQLite journals, exports, backups, and client transcripts can contain sensitive information. Treat them as confidential and keep them out of source control, issue reports, and public logs.

The HTTP transport is designed for loopback use. Do not expose it beyond the local machine without a reviewed authentication, authorization, and transport-security design. Hexmem does not turn retrieved memory into authority to execute an action.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository Security tab using **Report a vulnerability**. If private vulnerability reporting is unavailable, open a minimal issue asking the maintainer to establish a private reporting channel; do not include exploit details, secrets, database contents, personal information, or operational details in the issue.

Include the affected source version, a concise reproduction using synthetic placeholders, expected and actual behavior, and any mitigation you know of. Allow maintainers time to assess and coordinate a fix before public disclosure.

## Operator checklist

- Keep the database and backup directory owner-readable and owner-writable.
- Use an explicit local data path when operating in shared or automated environments.
- Keep databases, journals, exports, backups, transcripts, and production configuration out of the source checkout and version control.
- Keep HTTP on loopback; prefer stdio when feasible.
- Review tool permissions and client configuration before connecting a client.
- Update dependencies and run the ordinary test suite before adopting a new source revision.
