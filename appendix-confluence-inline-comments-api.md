# Appendix: Confluence Cloud Inline Comments API, Auth, DOM and Limits

## Summary

This appendix covers what margin-notes needs from Confluence Cloud to turn a private, text-anchored note into a real Confluence inline comment: the v2 REST endpoints (inline comments, footer comments, replies, page versions), how Confluence computes the `textSelectionMatchCount` / `textSelectionMatchIndex` pair, how a browser extension can authenticate using the user's existing session, what the view-mode DOM looks like, and which rate limits apply to a 20-comment "review" publish. The single most important finding: match counting runs against the page's **ADF text content** (concatenated text of annotatable text blocks, with no separators, and with mentions, emoji, status, dates, code blocks and legacy macros contributing nothing). It does **not** run against the rendered DOM text or the storage XML. The extension must replicate that algorithm and not rely on `window.getSelection().toString()`.

Legend used throughout:

- **[Verified: spec]**: read directly from Atlassian's published OpenAPI v2 spec (`openapi-v2.v3.json`, downloaded 2026-10-02).
- **[Verified: source]**: read from Atlassian's published npm packages (`@atlaskit/renderer@147.0.0`, `@atlaskit/editor-common`, `@atlaskit/adf-schema`, latest on 2026-10-02). This is the code Confluence's own frontend uses.
- **[Verified: live]**: observed on a public Confluence Cloud site (`actonic.atlassian.net`, anonymous, read-only) via Chrome DevTools on 2026-10-02.
- **[Verified: docs/community]**: Atlassian docs page, KB, or Atlassian staff statement on the developer community.
- **[Assumption]**: plausible but not verified; must be validated against a real authenticated tenant before relying on it.

## Findings

### 1. `POST /wiki/api/v2/inline-comments`

#### Request body [Verified: spec]

Schema `CreateInlineCommentModel`:

| Field | Type | Notes |
|---|---|---|
| `pageId` | string | For a top-level comment on a page. Omit for replies. |
| `blogPostId` | string | For a top-level comment on a blog post. Omit for replies. |
| `parentCommentId` | string | For a reply. Omit `pageId` / `blogPostId` / `inlineCommentProperties`. |
| `body` | `CommentBodyWrite` or `CommentNestedBodyWrite` | See below. |
| `inlineCommentProperties.textSelection` | string | "The text to highlight". |
| `inlineCommentProperties.textSelectionMatchCount` | integer | "The number of matches for the selected text on the page (should be strictly greater than textSelectionMatchIndex)". |
| `inlineCommentProperties.textSelectionMatchIndex` | integer | "The match index to highlight. This is zero-based. E.g. if you have 3 occurrences of "hello world" on a page and you want to highlight the second occurrence, you should pass 1 for textSelectionMatchIndex and 3 for textSelectionMatchCount." |

The spec states `inlineCommentProperties` is "Only applicable for top level inline comments (not replies) and required in that case."

Body formats (`CommentBodyWrite`):

- Flat form: `{ "representation": "storage" | "atlas_doc_format" | "wiki", "value": "<string>" }`.
- Nested form (`CommentNestedBodyWrite`): `{ "storage": { "representation": "storage", "value": "..." } }` (only one key).
- For `atlas_doc_format`, `value` is a **JSON string** (the ADF document stringified), not an object. [Verified: spec says `value` is `type: string`]
- `wiki` (legacy wiki markup) is accepted on write, but read-side `body-format` only offers `storage` and `atlas_doc_format` for list endpoints. [Verified: spec]

Recommendation: use `storage` with simple `<p>`, `<strong>`, `<code>`, `<a>`, `<ul>` for user-typed Markdown-ish notes (easy to generate, easy to escape), or ADF if the extension already has a Markdown-to-ADF converter. Either way, HTML-escape user text.

#### Response [Verified: spec]

`201 Created`, `Location` header pointing to the new comment, body is `InlineCommentModel` plus `_links.base`. Relevant fields:

- `id`, `status` (`current`), `title`, `pageId` or `blogPostId`, `parentCommentId` (replies), `version` (`number`, `createdAt`, `authorId`, `minorEdit`, `message`).
- `resolutionStatus`: enum `open | reopened | resolved | dangling`.
- `properties.inlineMarkerRef`: "Property value used to reference the highlighted element in DOM."
- `properties.inlineOriginalSelection`: "Text that is highlighted."
- `_links.webui`.

Whether the create response includes `body` by default, and whether `properties.inlineMarkerRef` is populated in the create response (vs only on a later GET), is **[Assumption]**. Plan to do a follow-up `GET /wiki/api/v2/inline-comments/{id}` if the marker ref is needed.

#### Error responses [Verified: spec, partial]

- `400`: "Returned if an invalid request is provided." No documented error body shape. The Atlassian Rovo MCP tool for the same operation says "Incorrect or missing inlineCommentProperties can result in a 400 error from the Confluence API" [Verified: tool description shipped by Atlassian]. So "selection not found" and "matchCount mismatch" are both expected to surface as a generic 400.
- `401`: missing/incorrect credentials.
- `404`: page not found, no view permission, or "The user is forbidden from creating a comment tied to a resource they are allowed to view" (i.e. no comment permission returns 404, not 403).
- `403 XSRF check failed`: not in the spec, but returned by Atlassian's edge for browser-originated POSTs with a foreign `Origin` (see Auth section) [Verified: docs/community].
- `429`: rate limited, with `Retry-After` (see Rate limits).

The exact JSON error body for a bad selection (message text, whether it distinguishes "not found" vs "count mismatch") is **[Assumption: validate]**. A probable shape, based on other v2 errors, is:

```json
{ "errors": [ { "status": 400, "code": "INVALID_REQUEST_PARAMETER", "title": "...", "detail": null } ] }
```

#### How Confluence computes matchCount / matchIndex [Verified: source]

Atlassian staff on the developer community: "Those 3 fields you specified are used to find the text to highlight on the current version of the page. The POST will create a tag using those fields with a marker-ref and put it around the highlighted text in the page's body. The marker-ref is supposed to be the source of truth ... Data about the text matches/index is not persisted as the page's body may be changed" [Verified: community, SimonKliewer]. A second poster notes the frontend function is `convertSelectionToLegacyFormat`, which requires the top-level `.ak-renderer-document` element, and that counting only inside a macro iframe gives a wrong count that makes the create call fail.

The current renderer implementation is `getIndexMatch` in `@atlaskit/renderer/dist/es2019/actions/matches-utils.js`, whose header comment says: "Finds a string position using the Confluence annotation backend's serialisation rules." Paraphrased algorithm:

```js
// doc is the ProseMirror doc built from the page's ADF
let textContent = '';
doc.descendants((node, pos) => {
  const isBlockContainer = node.type.isBlock && !node.type.isLeaf && !node.type.inlineContent;
  // skip: text nodes themselves, nodes that do not allow the annotation mark,
  // and block containers (lists, tables, panels, layouts...) -> just descend
  if (node.isText || !node.type.allowsMarkType(annotation) || isBlockContainer) return true;
  // here: a text block that allows annotations (paragraph, heading, caption, ...)
  if (startIndex in [pos, pos + node.nodeSize]) {
    textContent += doc.textBetween(pos, startIndex - 1);
    matchIndex = countMatches(textContent, selectedText);   // occurrences BEFORE the selection
    textContent += doc.textBetween(startIndex, pos + node.nodeSize);
  } else {
    textContent += node.textContent;
  }
  return true;
});
numMatches = countMatches(textContent, selectedText);
// countMatches = (text.match(new RegExp(escapeRegex(query), 'g')) || []).length
```

and `originalSelection = doc.textBetween(from, to)` (no block separator argument).

Consequences:

1. **Text space = ADF text, not DOM text, not storage XML.** Each annotatable text block's `textContent` is concatenated **with no separator** between blocks. A selection across two paragraphs is therefore sent as `"end of para onestart of para two"` with no newline.
2. **Inline atoms contribute nothing.** `@atlaskit/adf-schema` defines no `leafText` for `mention`, `emoji`, `status`, `date`, `inlineCard`, `hardBreak`, so ProseMirror's `textContent`/`textBetween` yields `""` for them. The DOM shows `@Jane Doe`, an emoji glyph, a status lozenge label, a date string, a link card title, or a line break; the matching text contains none of those.
3. **Code blocks are excluded.** `codeBlock` is defined as `codeBlock_with_no_marks_node`, so it does not allow the annotation mark; its text is skipped by the counter and cannot be commented.
4. **Legacy / server-rendered macros are invisible.** Extensions (`toc`, Jira macro, etc.) carry no ADF text; their rendered DOM text is not counted and cannot be commented. Bodied extensions and expands are block containers; their inner paragraphs are counted. Expand titles are attributes, not text.
5. **Marks are ignored.** Bold/italic/link/inline-code/color boundaries do not break a match, since `textContent` drops marks. Selections across formatting are fine.
6. **Tables, lists, panels, layouts:** descended into; their paragraphs are counted like any other paragraph, in document order.
7. **Overlapping matches are not counted.** `String.match(/x/g)` is non-overlapping: `"aa"` in `"aaa"` counts 1. Edge case only.
8. **Case-sensitive, exact.** No whitespace normalization. Non-breaking spaces in ADF stay U+00A0.
9. **Allowed ranges** (`canApplyAnnotationOnRange` in editor-common): the range is invalid if it contains a non-text inline or leaf node (except `hardBreak`, and, behind the flag `editor_inline_comments_on_inline_nodes`, `emoji`, `status`, `date`, `mention`, `inlineCard`), or text whose parent does not allow annotations. Multi-paragraph ranges are allowed by the client validator. Whether the **backend** accepts a selection whose matched text spans two blocks is **[Assumption: validate]**; the frontend clearly produces such payloads.
10. **Empty selection** (only empty paragraphs) is rejected client-side (`isEmptyTextSelectionRenderer`).

Known community failure reports:

- Wrong count when computed from a subset of the page (macro iframe) causes create to fail [Verified: community].
- GET responses do not return `textSelectionMatchCount` / `textSelectionMatchIndex`, so a comment cannot be "re-created" from GET data; you must recompute [Verified: community].
- Forge `confluence:contextMenu` only exposes `selectedText`, not the index/count; feature request FRGE-1162 [Verified: community].
- Atlassian KB "Inline comments are not working with some 2 or 3 letters words or a selection of letters" exists (short selections) [Verified: search result title; details not read].
- Tools that compute counts from storage XML or Markdown get counts wrong whenever inline formatting, mentions or macros are present [Verified: community/GitHub issue reports, e.g. omnigent #4598 pattern].

#### v1 equivalent [Verified: spec]

The current v1 OpenAPI (`swagger.v3.json`) no longer lists any comment create endpoint; comment CRUD has moved to v2. Historic v1 payloads used `extensions.inlineProperties` with `originalSelection`, `numMatches`, `matchIndex`, `lastFetchTime`, `serializedHighlights`; a 2022 community thread reports `405 Method Not Allowed` for that path. v1 still offers `expand=extensions.inlineProperties,extensions.resolution` on reads. **Do not use v1 for writes.**

### 2. Footer comments and replies [Verified: spec]

- `POST /wiki/api/v2/footer-comments`, `CreateFooterCommentModel`: `pageId` | `blogPostId` | `parentCommentId` | `attachmentId` | `customContentId`, plus `body`. Same 201/400/401/404 semantics as inline.
- Replies to an inline thread: `POST /wiki/api/v2/inline-comments` with `parentCommentId` and `body` only. A third-party implementer observed that a v2 reply leaves the thread's resolution status unchanged [Verified: community/GitHub, not Atlassian].
- Resolve/reopen: `PUT /wiki/api/v2/inline-comments/{id}` with `{"version": {"number": current+1}, "body": ..., "resolved": true|false}`. "A dangling comment cannot be updated." Whether `body` is mandatory on a resolve-only PUT is **[Assumption: validate]**.
- Listing: `GET /wiki/api/v2/pages/{id}/inline-comments?resolution-status=open&body-format=storage&limit=250` (max 250, cursor via `Link` header). Each result has `properties.inlineMarkerRef` and `properties.inlineOriginalSelection`. Children: `GET /wiki/api/v2/inline-comments/{id}/children`.
- Scopes: OAuth `write:comment:confluence` for create/update, `read:comment:confluence` for reads; Connect `WRITE`/`READ`. Permission: view page + "Permission to create comments in the space".

### 3. Authentication from a browser extension

#### Options

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Session cookie via **content script** same-origin fetch | Content script on `https://*.atlassian.net/wiki/*` calls `fetch('/wiki/api/v2/inline-comments', {method:'POST', headers:{'Content-Type':'application/json'}, body})` | Zero setup; acts exactly as the user; same permissions as UI; `Origin` is the site origin so the XSRF origin check passes | Only works while a Confluence tab is open; uses an auth mode Atlassian does not document for third parties; content script must be on that tab |
| B. Session cookie via **background** fetch with `host_permissions` | `fetch('https://site.atlassian.net/wiki/api/v2/...', {credentials:'include'})` | Works without a tab-bound context | `Origin: chrome-extension://...` (Chrome) is foreign, so JSON POST fails `XSRF check failed` (403). Firefox behaviour differs (see below). Cookie partitioning / SameSite edge cases |
| C. Classic API token + Basic | `Authorization: Basic base64(email:token)` to `https://site.atlassian.net/wiki/api/v2/...` | Officially supported; not tied to browser session; comments still authored by the user | User must create and paste a token; token expires (default 1 year, 1 to 365 days for tokens created after 2024-12-15); storing it in extension storage is a secret-at-rest concern; still a browser UA so XSRF Origin rule may apply to background POSTs |
| D. Scoped API token | Basic auth against `https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/...` | Least privilege (`write:comment:confluence`, `read:page:confluence`, `read:comment:confluence`) | Needs `cloudId` (available in DOM meta `ajs-cloud-id` [Verified: live]); different host to permission |
| E. OAuth 2.0 (3LO) | Register app in developer console, PKCE-less confidential flow needs a client secret | Proper delegated auth | Overkill for a personal tool; client secret cannot be kept secret in an extension; refresh-token handling; points-based rate limits apply |

#### XSRF / Origin rules [Verified: docs/community]

Atlassian KB "Cross Site Request Forgery (CSRF) protection changes in Atlassian REST": a REST request is origin-checked when it is a **POST**, from a **known browser User-Agent**, with a Content-Type that is **not** `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain` or empty. It passes if `Origin`/`Referer` is the same origin as the application (or explicitly trusted). Failure is `403 XSRF check failed`. Community threads show `X-Atlassian-Token: no-check` alone does **not** fix a browser-extension POST; matching Origin or a non-browser UA does. One community answer claims Firefox add-ons do not send an extension `Origin` (unlike Chrome); whether that still holds for Firefox MV3 background `fetch` is **[Assumption: validate]**.

Mitigations if a background fetch is needed: rewrite `Origin` to `https://<site>.atlassian.net` with `declarativeNetRequest` `modifyHeaders` (requires host permission), or relay through the content script. Adding `X-Atlassian-Token: no-check` is harmless and still worth sending.

#### Content script fetch semantics [Verified: docs, MDN]

MDN: "In Chrome and Firefox in Manifest V3, these requests happen in context of the page, so they are made to a relative URL", and "content scripts are subject to the same CORS policy as the page they are running within" (Firefox 101+ MV3). `content.fetch()` is not available in MV3. So a content script `fetch('/wiki/api/v2/...')` is a same-origin request carrying the page's cookies and a same-origin `Origin` header. This is how Confluence's own frontend calls work (observed: `origin: https://actonic.atlassian.net`, `sec-fetch-site: same-origin`) [Verified: live]. Whether Firefox MV3 content-script fetch sends exactly the page `Origin` (vs omitting it, as MDN mentions for "privileged XHR and fetch instances") is **[Assumption: validate]**; either outcome passes the XSRF check (same origin, or no Origin header with a same-site Referer). This is option A and the recommended default.

#### Cookie-based auth status [Verified: docs/community, partially]

Atlassian deprecated *programmatic* cookie login (`/rest/auth/1/session`) for Cloud and recommends API tokens or OAuth. The browser session cookies (`cloud.session.token` and site-scoped `tenant.session.token`) still authenticate same-origin REST calls made by Confluence's own UI. Third-party use of them is undocumented, not prohibited by a published rule that we found, and could change. **[Assumption]** cookie names and attributes (domain, SameSite) not inspected on an authenticated tenant.

#### Internal endpoints used by the Confluence frontend [Verified: live]

On page view, the SPA calls `POST /gateway/api/graphql/pq/<sha256>?operation=<Name>` (persisted queries, e.g. `useAllCommentsDataQuery` with variables `{"pageId": "...", "contentStatus": [...], "first": 1500}`), with headers like `x-experimentalapi: confluence-agg-beta`, `atl-attribution`, `x-apollo-operation-name`. Also `/wiki/rest/create-dialog/1.0/...` and `/gateway/api/...`. These are private, hash-pinned and unversioned. **Do not build on them**; the public v2 REST endpoints are reachable with the same session.

### 4. Confluence Cloud page DOM (view mode)

All of the following is **[Verified: live]** unless marked.

- Content root: `div.ak-renderer-document`, inside `div.ak-renderer-wrapper.is-full-page`, inside `div#main-content.wiki-content[data-testid="pageContentRendererTestId"][data-test-appearance="full-page"]`. The renderer code itself treats `.ak-renderer-document` as the root (`isRendererRoot`) [Verified: source].
- Every block carries `data-renderer-start-pos="<ProseMirror position>"`, e.g. `<p data-renderer-start-pos="46">`. This is how the renderer maps a DOM `Range` to ADF positions [Verified: source, `steps/index.js resolvePos`]. The extension can use it to map a DOM selection to an ADF offset, then compute matchIndex on ADF.
- Headings wrapped in `div.renderer-heading-wrapper[data-testid="renderer-heading-wrapper"]` with an anchor copy button (button text is not ADF text, exclude it).
- Macros: `div.ak-renderer-extension[data-node-type="extension"][data-local-id=...]`.
- Title: `[data-testid="title-text"]`. Comments sidebar / footer: `[data-testid="object-comments-list-container"]`, `[data-testid="add-comment-button"]`.
- Existing inline comment highlights [Verified: source]: `<mark data-mark-type="annotation" data-mark-annotation-type="inlineComment" data-id="<annotation id>" data-mark-annotation-state="active|resolved" aria-details="<ids>" role="button">`. Use `mark[data-mark-type="annotation"][data-mark-annotation-type="inlineComment"]`. That the `data-id` equals the API's `properties.inlineMarkerRef` is **[Assumption, highly likely]** (ADF annotation id is the marker ref). Legacy (pre-Fabric) pages used `.inline-comment-marker.valid` with `data-ref`; only relevant for very old unconverted content.
- Page metadata in `<meta>` tags (updated on SPA navigation): `ajs-page-id`, `ajs-content-id`, `ajs-latest-page-id`, `ajs-page-version`, `ajs-page-title`, `ajs-space-key`, `ajs-content-type` (`page`/`blogpost`), `ajs-parent-page-id`, `ajs-cloud-id`, `ajs-base-url`, `ajs-atl-token` (legacy XSRF token), `ajs-remote-user`, `ajs-atlassian-account-id`.
- URL patterns: `/wiki/spaces/{KEY}/pages/{id}/{Title}` (view, verified), `/wiki/spaces/{KEY}/pages/edit-v2/{id}` (editor, from `_links.edituiv2`), `/wiki/x/{tiny}` (tiny link), `/pages/resumedraft.action?draftId={id}` (legacy edit). Blog posts: `/wiki/spaces/{KEY}/blog/{yyyy}/{mm}/{dd}/{id}/{Title}` **[Assumption]**. Prefer `ajs-page-id` meta over URL parsing.
- **SPA navigation**: clicking a page in the tree changed URL from page 1646166162 to 1646166159 without a document reload (a window global survived) and the `ajs-*` meta tags updated in place. The content script must watch `history` changes / `popstate` / a `MutationObserver` on the renderer root and re-anchor.
- **Edit mode** (`/edit-v2/`) renders ProseMirror editor DOM (`.ProseMirror`, `.ak-editor-content-area`) instead of `.ak-renderer-document` **[Assumption: selectors]**. Inline comments created via API while someone has the page open in the editor may conflict with the collaborative draft.
- **Live Docs**: per RFC-83, Live Docs are pages with `"subtype": "live"` in v2 responses; they open editable by default, can be toggled to "Viewing", and versions are automatic snapshots after edit sessions. `window.__SSR_IS_LIVE_PAGE__` was `false` on the test page [Verified: live]. On Live Docs the extension may see editor DOM rather than renderer DOM unless the user switches to view mode **[Assumption]**. Live Docs support inline comments [Verified: docs].

### 5. Page versions and drift detection

- `GET /wiki/api/v2/pages/{id}` returns `version` by default (`include-version` defaults to `true`) with `number`, `createdAt`, `authorId`, `message`, `minorEdit` [Verified: spec]. Observed an extra undocumented `version.ncsStepVersion` (collaborative editing step counter) [Verified: live].
- `?body-format=atlas_doc_format` returns `body.atlas_doc_format.value` as an ADF JSON string [Verified: live]. This is the input for computing matchCount/matchIndex. `body-format=storage` returns XML (do not count on it).
- `?version=N` fetches a historic version [Verified: spec]. Useful to show "page changed since your note" diffs.
- `_links` includes `webui`, `editui`, `edituiv2`, `tinyui`, `base` [Verified: live].
- `ajs-page-version` meta gives the version without a request [Verified: live].
- Whether creating an inline comment bumps the page version number (the marker is written into the body) is **[Assumption: validate]**. If it does, a review publish of 20 comments will change the version 20 times, so drift detection must compare the anchor text in fresh ADF, not just `version.number`, and recompute count/index before each POST.
- Drafts: `get-draft=true` returns the unpublished draft; comments anchor to the published body ("current version of the page") [Verified: community].

### 6. Rate limits [Verified: docs]

From developer.atlassian.com "Rate limiting" (Confluence Cloud):

- New points-based hourly quotas apply to **Forge, Connect and OAuth 2.0 (3LO) apps**; "API token-based traffic is not affected by this change, and will continue to be governed by existing burst rate limits." Enforcement start: March 2, 2026.
- Write operations cost only the 1 point base cost.
- Burst limits over "short time windows (typically seconds)" apply to all traffic; numbers are not published.
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-NearLimit`, `RateLimit-Reason`, `Retry-After` (429 only); beta `Beta-RateLimit-Policy`, `Beta-RateLimit`.
- Guidance: retry only idempotent calls with `Retry-After`; exponential backoff with jitter (0.7 to 1.3), doubling, max delay 30 s, max 4 retries.
- No rate-limit headers were present on an anonymous `GET /wiki/api/v2/pages/{id}` [Verified: live].
- Session-cookie traffic is presumably treated like the user's own UI traffic **[Assumption]**.

For about 20 inline comments plus 1 footer comment, totals are trivial for any quota. The risk is burst limiting if fired in parallel. Send sequentially (needed anyway, because each new marker may shift ADF and each POST should be preceded by a fresh count). POST is **not idempotent**: on a timeout or 5xx, re-list inline comments and match by `inlineOriginalSelection` + body before retrying to avoid duplicates.

## Sample Data

### A. Create a top-level inline comment (storage body)

Page ADF text (concatenated, as the counter sees it): `"OverviewWe deploy every Tuesday.Rollback is manual. We deploy every Tuesday unless frozen."`. The user selected the second `We deploy every Tuesday`.

```http
POST /wiki/api/v2/inline-comments HTTP/1.1
Host: example.atlassian.net
Content-Type: application/json
Accept: application/json
X-Atlassian-Token: no-check
```

```json
{
  "pageId": "1646166162",
  "body": {
    "representation": "storage",
    "value": "<p>Is this still true after the freeze policy change? See <a href=\"https://example.atlassian.net/wiki/x/koAeYg\">policy</a>.</p>"
  },
  "inlineCommentProperties": {
    "textSelection": "We deploy every Tuesday",
    "textSelectionMatchCount": 2,
    "textSelectionMatchIndex": 1
  }
}
```

Representative `201` response (shape from spec; values illustrative; `body` and `properties` presence on create **[Assumption]**):

```json
{
  "id": "1702330417",
  "status": "current",
  "title": "Re: Known issues",
  "pageId": "1646166162",
  "version": {
    "createdAt": "2026-10-02T09:14:03.512Z",
    "message": "",
    "number": 1,
    "minorEdit": false,
    "authorId": "62035c9fc4e2c9006ae65bd8"
  },
  "body": {
    "storage": {
      "representation": "storage",
      "value": "<p>Is this still true after the freeze policy change? See <a href=\"https://example.atlassian.net/wiki/x/koAeYg\">policy</a>.</p>"
    }
  },
  "resolutionStatus": "open",
  "resolutionLastModifierId": null,
  "resolutionLastModifiedAt": null,
  "properties": {
    "inlineMarkerRef": "6f3c2a9e-1d4b-4a8e-9a77-0c5e2b1f9d10",
    "inlineOriginalSelection": "We deploy every Tuesday"
  },
  "_links": {
    "webui": "/spaces/SICIE/pages/1646166162/Known+issues?focusedCommentId=1702330417",
    "base": "https://example.atlassian.net/wiki"
  }
}
```

### B. Reply to an existing inline thread (ADF body, note the stringified value)

```json
{
  "parentCommentId": "1702330417",
  "body": {
    "representation": "atlas_doc_format",
    "value": "{\"type\":\"doc\",\"version\":1,\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Agreed, \"},{\"type\":\"text\",\"text\":\"blocking\",\"marks\":[{\"type\":\"strong\"}]},{\"type\":\"text\",\"text\":\" for me.\"}]}]}"
  }
}
```

### C. Review summary as footer comment

```json
{
  "pageId": "1646166162",
  "body": {
    "representation": "storage",
    "value": "<p><strong>Review summary</strong> (7 inline comments)</p><ul><li>2 blocking: rollout plan, rollback</li><li>5 nits</li></ul><p>Overall: approve once rollback is automated.</p>"
  }
}
```

### D. Page fetch for count computation and drift check (trimmed, real response from public site)

`GET /wiki/api/v2/pages/1646166162?body-format=atlas_doc_format`

```json
{
  "id": "1646166162",
  "status": "current",
  "title": "Known issues",
  "spaceId": "1646166022",
  "version": {
    "number": 10,
    "message": "",
    "minorEdit": false,
    "authorId": "62035c9fc4e2c9006ae65bd8",
    "createdAt": "2024-01-30T14:57:11.062Z",
    "ncsStepVersion": "715"
  },
  "body": {
    "atlas_doc_format": {
      "representation": "atlas_doc_format",
      "value": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"},{\"type\":\"extension\",\"attrs\":{\"extensionType\":\"com.atlassian.confluence.macro.core\",\"extensionKey\":\"toc\",...}},{\"type\":\"heading\",\"attrs\":{\"level\":1},\"content\":[{\"text\":\"User mention cannot be added\",\"type\":\"text\"}]}, ...]}"
    }
  },
  "_links": {
    "editui": "/pages/resumedraft.action?draftId=1646166162",
    "webui": "/spaces/SICIE/pages/1646166162/Known+issues",
    "edituiv2": "/spaces/SICIE/pages/edit-v2/1646166162",
    "tinyui": "/x/koAeYg",
    "base": "https://actonic.atlassian.net/wiki"
  }
}
```

### E. Existing inline comment in ADF and in the rendered DOM

ADF (annotation mark on text):

```json
{
  "type": "paragraph",
  "content": [
    { "type": "text", "text": "We deploy " },
    { "type": "text", "text": "every Tuesday",
      "marks": [ { "type": "annotation",
                   "attrs": { "id": "6f3c2a9e-1d4b-4a8e-9a77-0c5e2b1f9d10", "annotationType": "inlineComment" } } ] },
    { "type": "text", "text": "." }
  ]
}
```

Rendered DOM (attributes from `@atlaskit/adf-schema` `buildDataAttributes` and renderer `MarkElement`):

```html
<p data-renderer-start-pos="120">We deploy
  <mark id="6f3c2a9e-1d4b-4a8e-9a77-0c5e2b1f9d10"
        data-mark-type="annotation"
        data-mark-annotation-type="inlineComment"
        data-id="6f3c2a9e-1d4b-4a8e-9a77-0c5e2b1f9d10"
        data-mark-annotation-state="active"
        aria-details="6f3c2a9e-1d4b-4a8e-9a77-0c5e2b1f9d10"
        role="button" tabindex="0">every Tuesday</mark>.</p>
```

### F. Edge case: DOM text vs counted text

Paragraph ADF: `[text "Ping ", mention(@Jane Doe), text " about the ", status("BLOCKED"), text " item"]`

- DOM `selection.toString()`: `"Ping @Jane Doe about the BLOCKED item"`
- Counted text: `"Ping  about the  item"` (two double spaces, atoms removed)
- Correct `textSelection` for a selection from "Ping" to "item": `"Ping  about the  item"`. Sending the DOM string would yield count 0 and a 400.
- With the `editor_inline_comments_on_inline_nodes` flag off, the client validator rejects this range entirely because it contains non-text inline nodes.

### G. Rate limit headers (doc-defined names, illustrative values)

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 7
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2026-10-02T09:15:00Z
X-RateLimit-NearLimit: true
RateLimit-Reason: confluence-burst-based
```

## Implications for Design

1. **Anchor model must be ADF-based.** Store, per note: `pageId`, page `version.number` at capture time, the ADF-space `textSelection` string, ADF start/end positions (from `data-renderer-start-pos` mapping), the matchIndex/matchCount at capture time, plus a DOM-space quote with prefix/suffix context (for re-anchoring highlights locally, W3C TextQuoteSelector style). The two text spaces differ; keep both.
2. **Port `getIndexMatch` exactly.** Implement the counter in the extension against ADF fetched with `body-format=atlas_doc_format`, using the same skip rules (annotatable text blocks only, no separators, atoms empty, code blocks excluded, regex non-overlapping). Pin to the renderer version you ported and add a unit-test fixture corpus (tables, lists, mentions, emoji, code blocks, macros, multi-paragraph). Alternatively, call into the page's own renderer actions, which is fragile and not exposed.
3. **Recompute at publish time, one at a time.** For each pending note in a review: fetch fresh ADF, locate the stored quote, recompute count/index, POST, then move on. If the quote is gone or ambiguous, mark the note "needs re-anchor" and let the user pick, or offer to publish it as a footer comment quoting the original text.
4. **Restrict what can be noted.** Disable (or warn on) selections inside code blocks, legacy macros, expand titles, heading anchor buttons, and selections that include mentions/status/emoji/dates/cards. Multi-paragraph selections should be flagged as "validate" until the backend behaviour is confirmed; a safe fallback is to trim to the first block.
5. **Default auth: content-script same-origin fetch** with the user's session. No token setup, author is the user, XSRF passes. Offer API token (classic, or scoped via `api.atlassian.com/ex/confluence/{cloudId}`) as an optional fallback for background publishing. Skip OAuth 3LO.
6. **Handle SPA navigation** via `ajs-page-id` meta changes and a MutationObserver on `.ak-renderer-document`; detect editor/live mode and degrade (no anchoring) when the renderer root is absent.
7. **Review publish is sequential with dedupe.** No parallelism; respect `Retry-After`; on uncertain failures, list `pages/{id}/inline-comments` and match by `inlineOriginalSelection` + body before retrying. Footer summary goes last, optionally linking each published inline comment via `_links.webui`.
8. **Shared surface:** one `ConfluenceClient` module (fetch wrapper with XSRF header, backoff, error normalization) and one `AdfTextIndex` module (ADF to counted text, position mapping, count/index) serve local highlight rendering, drift detection, and publishing alike.

### Open questions to validate on a real tenant

- Exact 400 error body for selection-not-found and for count mismatch.
- Does the backend accept multi-paragraph and table-cell-spanning selections?
- Does creating an inline comment bump `version.number`?
- Does the create response include `properties.inlineMarkerRef` and `body`?
- Is `mark[data-id]` equal to `inlineMarkerRef`?
- Firefox MV3: Origin header on background `fetch` and on content-script `fetch`; cookie partitioning behaviour for background requests.
- Behaviour on Live Docs in editing mode, and when the target page has an open collaborative editing session.
- Short-selection limitation from the Atlassian KB article (2 to 3 letter words).

## Sources

- Confluence REST API v2, Comment group: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/
- OpenAPI v2 spec (primary source for schemas): https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json
- OpenAPI v1 spec: https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json
- Confluence Cloud rate limiting: https://developer.atlassian.com/cloud/confluence/rate-limiting/
- Atlassian staff on matchCount/matchIndex and marker-ref: https://community.developer.atlassian.com/t/inline-comment-on-both-v-1-and-v-2-doesnt-provide-enough-data-to-recreate-the-inline-comment-using-post/68653
- Forge contextMenu lacks match data (FRGE-1162): https://community.developer.atlassian.com/t/confluence-contextmenu-to-create-inline-comment/66974
- v1 inline comment create attempt (405): https://community.developer.atlassian.com/t/programmatically-create-confluence-inline-comment/62847
- confluence-cli v2 inline comments feature notes: https://github.com/pchuri/confluence-cli/issues/251
- markdown-confluence annotation handling: https://github.com/markdown-confluence/markdown-confluence/pull/944
- Legacy DOM marker gist: https://gist.github.com/ideadapt/51907d43df0b7b1f0b85467a491fbca2
- KB, short-word inline comment issue: https://support.atlassian.com/confluence/kb/inline-comments-are-not-working-with-some-2-or-3-letters-words-or-a-selection-of-letters/
- CSRF protection rules in Atlassian REST: https://confluence.atlassian.com/kb/cross-site-request-forgery-csrf-protection-changes-in-atlassian-rest-779294918.html
- KB, browser User-Agent fails CSRF checks: https://support.atlassian.com/jira/kb/rest-api-calls-with-a-browser-user-agent-header-may-fail-csrf-checks/
- Extension XSRF thread: https://community.developer.atlassian.com/t/rest-api-request-fails-with-xsrf-check-failed/22025
- MDN, content scripts (fetch in MV3): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
- Scoped API tokens: https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/
- Manage API tokens (expiry): https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- Cookie-based auth (deprecated programmatic login): https://developer.atlassian.com/cloud/jira/platform/jira-rest-api-cookie-based-authentication/
- RFC-83 Live Docs: https://community.developer.atlassian.com/t/rfc-83-live-docs-pages-in-confluence-cloud/88495
- npm `@atlaskit/renderer@147.0.0`: `dist/es2019/actions/matches-utils.js` (`getIndexMatch`, `countMatches`), `actions/index.js` (`applyAnnotation`, `generateAnnotationIndexMatch`), `steps/index.js` (`resolvePos`, `isRendererRoot`), `ui/annotations/element/mark.js`, `react/marks/annotation.js`
- npm `@atlaskit/editor-common` latest: `dist/es2019/utils/annotation/index.js` (`canApplyAnnotationOnRange`, `isEmptyTextSelectionRenderer`)
- npm `@atlaskit/adf-schema` latest: `schema/marks/annotation.js` (`buildDataAttributes`, `AnnotationMarkStates`), `schema/nodes/code-block.js`
- Live observation (anonymous, read-only) of https://actonic.atlassian.net/wiki/spaces/SICIE/pages/1646166162/Known+issues via Chrome DevTools: DOM structure, `ajs-*` meta tags, v2 page GET response and headers, GraphQL persisted queries, SPA navigation
- Atlassian Rovo MCP `createConfluenceInlineComment` tool description (schema only, not invoked)
