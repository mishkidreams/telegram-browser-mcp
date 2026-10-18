# Architecture and trust boundaries

## Components

```text
MCP client (stdio)
  cli.mjs (sanitize diagnostics before imports)
    cli-main.mjs + runtime-config.mjs + proxy-config.mjs
    mcp-server.mjs + history-tools.mjs
      authorization / strict schemas / busy and cancellation boundary
      history-service.mjs
        history-session.mjs + history-store.mjs -> protected JSONL and snapshots
        history-pages.mjs -> bounded results / next / resume / older
      harness.mjs (exclusive dedicated browser lease)
        chat-reader.mjs + conversation-reader.mjs + collection-reader.mjs
        message-metadata.mjs + media-transfer.mjs
        official Telegram Web A rendered UI
```

`chat-directory.mjs` caches verified native labels, never permissions. `reader-results.mjs` projects explicit output fields, validates references/attachments and protects exports. `local-storage.mjs` establishes private directory permissions and rejects unsafe filesystem redirects.

For human login, `operator-window.mjs` and `web/` provide a separate local frontend projecting the SAME headless page. No auth transfer, copied daily Chrome profile, API credentials or remote login screenshot service is involved.

## Online read lifecycle

1. The tiny CLI bootstrap clears known inherited Playwright/browser diagnostics in this process before dynamically importing implementation. Parse the selected MCP entry. Recommended `--config` removes inherited TG settings; omitted settings use defaults.
2. Validate the exact current ID grant (or the explicitly requested metadata-only public-profile lookup).
3. Acquire the dedicated profile's exclusive owner lease; launch the explicitly selected browser with required proxy, browser sandbox and native disk downloads disabled.
4. For history data, verify the account through UI metadata; bind datasets to account AND dedicated profile.
5. Navigate only the authorized target. Recheck official origin/path, requested peer hash, header and message-list/thread identity before capture and after asynchronous operations.
6. Read rendered observations. Native older-history loading can replace DOM windows; capture/enrich each visible window before retirement and retain the nearest bounded page. Stalled native intersections receive bounded rearming, not unlimited retries.
7. Persist verified observations and coverage before presentation trimming. Recheck policy before egress.
8. Return whitelisted fields within the response budget. Close browser context/local services and release the lease in cleanup; no idle browser pool or background ingestion is kept.

Batch collection does traversal, date filtering, literal matching and deduplication in ordinary JavaScript within one lease. Semantic reasoning remains the calling agent's job.

## Human-only login path

The viewer binds loopback on an ephemeral port. It uses a random capability, exact Host/Origin checks, bounded WebSocket messages, one operator and no-store/CSP headers. CDP screencast and validated human pointer/key input travel locally between the viewer and the SAME page. MCP exposes no generic browser/CDP/evaluate tools.

The process does not record frames, input, QR codes, passwords or codes. An agent must not use other tools to capture that window. Cancel/timeout/readiness checks fail closed. This boundary is not an OS security sandbox: processes running as the same user can still interfere with browser state or capture the desktop.

## Two sources and three kinds of storage

- **Browser profile:** persistent Telegram authentication under the app-data root. Authorize each computer separately; never publish or copy sessions.
- **Conversation history:** protected readable UTF-8 JSONL, account/profile bindings, immutable operation snapshots and coverage. Only fetched portions exist; no automatic full-account sync, TTL, age/size eviction or silent cleanup.
- **Attachment exports:** separately protected OS TEMP by default. Native file bytes are bounded and provenance-checked; the OS may remove TEMP. Saving text history does not automatically archive all media.

A snapshot directory contains `messages.jsonl`, `coverage.jsonl` and `manifest.json`. `next` reads it locally, `resume` continues unfinished online work, and `older` requests another ordinary native history slice. Local queries never launch a browser and never update freshness merely because stored files were read.

A stable message identity includes account dataset, typed peer, message ID and any selected-post context. The printable reference alone is not account-independent permission. Edits/deletions and unvisited intervals are not inferred from absent local records.

## Limits are not retention

The 16 KiB serialized result budget counts text, escaping, metadata and continuation. It is separate from client transport/context limits, requested item count, operation deadlines, working-set caps and filesystem capacity. Full observations are saved first; oversized messages are paged as lossless text parts.

Query/load working set is currently 128 MiB; individual records 64 MiB and metadata 1 MiB. These are operation safety guards, not automatic history deletion thresholds. Disk failures preserve previous data. Attachment limits/quotas are separate again.

## Non-goals and unavoidable risks

No Telegram sends, callbacks, reactions, payments, account changes, link-following or file execution. No API key registration, global-account search, stealth patches, CAPTCHA solvers, automatic proxy rotation, copied session tokens, video pipeline or guaranteed complete archive.

The browser session itself still has account-wide Telegram authority. Read-only MCP limits this interface, not the underlying session or same-user shell. Normal navigation can acknowledge messages. The agent/model provider receives the content it consumes.

DOM layout changes, localized/ambiguous timestamps, unverified authors/replies, native search previews and bounded forum enumeration yield partial/unknown evidence. Correctness means retaining those uncertainties and failing closed on identity changes, not guessing.

See [tool contract](TOOLS.md), [security policy](../SECURITY.md) and [contribution guidance](../CONTRIBUTING.md).
