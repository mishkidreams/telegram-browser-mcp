# Contributing and maintaining

This is an unofficial, local read-only adapter for official Telegram Web A. Preserve the narrow interface and the documented privacy boundary. See [README](README.md), [architecture](docs/ARCHITECTURE.md) and [tool contract](docs/TOOLS.md).

## Local checks

Node 22+ and an appropriate desktop/display environment are required for browser fixtures.

```text
npm ci --ignore-scripts
npm run install-browser
npm test
npm pack --dry-run --ignore-scripts
```

On supported Linux runners install Playwright's native dependencies explicitly and run headed frontend fixtures under Xvfb. CI runs Windows, Ubuntu and macOS synthetic tests; a green synthetic job is not a real Telegram login or account test.

Tests use synthetic documents, local servers, synthetic proxy credentials and temporary profiles. They must not use a developer's real MCP configuration, authenticated Telegram profile, actual message history or proxy secrets. Public bug reproductions must remain synthetic.

## Changes and regressions

- Reproduce the symptom before changing loading, selector or timing behavior.
- Exercise public MCP contracts and real browser fixtures, not only mocked internals.
- Preserve exact origin/peer/header/list/thread checks before and after async work.
- Preserve output, byte, file-path, cancellation, current-policy and private-storage guards.
- Treat native loading stalls as uncertain; never silently equate them with history exhaustion.
- Capture evidence before virtualized DOM replacement; do not weaken identity to make fixtures green.
- Update docs and tests for intentional schema/default changes. Dependencies are pinned; review lockfile updates and advisories separately.
- Do not add unrelated auto-ingestion, destructive actions, arbitrary browser evaluation or account settings.
- Prefer scoped changes with no unrequested format churn.

## Never include private material

Do not commit MCP settings, actual IDs/chat labels, profiles/auth state, history JSONL, exports, screenshots, HAR/traces, logs, debug transcripts, .env files, tokens or proxy credentials. The fixture values in existing tests are deliberately synthetic; do not replace them with production values.

Use explicit file lists for release preparation. Inspect staged paths, the complete first commit/history, secret-scan output and the npm archive list. .gitignore is defense in depth, not proof of safety. A new standalone repository must not import a personal parent repository's history.

Never submit an authenticated trace or screenshot to reproduce a bug. Use fixed error codes, counts and redacted structural evidence. Report vulnerabilities privately through the repository's security reporting route when available; never attach private chat or account data.

## Runtime versus deployment

The source checkout is not the authenticated data directory. Existing installations may run an independently installed copy; changing a checkout does not update that app automatically. Coordinate reviewed public-file updates and MCP reconnects, preserve private configuration and never transfer authenticated profiles between computers.

No package publishing workflow is configured. The package is intentionally marked private to prevent accidental npm publication. License permissions for this project's own code are stated in package metadata/the repository license notice; dependencies retain their own licenses. Service terms and participants' privacy/consent obligations are separate from copyright permission to the adapter.
