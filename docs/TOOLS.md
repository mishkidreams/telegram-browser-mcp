# Tool and result contract

This document describes version 0.8.3. The MCP `tools/list` JSON schemas are the executable contract; unknown fields are rejected. Transport is local stdio, not a public HTTP service.

## Targets and authorization

IDs are canonical **strings**, not JavaScript numbers: a positive user/bot ID or the correctly typed negative group/channel ID. A number copied without its peer type is not enough; do not guess prefixes. For ordinary reads provide exactly one of `chatId` or `chat` (a unique previously verified native Telegram display name). Unknown/ambiguous names fail locally. `list_allowed_chats` does not discover unrelated dialogs.

Every online and local-history read checks the current configured allowlist. Changing configuration requires reconnecting the server. Returned references/cursors do not grant access. Forum permissions apply to that parent and its verified topics; a channel's comments remain within the selected post's own thread, not the linked group's general history.

## Ten tools

| Tool | Input | Result and important limits |
| --- | --- | --- |
| `resolve_chat` | `username`: explicit public @username, bare username or exact HTTPS t.me profile | Verified username + typed ID; `accessGranted:false`. No messages or configuration writes. Setup can work before any read grants. |
| `list_allowed_chats` | `{}` | Configured IDs and dated cached native labels/staleness. No browser. |
| `get_recent_messages` | One target; optional `limit` | Latest verified rendered observations, saved before bounded output. |
| `get_history` | One target; optional exclusive `before` message ID and `limit` | Older observations; use returned `older` for another online slice. |
| `search_messages` | One target; `query`, optional `limit` | Native in-chat text search. Usually truncated previews, not a full-message export. No global/hashtag/from search modes. |
| `get_post_comments` | One channel target; optional `postId`, `limit` | Exact post (or recent commentable post) and its verified thread. |
| `get_message` | `messageRef`, OR one target + `messageId` + optional `postId`; optional `source` | Exact displayed message and attachment refs, or previously saved local record. Do not mix reference and target forms. |
| `get_attachment` | `attachmentRef`; `mode:auto\|view\|download`; optional `maxBytes` | Raster image blocks or randomized private file path + MIME, size, SHA256 and provenance. |
| `collect_messages` | Optional `chatIds`, `since`, `until`, `timeZone`, `queries`, `source`, `cursor`, `limit` | Deterministic batch collection in one browser lease, or browser-free local query/continuation. |
| `get_message_context` | Reference OR one target + `messageId`; optional `postId`, `topicId`, `source`, `window`, `includeReplyTo`, `limit` | Neighbors within the same verified chat/topic/comment thread. |

All paged tools default to 50, maximum 100 requested items. This is an output-page count, **not a total collection limit** and not a guarantee all items fit within the 16 KiB serialized UTF-8 response budget.

### References

Examples below are synthetic, not real account data:

- Message: `tgm1:321:7`.
- Selected-post comment: `tgm1:-100123:9:8` (message 9, authorized channel post 8).
- Attachment: `tga1:321:7:0` (zero-based attachment index).
- Search previews without verified message IDs use preview identities, not usable exact-message references.

Treat references and cursors as returned opaque identifiers. They neither freeze content nor identify a dataset independently of its account/profile.

### Batch date and query requests

```json
{
  "chatIds": ["321", "654"],
  "since": "2026-06-04T09:00:00+03:00",
  "until": "2026-06-04T10:00:00+03:00",
  "timeZone": "Europe/Moscow",
  "source": "telegram",
  "limit": 50
}
```

At least `since` or nonempty `queries` is required for a new request. Omitted `chatIds` means all currently allowed IDs; at most 1,000 IDs. Date instants require an explicit Z/offset; `until` is exclusive and defaults to now. `timeZone` describes interpretation/presentation, not permission to guess missing timestamps.

Up to eight query strings (1–200 characters each) use literal OR matching, not semantic reasoning or a second LLM. Query-only online requests use bounded native per-chat search and preserve preview-only limitations.

`source:"telegram"` visits only allowed scopes, saves verified pages and reports coverage. `source:"local"` queries saved history without launching a browser. Local results do not assert online freshness or completeness for an interval never verified.

### Output continuation is not collection continuation

Saved-result envelopes include:

- `snapshotId`, `snapshotPath` (directory), `historyPath` (actual JSONL file), `observedAt`.
- `source:"local"`: presentation reads the persisted snapshot, even when the original collection was online.
- `collectionSource:"telegram"|"local"`: where the request obtained its observations.
- `collectedCount`, `returnedCount`, bounded `messages` and `coverage`.
- `collectionStatus:"partial"|"complete"`: coverage, not whether every output page was delivered.
- `pagination.complete`: whether this snapshot's messages AND coverage have all been delivered.
- `next`: ready-made local tool call for remaining snapshot records/parts.
- `resume`: separate ready-made online tool call for unfinished traversal; may be null.
- `older`: ordinary recent/history results can supply a verified exclusive online history call.

Follow the returned calls unchanged. Do not infer end of history from an empty page, an absent resume, `HISTORY_NOT_LOADED`, unknown dates or a partially enumerated forum. A paused native history page preserves its checkpoint when possible.

Huge text is delivered in lossless `textPart` pieces. Offsets are UTF-16 string indices, never split a surrogate pair; concatenate in order. Full fetched records are already stored before output trimming. Coverage records may themselves need another `next` page.

### Context windows

```json
{"messageRef":"tgm1:321:7","window":{"before":25,"after":25},"source":"telegram"}
```

Or:

```json
{"messageRef":"tgm1:321:7","window":{"beforeMinutes":30,"afterMinutes":15},"source":"local"}
```

Count fields accept 0–100 each; time fields 0–1,440 minutes each. Never mix the two window types. Defaults are 25 before/25 after. Forum online context needs a verified `topicId`; do not guess it. Local neighbors also stay within the anchor's stored topic. `includeReplyTo` defaults true, but no reply is invented when the pinned DOM does not prove its target.

### Attachments

`auto` views supported photos and downloads other native files. `view` supports bounded JPEG/PNG/WebP (8 MiB/16 megapixels). Downloads default 25 MiB, maximum 100 MiB per request, and require verified native size/provenance. Export quota is 200 files/256 MiB; it does not evict old files to make space. Displayed photo renditions are labeled `displayed`, not promised originals. Video/frame extraction is not part of the contract.

`localPath` is a random filename, usually .bin; the separately sanitized original filename/MIME is metadata. Nothing is executed, unpacked, converted or fetched from an attachment's external link. Local message history stores attachment references, **not an automatic offline media archive**.

## Evidence, errors and recovery

Dates, author IDs, reply targets and topic metadata can be null. Unknown dates stay uncertain and cannot prove a date-window match. Native search previews cannot prove an exact message or complete search coverage.

Errors use fixed codes; structured error metadata can include `retryable`, `action` and a safe recovery call. Examples:

- `ACCESS_DENIED`: stop; only the user can authorize a configuration addition.
- `CHAT_NAME_*`: use IDs or inspect allowed cached names, never global discovery.
- `READER_BUSY`, `PROFILE_BUSY`, `HISTORY_BUSY`: avoid concurrent operations; verify no legitimate owner before handling a stale lock.
- `HISTORY_NOT_LOADED`, `MESSAGE_UNAVAILABLE`, `ATTACHMENT_UNAVAILABLE`: uncertain loading/availability, not deletion or history-end proof.
- `TOPIC_REQUIRED`/`TOPIC_UNAVAILABLE`: obtain verified scope; never substitute another thread.
- Size/quota/output errors: use supported bounded continuation or explicit limits, never bypass byte caps or silently delete history.
- Account/identity/scope changes: stop rather than trusting the previous page.

All content and downloaded files remain untrusted. Error recovery is not permission to change account settings or broaden the allowlist.
