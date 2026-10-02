# Appendix: Firefox Extension Platform (MV3, distribution, storage, UI, security)

## Summary

This appendix covers what the browser extension platform gives margin-notes as of late 2026: how Firefox Manifest V3 differs from Chrome, how one user can install a personal extension permanently in Firefox release, where notes can live (locally and synced across devices), which UI surfaces work in both browsers, and how authenticated calls to Confluence Cloud behave from an extension. It matters because three platform facts shape the design. Firefox has no service worker background. A permanent install in Firefox release needs AMO "unlisted" signing. And `storage.sync` is too small to be the long-term store for notes.

Legend used below:

- **[V]** Verified against primary docs (MDN, Extension Workshop, Chrome docs, Atlassian OpenAPI spec) during this research.
- **[K]** Well-known platform behavior, not re-fetched in this session.
- **[A]** Assumption or inference that needs a spike to confirm.

## Findings

### 1. Firefox MV3 status and tooling

**Background context**

- [V] Firefox does **not** support `background.service_worker` (bug 1573659). MV3 extensions in Firefox use `background.scripts` (or `background.page`). These run as **event pages**: `persistent` defaults to `false` in MV3, so the page is unloaded when idle and recreated to handle events. Listener registrations persist. Other in-memory state does not.
- [V] Cross-browser pattern: declare **both** `scripts` and `service_worker`. Chrome uses `service_worker`, Firefox uses `scripts`. From Firefox 121 the background page starts even if `service_worker` is also present (before Firefox 120 it did not start).
- [V] MV3 rules that apply to both browsers: register listeners at the top level, store state in `storage` and not in globals, use `alarms` instead of long timers, create context menus inside `runtime.onInstalled`.
- [K] Practical consequence: an event page in Firefox still has a DOM (`document`, `DOMParser`), while a Chrome service worker does not. Code shared between both must not rely on DOM APIs in the background. Parse HTML in the content script or an extension page instead.

**Host permissions**

- [V] "Users can grant or revoke host permissions on an ad hoc basis. Therefore, most browsers treat `host_permissions` as optional." Until Firefox 126, MV3 host permissions were not shown at install time and were not granted automatically. From Firefox 127, permissions in `host_permissions` and `content_scripts.matches` are shown in the install prompt and granted at install.
- [V] New host permissions added in an **update** are not shown to the user (bug 1893232), so they are not granted automatically. The extension must call `permissions.contains()` and, if needed, `permissions.request()` (requires a user gesture).
- Design rule: always check `permissions.contains({origins: ["https://*.atlassian.net/*"]})` at startup and show a "Grant access" button in the UI when it is false.

**Namespaces and polyfill**

- [V] Firefox has always offered promise based `browser.*`. MV3 also adds promises to `chrome.*` in Firefox.
- [V] Chrome only exposed `chrome.*` before Chrome 148. From Chrome 148 it also exposes `browser.*` (MDN "Chrome incompatibilities"). With MV3 promises in both browsers, `webextension-polyfill` is no longer strictly needed for a new project.
- [V] Messaging differs: Firefox uses the structured clone algorithm, Chrome uses JSON serialization. Only send plain JSON objects in messages and storage.

**Content scripts**

- [V] Content scripts run in an isolated world (Firefox "Xray vision"): they share the DOM with the page but have a separate JS global scope. `scripting.executeScript` supports `world: "ISOLATED"` (default) or `"MAIN"`. MAIN runs without isolation and the page can detect and interfere with it.
- [A] The `MAIN` world is supported in Firefox from around version 128. Check the MDN compatibility table before relying on it.
- [K] Confluence Cloud is a single page app. Navigating between pages does not reload the document, so the content script must detect URL changes itself (a `MutationObserver` on the content root, plus polling `location.href`, or `webNavigation.onHistoryStateUpdated` in the background) and re-anchor notes.

**Build tooling comparison**

| Tool | Firefox MV3 | Chrome MV3 | Notes |
|---|---|---|---|
| **WXT** (Vite) | Yes, but defaults to **MV2** for Firefox. Use `wxt -b firefox --mv3` or set `manifestVersion: 3` | Yes (default) | [V] Unified `browser` import from `wxt/browser`. [V] A single `sidepanel` entrypoint becomes `side_panel` on Chrome and `sidebar_action` on Firefox. Writes the dual `background` keys for you. Includes `wxt zip` and a dev mode that launches Firefox through web-ext. Actively maintained. |
| **Plasmo** | Works, but needs more manual configuration (Chrome-first design) | Yes | [V] Community comparisons in 2025/2026 rate it as less actively maintained than WXT. |
| **web-ext** (Mozilla) | Run, lint, build, **sign** | `web-ext run -t chromium` for running only | [V] Not a bundler. `web-ext sign --channel unlisted` is the signing path (see section 2). web-ext 10 requires Node 22+. |
| Plain TS + esbuild + web-ext | Full control | Separate manifest | The least magic. You maintain two manifests by hand. |

Recommendation: **WXT plus web-ext for signing.** Force MV3 for Firefox so Chrome and Firefox share the same code paths. Plain TypeScript with a small UI library (Preact or Svelte) keeps the bundle small enough to review. Keep `web-ext lint` in CI, because AMO runs the same linter when signing.

### 2. Installing a personal extension permanently in Firefox

[V] Release and Beta Firefox only install extensions **signed by Mozilla**. The options:

| Option | Permanent? | Friction | Verdict |
|---|---|---|---|
| `about:debugging` > "Load Temporary Add-on" | No: removed when Firefox restarts | Low. Fine for development | Development only |
| Developer Edition, Nightly or ESR with `xpinstall.signatures.required=false` | Yes | You have to use a different Firefox build on every device. [V] Release and Beta ignore this pref | OK if you already use Developer Edition |
| **AMO unlisted (self-distributed) signing** | Yes, in release Firefox on every device | One-time AMO account and API key. Every version must be re-signed | **Recommended** |
| Enterprise policy (`ExtensionSettings`) | Yes | Needs control over the policy. ESR plus policy can install unsigned add-ons | Only if IT manages Firefox |

**Unlisted signing steps** [V], plus one step marked [A]:

1. Create an AMO developer account and generate API credentials (JWT issuer and secret) on the AMO "Manage API Keys" page.
2. Set a fixed `browser_specific_settings.gecko.id` in the manifest (required for unsigned installs, for `storage.sync`, and for keeping the same storage across updates).
3. Declare `browser_specific_settings.gecko.data_collection_permissions` [V]. Since 2025-11-03, all **new** extensions must declare it, including unlisted and self-distributed ones. It needs Firefox 140+ (desktop). For margin-notes, the honest value is `"required": ["none"]` if notes never leave the user's own storage. [A] Publishing to Confluence is the user sending their own content to a site they chose, which arguably is not "collection" by the developer. Re-check the categories (for example `websiteContent`) if v2 sync sends notes to a third-party server.
4. `web-ext sign --channel unlisted --api-key $AMO_JWT_ISSUER --api-secret $AMO_JWT_SECRET`. This uploads the extension, runs automated validation and downloads the signed `.xpi` to `web-ext-artifacts/`.
5. [V] Signing can take up to 24 hours, longer if a manual review is triggered. Unlisted add-ons "are subject to be manually reviewed at any time after submission". [K] In practice, automated unlisted signing usually finishes within minutes.
6. Install on each device via `about:addons` > gear icon > "Install Add-on From File", or by opening the `.xpi` from a URL.
7. Updates [K]: either install each new signed `.xpi` by hand (same ID, so storage is kept), or host an `updates.json` and set `gecko.update_url` so Firefox updates the extension by itself. For one user, a manual reinstall is acceptable.

**Friction and risks**

- [V] Minified or bundled code may trigger a manual review request for source code. [K] For unlisted add-ons this rarely happens, but keep the build reproducible and be ready to upload the source (`--upload-source-code`).
- [V] Uninstalling deletes `storage.local`. A temporary add-on is effectively uninstalled on every restart. [A] So data written during temporary-install development is lost unless `keepStorageOnUninstall` (and `keepUuidOnUninstall`) are set in `about:config`.
- Corporate note [K]: a managed Firefox can block all extension installs or allowlist by ID through the `ExtensionSettings` policy. Check `about:policies` on the work machine before investing. Chrome on a managed machine may also block Developer Mode or "Load unpacked" (`ExtensionDeveloperModeSettings`, `ExtensionInstallBlocklist`). The Chrome equivalent of unlisted signing is an unlisted Chrome Web Store item (one-time $5 developer fee, review takes hours to days). [K] Chrome also keeps "Load unpacked" extensions across restarts in Developer Mode, so a store listing is optional for one user. Pin the extension ID with the `key` manifest field so storage survives a reload from a different folder.

### 3. Storage

**Extension storage areas**

| Area | Firefox | Chrome | Notes |
|---|---|---|---|
| `storage.local` | [V] IndexedDB-backed, same limits as IndexedDB; `unlimitedStorage` lifts the per-origin limit but a global disk limit still applies | [V] 10 MB (5 MB in Chrome 113 and earlier), `unlimitedStorage` removes it | Cleared on uninstall. Do **not** use `window.localStorage`, because Firefox clears it when browsing history is cleared [V] |
| `storage.sync` | [V] 102,400 bytes total, 8,192 bytes per item (key plus JSON value), 512 items. Syncs about every 10 minutes through the Mozilla account, and only if "Add-ons" is ticked in Sync settings. **Not synced on Firefox for Android.** Server value wins on conflict, per key. Requires an explicit gecko ID | [V] Same 100 KB / 8 KB / 512, plus 120 writes per minute and 1,800 per hour. Syncs through the Google account | Firefox and Chrome do **not** sync with each other |
| `storage.session` | In memory | [V] 10 MB, in memory | Cache only |
| IndexedDB in the extension origin | [K] Available in extension pages and the Firefox event page (`moz-extension://` origin). Not available from content scripts, which see the page's IndexedDB | [K] Available in the service worker | Use it for full text search and indexes if notes grow. Otherwise `storage.local` is simpler |

Sizing: one note (anchor quote, prefix and suffix context, page ID, body, timestamps) is roughly 0.5 to 2 KB of JSON. 100 KB of `storage.sync` holds about 50 to 150 notes at most, and the 8 KB per item limit forces one key per note or per page. That is enough for a pilot, not for daily use over months.

**Cross-device sync options**

| Option | Privacy | Cross-browser | Effort | Conflict model | Assessment |
|---|---|---|---|---|---|
| `storage.sync` | Good (end-to-end encrypted Mozilla or Google sync) [K] | No (Firefox to Firefox, Chrome to Chrome) | Trivial | Last write wins, per key | Pilot only, quota too small |
| Manual JSON export/import (`downloads.download` and a file input) | Excellent | Yes | Low | Manual | Always ship it: it doubles as a backup |
| Private GitHub **repo** through the Contents API (one JSON file per page, or one per note) | Good. Private to the user, but notes on internal pages leave the company perimeter | Yes | Medium. Needs a fine-grained PAT with Contents read/write on one repo, stored in `storage.local` | Optimistic locking through the blob `sha` (PUT fails with 409 on a conflict), plus git history | **Best v2 candidate** if company policy allows |
| Secret GitHub **gist** | Weak. [K] Secret gists are unlisted, not private: anyone with the URL can read them | Yes | Low | Whole-file overwrite | Avoid |
| WebDAV (Nextcloud and similar) | Depends on host | Yes | Medium, plus CORS and auth handling | ETag / `If-Match` | Good if a server already exists |
| Confluence **page content properties** (`/wiki/api/v2/pages/{page-id}/properties`) | **Bad.** [V] Readable by anyone with "permission to view the page". Writing requires "permission to update the page". [V] Properties live in a global namespace that all apps can read. 32 KB per property | Yes | Low (same session as publishing) | `version.number` | **Reject** for private notes. Others can read them, and edit rights are required |
| Confluence **user properties** (`/wiki/rest/api/user/{userId}/property/{key}`, v1) | [A] Unclear. Docs only require the "Can use" permission and mention a per-app limit. Another user might be able to read them by account ID. Also v1 and site level only | Yes | Low | Version | Do not rely on it without a spike |
| Restricted page in the user's personal Confluence space (notes as a JSON attachment or code block) | Medium. View restrictions hide it from other users, but **site and space admins can still see it**, and it is indexed for the admin's search [K] | Yes | Medium | Page version | Workable fallback that stays inside the company, but noisy (page history, "recently updated" feeds) |

**Recommendation**

- **v1:** `storage.local` as the single source of truth (request `unlimitedStorage`), plus JSON export/import. Store one record per note under keys like `note:<uuid>`, with an index per page. Add `schemaVersion` from the first commit. No sync.
- **v2:** a pluggable `SyncBackend` interface (`pull(since)`, `push(changes)`), with a **private GitHub repo** as the first backend. Each note gets a UUID and an `updatedAt`, merges are last-write-wins per note, and deletes are tombstones. If company policy forbids storing internal page content on GitHub, use the restricted personal-space page as the backend (same interface). Do not use `storage.sync` as the main store, except perhaps for small settings (Confluence base URL, preferences), which fit easily.

### 4. UI surfaces

| Surface | Firefox | Chrome | Fit for margin-notes |
|---|---|---|---|
| Sidebar or side panel | [V] `sidebar_action` manifest key plus `sidebarAction` API. Open with the `_execute_sidebar_action` command or `sidebarAction.open()`, called from a user-action handler | [V] `side_panel` key plus `sidePanel` API (not compatible with `sidebarAction`). [K] `sidePanel.open()` needs a user gesture (Chrome 116+) | **Best for the review panel.** The same HTML page in both browsers. WXT's `sidepanel` entrypoint writes both keys. It is a long-lived extension page with full API access and stays open while you scroll |
| Shadow DOM UI inside the page (content script) | Yes | Yes | **Best for capture:** a small "Add note" button near the selection and note bubbles in the margin. A closed shadow root isolates the UI from Confluence CSS (and Confluence CSS from the UI) |
| Toolbar popup (`action`) | Yes | Yes | Closes when focus leaves it, so it is bad for reviewing. Use it as a launcher and for the pending-notes count (badge) |
| Context menu (`menus` / `contextMenus`) | [K] `menus`, with `contextMenus` as an alias | `contextMenus` | "Add margin note to selection". It works even if the page's own selection UI gets in the way |
| Keyboard commands (`commands`) | Yes, including `_execute_sidebar_action` | Yes, `_execute_action`. A side panel shortcut needs `sidePanel.open` inside a command handler | For example Alt+Shift+M (add note) and Alt+Shift+R (open review panel) |

Recommendation: capture notes in the page through a shadow DOM popover (plus a context menu item and a keyboard shortcut). Review and publish in the **sidebar or side panel**, which shows the pending notes for the current page with checkboxes, edit, discard, and "Publish selected". The popup is just a launcher. [A] Confluence uses its own selection toolbar (the inline comment button), so the extension's popover must not overlap it. Position it relative to `Range.getBoundingClientRect()`, offset from Confluence's toolbar.

### 5. Security and authenticated requests to Confluence

**Isolation**

- [V] Content scripts share the DOM but not the JS globals of the page (isolated world). The page cannot read content script variables or call extension APIs. But the page **can** read anything the content script writes into the DOM. So note bodies rendered in the page are visible to Confluence's own JS (and to any third-party scripts it loads). Render notes inside a **closed** shadow root. [K] Even then, treat note content shown in the page as visible to the page.
- [K] Message handlers in the background should check `sender.id === runtime.id` and, for content script messages, check `sender.url` against the Confluence host.
- [V] Extension pages run under the MV3 CSP: `script-src 'self' 'wasm-unsafe-eval'`, and no remote code.

**Where to make Confluence API calls**

- [V] Background or extension page: host permissions remove cross-origin restrictions for `fetch`. [V] Content scripts in MV3 follow the page's CORS policy, and host permissions do not apply to them.
- [V] Firefox MV3 content script `fetch` runs "in context of the page": a relative URL like `/wiki/api/v2/...` resolves against the Confluence page, so it is a **same-origin** request to the tenant and the session cookies are sent. Firefox uses a privileged fetch in content scripts that does **not** set the `Origin` and `Referer` headers like a page request would. [V] `content.fetch()` (MV2 only) is gone in MV3.
- Cookies from the background [V], plus one point marked [A]: requests from a background or extension page to a URL covered by host permissions get that domain's cookies. Firefox has a special case that treats `moz-extension:` as same-site when the extension has host permission for the target (seen in the `downloads` fix, bug 1655190, and in community reports for `fetch`). So SameSite=Lax cookies are sent. [A] SameSite=Strict cookies and cases with third-party cookie blocking are less certain. Use `credentials: "include"` explicitly.
- Total Cookie Protection [V]: cookies are partitioned by top-level site for third-party contexts. Top-level documents use unpartitioned storage, and `moz-extension:` cannot be a partition key. So a background request uses the **unpartitioned** (first-party) atlassian.net cookies, which are the ones set when the user logs in at `<tenant>.atlassian.net`. [A] Containers (Multi-Account Containers) and private windows use different cookie stores. A background request uses the default store, so a user logged in only inside a container would look anonymous to the background.
- Atlassian XSRF check [V, from Atlassian KB and community reports]: REST calls with a browser User-Agent can fail with `403 XSRF check failed` when the `Origin` does not match. Community reports say Firefox extensions behave differently from Chrome here (Chrome sends `Origin: chrome-extension://...`). [K] The usual fix is the `X-Atlassian-Token: no-check` header, together with a JSON content type. [A] A spike must confirm which context works on Confluence Cloud v2 today. Expected order of preference: (1) content script same-origin `fetch` with `X-Atlassian-Token: no-check`, (2) background `fetch` with `credentials: "include"`, (3) an API token (Basic auth with email and token) stored in `storage.local` as a fallback that does not depend on cookies.

Recommendation: send the publish call **from the content script on the Confluence tab** (same origin, real session, no CORS, works in both browsers). Fall back to an optional API token in settings. Keep `host_permissions` narrow (`https://*.atlassian.net/*`). Put "any page" support under `optional_host_permissions: ["<all_urls>"]` and request it at runtime, or use `activeTab` plus `scripting.executeScript` on demand.

## Sample Data

### Cross-browser MV3 manifest (as generated, or written by hand)

```json
{
  "manifest_version": 3,
  "name": "margin-notes",
  "version": "0.1.0",
  "description": "Private notes anchored to Confluence text, publishable as inline comments.",
  "browser_specific_settings": {
    "gecko": {
      "id": "margin-notes@s-baeumer.de",
      "strict_min_version": "140.0",
      "data_collection_permissions": { "required": ["none"] }
    }
  },
  "background": {
    "scripts": ["background.js"],
    "service_worker": "background.js",
    "type": "module"
  },
  "permissions": ["storage", "unlimitedStorage", "contextMenus", "activeTab", "scripting"],
  "host_permissions": ["https://*.atlassian.net/*"],
  "optional_host_permissions": ["<all_urls>"],
  "content_scripts": [
    {
      "matches": ["https://*.atlassian.net/wiki/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_title": "margin-notes", "default_popup": "popup.html" },
  "sidebar_action": {
    "default_title": "margin-notes review",
    "default_panel": "review.html",
    "open_at_install": false
  },
  "side_panel": { "default_path": "review.html" },
  "commands": {
    "add-note": {
      "suggested_key": { "default": "Alt+Shift+M" },
      "description": "Add a note to the current selection"
    },
    "_execute_sidebar_action": {
      "suggested_key": { "default": "Alt+Shift+R" }
    }
  }
}
```

Notes: [K] Each browser ignores keys it does not know (`sidebar_action` in Chrome, `side_panel` in Firefox), but may show a warning. WXT writes only the relevant key per target. `strict_min_version: 140.0` is needed for `data_collection_permissions` [V]. Chrome also needs the `sidePanel` permission for the `sidePanel` API [K].

### Unlisted signing (Firefox)

```sh
# one-time: AMO > Developer Hub > Manage API Keys
export WEB_EXT_API_KEY="user:12345678:123"      # JWT issuer
export WEB_EXT_API_SECRET="..."                 # JWT secret

wxt build -b firefox --mv3
web-ext lint   --source-dir .output/firefox-mv3
web-ext sign   --source-dir .output/firefox-mv3 --channel unlisted
# -> web-ext-artifacts/margin_notes-0.1.0.xpi (signed); install via about:addons > Install Add-on From File
```

### Publishing a note as an inline comment (Confluence REST v2) [V schema from Atlassian OpenAPI]

`POST /wiki/api/v2/inline-comments` (scope `write:comment:confluence`; permission: view the page and its space, plus create comments in the space)

```json
{
  "pageId": "123456789",
  "body": {
    "representation": "storage",
    "value": "<p>Is this number still correct after the Q3 change?</p>"
  },
  "inlineCommentProperties": {
    "textSelection": "p95 latency stays below 200 ms",
    "textSelectionMatchCount": 2,
    "textSelectionMatchIndex": 1
  }
}
```

`textSelectionMatchIndex` is zero-based and must be less than `textSelectionMatchCount`. The extension must count how often the exact quote appears in the page's rendered text, to tell Confluence which occurrence to highlight. `representation` allows `storage`, `atlas_doc_format` or `wiki`. A reply uses `parentCommentId` instead of `pageId` and has no `inlineCommentProperties`.

Content script call (same origin, cookie session):

```js
const res = await fetch("/wiki/api/v2/inline-comments", {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-Atlassian-Token": "no-check"
  },
  body: JSON.stringify(payload)
});
if (res.status === 403) { /* XSRF or permission: surface to user, offer API-token fallback */ }
```

### Local note record (proposed v1 shape for `storage.local`)

```json
{
  "note:7f1c2b9e-3a4d-4e55-9a1e-0c2f6d1b8a77": {
    "schemaVersion": 1,
    "id": "7f1c2b9e-3a4d-4e55-9a1e-0c2f6d1b8a77",
    "site": "acme.atlassian.net",
    "pageId": "123456789",
    "pageVersionAtCapture": 14,
    "url": "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456789/Design",
    "anchor": {
      "exact": "p95 latency stays below 200 ms",
      "prefix": "Under normal load the ",
      "suffix": " for all read paths",
      "matchIndex": 1,
      "matchCount": 2
    },
    "body": "Is this number still correct after the Q3 change?",
    "status": "draft",
    "publishedCommentId": null,
    "createdAt": "2026-10-02T09:14:00Z",
    "updatedAt": "2026-10-02T09:14:00Z",
    "deleted": false
  },
  "page:acme.atlassian.net:123456789": ["7f1c2b9e-3a4d-4e55-9a1e-0c2f6d1b8a77"]
}
```

Edge cases this shape anticipates: `status` moves from `draft` to `published` (with `publishedCommentId` set) or to `orphaned` (anchor text no longer found). `deleted: true` is a tombstone for v2 sync. Notes on pages outside Confluence have `pageId: null` and are keyed by the normalized URL.

## Implications for Design

1. **Background code must work as both an event page and a service worker.** No DOM APIs, no global state, top-level listeners only. Heavy logic (anchoring, HTML parsing) lives in the content script and the review page, not in the background.
2. **Host permission can be missing at runtime** (Firefox treats it as optional, and the user can revoke it). Every entry point checks `permissions.contains`, and the review panel shows a "grant access" state.
3. **Distribution = AMO unlisted signing** from v0.1. Fix the gecko ID now, because changing it later loses `storage.local`. Declare `data_collection_permissions: none`, which sets the minimum Firefox version to 140. Do a corporate policy check (`about:policies`) before investing.
4. **Storage is local first, with sync pluggable.** `storage.sync` cannot hold the notes long term (100 KB, no Android sync, no sync across browsers). Confluence content properties are rejected for privacy reasons (readable by everyone who can view the page, and writing needs edit rights). A private Git repo is the v2 backend. Export/import ships in v1 as both a backup and a manual sync.
5. **One shared review UI page** (`review.html`), mounted as the Firefox `sidebar_action` and the Chrome `side_panel`. Capture happens in page, inside a closed shadow root. The same storage schema is used everywhere.
6. **Publishing runs from the content script on the Confluence tab** (same origin, real session). This avoids CORS, SameSite and Total Cookie Protection questions. An API-token mode is the fallback for 403s or for publishing from the panel while the tab is closed.
7. **Anchoring has to match the comment API.** Confluence wants `textSelection` plus a match count and index, computed against the text Confluence sees (storage format). The note anchor stores `exact`, `prefix` and `suffix` (W3C Web Annotation TextQuoteSelector style) and the match index. Before publishing, recompute both against the current page and block publishing when the quote is no longer unique or no longer found.
8. **Spikes needed before writing the spec in full:** (a) which request context passes the Atlassian XSRF check on Cloud v2 (content script, background, or API token), (b) whether the rendered DOM text match count equals Confluence's own count for `textSelectionMatchIndex` (macros, expand sections, tables), (c) the actual time to sign an unlisted add-on, (d) Firefox `MAIN` world support, in case the page's own JS context is ever needed.

## Sources

- MDN, `background` manifest key: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
- MDN, `host_permissions`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions
- MDN, Content scripts (XHR/fetch, CORS, isolated world): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
- MDN, Chrome incompatibilities: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities
- MDN, `storage.sync`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync
- MDN, `storage.local`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local
- MDN, `sidebar_action`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action
- MDN, `scripting.ExecutionWorld`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld
- MDN, cookies API (partitioning, `moz-extension` not a partition key): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies
- Mozilla Hacks, Introducing State Partitioning: https://hacks.mozilla.org/2021/02/introducing-state-partitioning/
- Bugzilla 1655190 (cookies for extension requests with host permissions): https://bugzilla.mozilla.org/1655190
- Extension Workshop, MV3 migration guide: https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
- Extension Workshop, Signing and distribution overview: https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
- Extension Workshop, web-ext command reference: https://extensionworkshop.com/documentation/develop/web-ext-command-reference/
- Extension Workshop, Firefox built-in data collection consent: https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- Mozilla Add-ons blog, data collection consent changes (2025-10-23): https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/
- Extension Workshop enterprise distribution (source): https://github.com/mozilla/extension-workshop/blob/master/src/content/documentation/enterprise/enterprise-distribution.md
- Chrome, `chrome.storage` reference: https://developer.chrome.com/docs/extensions/reference/api/storage
- WXT, Extension APIs: https://wxt.dev/guide/essentials/extension-apis
- WXT, Entrypoints (sidepanel mapping): https://wxt.dev/guide/essentials/entrypoints
- WXT, Targeting different browsers (Firefox defaults to MV2): https://wxt.dev/guide/essentials/target-different-browsers
- WXT comparison page: https://wxt.dev/guide/resources/compare
- Framework comparisons 2026: https://dev.to/extensionbooster/plasmo-vs-crxjs-vs-wxt-which-chrome-extension-framework-should-you-use-in-2026-37o4 , https://kanopylabs.com/blog/wxt-vs-plasmo-vs-extension-js
- Atlassian, Confluence REST v2 content properties: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content-properties/
- Atlassian, Confluence REST v2 OpenAPI spec (inline comment schema, permissions, scopes): https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json
- Atlassian, Confluence REST v1 OpenAPI spec (user properties): https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json
- Atlassian, entity properties (32 KB limit, global namespace): https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/
- Atlassian KB, REST calls with a browser User-Agent may fail CSRF checks: https://support.atlassian.com/jira/kb/rest-api-calls-with-a-browser-user-agent-header-may-fail-csrf-checks/
- Atlassian developer community, XSRF check failed: https://community.developer.atlassian.com/t/rest-api-request-fails-with-xsrf-check-failed/22025
