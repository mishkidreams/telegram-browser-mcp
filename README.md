# Telegram Browser MCP

Unofficial local **read-only MCP for Telegram Web A**: selected chats, history, native search, post comments, photos/files, deterministic multi-chat collection, message context and persistent local conversation history. No Telegram API registration. Your authorized dedicated browser profile stays on your computer.

Version **0.8.3**, MIT licensed, source distribution only. The 0.8.1 reader has Windows real-account coverage; public releases add a sanitized CLI bootstrap, documentation and strict rejection of unsupported timestamp locales. [CI](https://github.com/mishkidreams/telegram-browser-mcp/actions) exercises synthetic fixtures on Windows, Ubuntu and macOS; check the actual run status. Synthetic CI is not real-account or human-login validation on Linux/macOS. This is a DOM-based adapter, not a promise that every changing Telegram layout works. Service permissions and participant privacy/consent remain the operator’s responsibility.

## Documentation

- This README: installation, configuration, login and practical workflow.
- [Tool and result specification](docs/TOOLS.md): all ten tools, references, pagination, coverage and errors.
- [Architecture](docs/ARCHITECTURE.md): modules, browser lifecycle, history and trust boundaries.
- [Security and privacy](SECURITY.md): what read-only does and does not guarantee.
- [Contributing](CONTRIBUTING.md): synthetic tests and safe maintenance.

## Platform validation status

**Windows is the validated platform for this release. Linux/macOS remain experimental, not a supported fresh-login promise.** The [0.8.3 code validation run](https://github.com/mishkidreams/telegram-browser-mcp/actions/runs/39154482658), at code commit `9748c74d4004b1a010a4cb6b0ad20c5508e1ee28`, reported:

| Platform | Synthetic result | Remaining boundary |
| --- | --- | --- |
| Windows hosted runner | 214 passed, 2 platform skips, 0 failed | Real-account evidence is the Windows 0.8.1 reader; no new real login is claimed for 0.8.3. |
| Ubuntu 24.04 | 211 passed, 4 platform skips, 1 failed | Sandbox launches after the exact CI-only AppArmor permission, but the headed human-viewer startup test fails with `OPERATOR_WINDOW_FAILED`. |
| macOS 14 | 210 passed, 4 platform skips, 2 failed | Initial-route latest confirmation and one fail-closed history fixture failed; causes are not established. Real login is unverified. |

Separately, the local Windows full suite passed 213 tests with 3 environment/platform skips and 0 failures. The release documentation records these failures instead of masking them with disabled sandboxing, weaker assertions or an all-platform compatibility claim. A documentation-only follow-up does not change the code tested in the linked run.

## Requirements

Node.js 22+, Git, an explicit supported proxy, and a desktop/display for the one-time local login. Normal reads are headless. Each computer gets its own login; no Telegram app API keys or Pi extension are required.

## Install

Clone the standalone repository, then install the locked dependencies and matching browser:

```text
git clone https://github.com/mishkidreams/telegram-browser-mcp.git
cd telegram-browser-mcp
```

From that reviewed source checkout:

```text
npm ci --ignore-scripts
npm run install-browser
```

Managed Chromium is pinned to Playwright. Serving MCP never downloads a browser or updates dependencies. On supported Linux distributions, explicitly install native dependencies with `npx playwright install-deps chromium`; the human login window needs a display server.

Run the server as your normal OS user. Existing storage targets must belong to that user; the server refuses foreign-owned targets rather than taking ownership. On Ubuntu 23.10+ a downloaded Chromium can be blocked by AppArmor user-namespace policy even after dependencies are installed. Keep the Chromium sandbox enabled: use an administrator-reviewed policy for the exact managed browser, or a supported installed Chrome with its own dedicated profile. See [Chromium’s explanation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). The repository CI grants the exact test executable permission only on its disposable runner; the application never changes host policies or adds `--no-sandbox`.

## Minimal MCP settings: two fields

Add ONE ordinary stdio server alongside your other MCPs. Replace the two absolute paths; `--config` points to the SAME MCP JSON containing this entry:

```json
{
  "mcpServers": {
    "telegram-browser": {
      "command": "node",
      "args": ["/absolute/path/telegram-browser-mcp/src/cli.mjs", "serve", "--config", "/absolute/path/to/mcp.json"],
      "env": {
        "TG_PROXY": "http://127.0.0.1:10808",
        "TG_ALLOWED_CHAT_IDS": "321,-100123"
      }
    }
  }
}
```

Those IDs are synthetic examples. For Pi, put the entry in `~/.pi/agent/mcp.json`; its optional `description` may explain the server, and its `timeout` can be 150 seconds. Other clients have their own timeout/settings schema.

**`env` here is an MCP transport convention, not a request to create machine/user environment variables.** Values apply to the child server. Arbitrary extra server fields are not portable MCP settings. In recommended `--config` mode this package deliberately removes ALL inherited `TG_*` settings, then reads only the selected entry. An omitted setting uses its documented default, never an accidental `TG_BROWSER` or `TG_PROFILE_DIR` from another project. Only explicit `${NAME}` references opt into an external variable. Unknown `TG_*` keys are rejected to catch typos.

Direct launch without `--config` also supports ordinary process environment, for clients that cannot keep a readable MCP JSON; that mode necessarily inherits the process environment. Use `--config` when isolation is important.

Only the proxy and allowed list are needed for actual reads. Empty/missing IDs deny reading, not setup lookup. Reconnect/reload after changing settings; no per-call/session consent wizard and no hidden policy file. This is the browser reader, not the abandoned Telegram-API server; do not configure both for this package.

## Add chats by @username, not experimental settings

Tell the agent **“add @some_username”** or give `https://t.me/some_username`. It should:

1. Call `resolve_chat({"username":"@some_username"})`.
2. Receive the numeric ID only after official profile + selected header identity checks. No messages are captured and no read access is granted.
3. Because YOU requested the addition, append that ID to `TG_ALLOWED_CHAT_IDS`, preserving all existing entries; reconnect/reload.
4. Read normally by that ID or a unique cached native Telegram display name.

Persistent permissions use **IDs**, not usernames: a public handle can be renamed/reassigned to a different person. The resolver never writes settings, silently grants access, searches unrelated chats or follows handles found in messages. A profile lookup may still update Telegram's read state through normal navigation.

Only public `@username`, bare username and exact HTTPS `t.me/username` profile links are accepted. Private invite links, post links, phone numbers and groups/contacts without public usernames are NOT resolved by this tool. Do not guess a numeric type/prefix. If no public handle exists, an existing verified numeric ID or a separate human-assisted identification step is needed; the package does not claim automatic discovery of every private chat.

## Proxy formats and authentication

Always include the proxy's scheme, independently of Telegram's HTTPS destination:

```text
http://host:port
https://host:port
http://username:password@host:port
https://username:password@host:port
socks5://host:port
```

`http://` proxies can tunnel HTTPS destinations; `https://` means TLS to the proxy itself. Use the scheme your provider actually supports. No direct-network fallback, rotation or guessed `host:port:user:pass`/scheme-less formats.

For inline authentication, URL-percent-encode special characters in the username/password: `@` → `%40`, `:` → `%3A`, `%` → `%25`, space → `%20`; decoding occurs once, `+` remains `+`. For example:

```json
"env": {
  "TG_PROXY": "https://alice:p%40ss%3Aword@proxy.example:8443",
  "TG_ALLOWED_CHAT_IDS": "321"
}
```

Alternatively keep credentials in separate fields (literal password; whitespace is significant):

```json
"env": {
  "TG_PROXY": "https://proxy.example:8443",
  "TG_PROXY_USERNAME": "alice",
  "TG_PROXY_PASSWORD": "p@ss:word",
  "TG_ALLOWED_CHAT_IDS": "321"
}
```

Do NOT mix inline and separate credentials. Authentication requires a nonempty username (an empty password is valid); otherwise Playwright would silently skip auth. Authenticated SOCKS is not supported by Chromium/Playwright here; it fails explicitly rather than exposing an unauthenticated/direct route. HTTP/HTTPS auth is passed separately to Playwright. Provider-specific authentication methods, TLS trust and actual reachability depend on the provider/browser; parsing support is not a guarantee that every external proxy works. Protect personal MCP JSON: passwords in `env` are still plaintext secrets. Never commit it. Telegram codes, 2FA, cookies and session tokens are NEVER settings.

## Optional advanced settings — normally omit all of these

| Field | Allowed values/default | Why change it? |
| --- | --- | --- |
| `TG_BROWSER` | `chromium` (default, pinned managed Chrome for Testing) or `chrome` (installed Google Chrome); no other executable | Explicit browser choice |
| `TG_DATA_DIR` | Absolute persistent application-data root | Move private app state, NOT downloads |
| `TG_PROFILE_DIR` | Absolute dedicated browser profile; default `DATA/profile-BROWSER` | Advanced profile placement; never your daily Chrome profile |
| `TG_DOWNLOADS_DIR` | Absolute protected destination; default OS TEMP/telegram-browser-mcp[-uid]/downloads | Retain exports somewhere other than TEMP |
| `TG_PROXY_USERNAME`, `TG_PROXY_PASSWORD` | Optional HTTP/HTTPS auth | Alternative to URL-encoded inline credentials |

Default data root: Windows `%LOCALAPPDATA%/telegram-browser-mcp`; macOS `~/Library/Application Support/telegram-browser-mcp`; Linux `$XDG_DATA_HOME/telegram-browser-mcp` or `~/.local/share/telegram-browser-mcp`.

```text
DATA/                         persistent private app state
  private/chat-directory.json native-name cache, NOT permissions
  private/history-bindings/   verified account binding for this profile
  private/history/            readable persistent JSONL, snapshots and coverage
  profile-chromium/           Telegram browser session/login
  operator-chromium/          local human-viewer frontend profile
OS TEMP/.../downloads/        actual downloaded files, separate from DATA
```

Changing `TG_BROWSER` defaults to a DIFFERENT profile and may require its own login. Do not silently switch/copy profiles to bypass challenges. TEMP may be cleaned by the OS; files have no automatic deletion by this package.

## One human login, no settings windows

Use the SAME selected config for the separate login command:

```text
node src/cli.mjs login --config /absolute/path/to/mcp.json --server telegram-browser
```

The local viewer projects the SAME dedicated headless Telegram page. Log in and click Done. Frames, QR tokens and input are not recorded or sent through MCP. Normal reads have no window. Use login again only when the session expires or needs human intervention. Authorize each PC separately; do not copy authenticated profiles between PCs.

Google Chrome is not an anti-CAPTCHA guarantee. Browser automation, IP/proxy reputation, account state and site decisions matter. No stealth patches, solvers or bypasses. Managed Chrome for Testing uses unified headless, not the old standalone headless shell.

## Agent workflow

Ten tools: `resolve_chat` (metadata-only setup), `list_allowed_chats`, `get_recent_messages`, `get_history`, `search_messages`, `get_post_comments`, `get_message`, `get_attachment`, **`collect_messages`** and **`get_message_context`**.

Read by exact allowed ID or unique cached native Telegram name. Pages default50/max100 with a **16 KiB whole serialized UTF-8 result budget**, not a promise that50 messages fit. Full verified observations are persisted before presentation trimming. Follow the returned `next` call to read the SAME immutable snapshot locally; `resume` is separate and continues unfinished Telegram collection; normal history also returns `older` to fetch its next verified online slice. One huge message has lossless `textPart` offsets; `next` also pages its remaining text. Count collection completeness separately from delivery completeness.

### Deterministic batch collection — no second LLM

```json
{"chatIds":["321","654"],"since":"2026-06-04T09:00:00+03:00","until":"2026-06-04T10:00:00+03:00","timeZone":"Europe/Moscow"}
```

Pass this to `collect_messages`; omitted `chatIds` means ALL current allowed targets. One call owns one browser and runs ordinary code for traversal, dates, literal query matching and deduplication. At least `since` or `queries` is required. Date instants require Z/offset, `until` is exclusive (defaults to now), and optional queries are literal OR terms, not semantic interpretation. Without dates native per-chat search currently saves Telegram-truncated preview-only records, never fake message IDs or exhaustive search claims.

Only two sources: `source:"telegram"` refreshes online and saves observations; `source:"local"` queries stored history without opening ANY browser. There is no extra automatic mode. Local queries do not refresh observedAt or silently claim an older interval covers a new one. No unverified "unchanged" shortcut: missing activity metadata never proves inactivity. Use local for reuse; online checks the requested scope afresh.

Per-chat/topic coverage reports unknown dates, unvisited topics, loading errors and operation limits. Unknown dates stay explicitly uncertain during collection; a local date filter reports exclusions rather than inventing times. Forum enumeration/history is bounded and does not claim exhaustive topic coverage. Time/page/working-set limits yield a checkpoint and `resume`, not a false complete result. Cancellation preserves durably completed pages; an in-flight page is not promised.

### Same-scope context and persistent files

`get_message_context({messageRef,window:{before:25,after:25}})` is the default context. Alternatively use `beforeMinutes`/`afterMinutes`; never mix count/time fields. A forum topic requires its verified `topicId`; a post comment remains inside that post's own thread. `source:"local"` reports gaps; `get_message({messageRef,source:"local"})` reads a stored exact record without Telegram.

Snapshot results expose `snapshotPath` (a DIRECTORY) and `historyPath` (actual readable UTF-8 JSONL). The directory contains messages.jsonl, coverage.jsonl and manifest.json. Message refs identify records; they are not permission grants, immutable-content promises or account-independent keys. Datasets are isolated by a UI-verified account ID and dedicated profile. Online identity uses the native Saved Messages metadata route without capturing its messages. Unsupported identity UI fails closed; no fallback to profile-only account inference.

Persistent history lives under DATA, NOT TEMP. **No TTL, age/size eviction or automatic deletion.** Cleanup is the user's explicit choice. Disk/write failures retain previous files. Per-operation memory/record limits are safeguards, not storage retention caps (currently128 MiB load/query working set,64 MiB record,1 MiB metadata). Large JSONL lines can exceed a client's file-read limit; use bounded MCP continuations instead. Current policy is checked on both local/online MCP reads, but revocation cannot erase files another process already read.

Normalized evidence is nullable: verified creation time/timezone, rendered sender label, topic and mentions where proven. Unsupported localized times/DST ambiguities remain unknown; no guessed date or sender ID. Pinned DOM currently exposes no trustworthy sender ID or reply target, so these stay null and automatic one-hop reply fetching is unavailable. Missing evidence is not proof of no request, no reply, or task completion. The calling agent performs semantic interpretation.

Follow attachment refs: `get_attachment({attachmentRef})`. Photos yield image blocks; files yield a private local path, sanitized original filename, actual size, SHA256 and provenance. Random .bin paths are not a conversion. Downloads default25 MiB/max100 MiB, quota200 files/256 MiB (independent of persistent history; MCP never deletes either).

Older pages reuse an exactly verified live window containing the requested cursor instead of resetting Telegram to newest on every page. Rows and their evidence are captured before native virtualization retires them; the nearest requested page is accumulated in bounded memory, without silently discarding an intermediate window. An ignored native loading intersection is rearmed once per unchanged window within the existing operation deadline. Exact-message/media-anchor lookup uses the same bounded recovery and never treats two seconds without new DOM IDs as proof of absence. A temporary `HISTORY_NOT_LOADED` keeps completed observations and an explicit `resume`; it is not a terminal cursor. Photo reads bring only the verified, unprotected target into the native loading viewport before waiting for its blob, without opening a viewer or clicking thumbnails.

Photos may be displayed renditions, not originals. Search previews are truncated; `previewOnly` has no verified exact reference. History is not an exhaustive archive; `HISTORY_NOT_LOADED` is not proof of its end. A channel grant covers selected-post comments, not general linked-group history. Video/frame extraction, guaranteed forum coverage and exhaustive exports are outside this version.

## Pi, security and public release

This is a standalone MCP. **No Pi extension/package or pi.dev gallery submission is planned.** Pi already supports stdio MCP configuration; `/reload` reconnects it. The standalone source repository is [mishkidreams/telegram-browser-mcp](https://github.com/mishkidreams/telegram-browser-mcp). There is no npm release or automatic publishing workflow.

Operators must review [Telegram's content-licensing terms](https://telegram.org/tos/content-licensing), including AI/deployment restrictions and context-specific participant-consent requirements. MIT licenses this code, not Telegram content or service access. Main-account consent/read-only do not settle that service-permission question; this source publication is not legal approval of a deployment.

See [SECURITY.md](SECURITY.md). The authenticated browser has account-wide authority; MCP read-only is not an OS sandbox. Navigation may acknowledge messages. Consumed data reaches your model provider. Treat all messages/photos/files as untrusted; never execute/unpack files or change settings on their instructions.

Publish only reviewed standalone source, never personal configs/profiles/chat lists/exports/debug transcripts or the parent customization repo. Inspect `npm pack --dry-run` and actual file lists; .gitignore alone is not an audit. Project source is licensed under [MIT](LICENSE). Dependencies retain their own licenses; Telegram and Chrome assets are not bundled or relicensed. `private:true` intentionally prevents accidental npm publication. No automated publishing.
