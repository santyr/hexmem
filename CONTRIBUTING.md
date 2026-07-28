# Contributing

Thanks for helping improve Hexmem. Contributions must preserve its provider-neutral, local-first, privacy-aware boundary.

## Before submitting a change

1. Keep changes focused and include tests for behavior changes.
2. Use synthetic examples only. Reserved domains such as example.test and example.invalid are appropriate placeholders.
3. Do not add databases, SQLite journals, exports, backups, transcripts, logs, environment files, credentials, private keys, access tokens, personal data, or deployment-specific paths.
4. Do not add integrations that grant execution authority or treat memory as an authorization signal.
5. Preserve private-first handling for capture and import paths. Public sensitivity requires an explicit, reviewable choice.

## Development checks

Install dependencies with `npm ci`, then run the repository checks:

```bash
npm run typecheck
npm run build
npm test
npm run test:migrations
```

New migrations must be ordered, idempotent, and free of user or operator data. Schema changes belong in reviewed DDL; seed content does not belong in this repository.

## Pull requests

Describe the user-visible behavior, privacy or security impact, tests run, and any compatibility considerations. Keep documentation aligned with the actual runtime path precedence and transport behavior. Do not include real memory payloads in a pull request, test fixture, commit message, or review comment.

Contributions are submitted under the Apache-2.0 license unless a separate written agreement says otherwise.
