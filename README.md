# Hexmem

Hexmem is a self-hosted, SQLite-backed [Model Context Protocol](https://modelcontextprotocol.io/) server for durable agent memory. It provides structured memory, retrieval, review, and lifecycle tools while keeping the data under operator control.

Hexmem is provider-neutral and source-only. It does not execute commands, make payments, alter external systems, or grant authority to an agent. npm registry publication is intentionally disabled.

## Data-free distribution

This repository contains application source, tests, documentation, and a DDL migration that creates an empty database schema. It does **not** contain a Hexmem database, memory records, seed data, SQLite journals, exports, backups, transcripts, credentials, or production configuration.

Your database is created locally when you initialize Hexmem and remains outside the source distribution.

## Quick start

Requirements: Node.js 20 through 25 and npm. SQLite command-line tools are useful for administration and verification but are not required to start the server.

```bash
npm ci
npm run typecheck
npm run build
npm run init
npm run start:stdio
```

The initializer creates only the required parent data directory and applies ordered schema migrations. It is safe to rerun; recorded migrations are skipped. Run `npm run test:migrations` before upgrades.

## Data location and permissions

Database path precedence is:

1. HEXMEM_DB, an explicit database file path.
2. HEXMEM_DATA_DIR, with hexmem.db inside that directory.
3. XDG_DATA_HOME, with hexmem/hexmem.db inside that directory.
4. ~/.local/share/hexmem/hexmem.db.

For a disposable local database:

    export HEXMEM_DATA_DIR="$PWD/.local-state/hexmem"
    npm run init

Memory can be sensitive. Keep the database, SQLite journals, exports, and backups in directories readable and writable only by the intended operating-system account. Never commit a database, journal, export, backup, transcript, or environment file.

## Run the MCP server

Use the built local artifact:

    npm run start -- --stdio
    npm run start -- --http

Stdio is preferred because the client owns the connection. The HTTP transport is local-only and binds to loopback by default. Do not expose it to a LAN, the public internet, or a proxy without a separately reviewed authentication and transport-security design. A non-loopback bind must be rejected unless explicitly supported with authentication and operator acknowledgement.

## Backup and restore

Use SQLite's online backup support to create a consistent snapshot outside the source tree. Keep the destination owner-only and never commit it. To restore, stop Hexmem, retain a rollback copy, restore into the resolved HEXMEM_DB location, then run SQLite integrity_check before restarting. Test restores on disposable copies first.

## Privacy and sensitivity

Treat capture and import as private unless deliberately classified otherwise. public is only for material intended for disclosure. Do not store credentials, private keys, recovery phrases, access tokens, payment material, or personal data.

Hexmem is advisory state, not an authorization system. A retrieved fact, confidence score, suggestion, or stale record must never authorize an action; clients remain responsible for authentication, confirmation, policy checks, and every side effect.

If durable memory is unavailable, uninitialized, corrupt, or unsuitable, clients must use degraded-memory behavior: state the condition, avoid inventing recalled details, and request or use fresh context. Do not silently substitute an empty or stale result for verified memory.

## Relationship to Super Agent

Hexmem can enhance [Super Agent](https://github.com/santyr/super-agent) with durable task, verification, lesson, event, and retrieval records that survive agent or supervisor restarts. This reduces duplicated findings and makes handoffs easier to audit.

The integration is optional: Super Agent can use another conforming durable store, and Hexmem can be used by other MCP clients. The projects remain separate. Hexmem stores and retrieves context; it does not inherit execution authority, approve actions, or replace independent review.

## Security and contributing

See SECURITY.md and CONTRIBUTING.md. Hexmem is licensed under Apache-2.0; NOTICE accompanies source distributions.
