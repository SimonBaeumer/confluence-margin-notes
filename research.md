# Research: margin-notes

## Problem Statement

When reviewing Confluence pages (RFCs, designs, specs), I want to write my thoughts down while reading, without each one showing up for the page author and watchers right away. Confluence only offers "comment now": every inline comment is public and sends a notification the moment it is saved. As a result:

- Half-formed questions get published, then edited or deleted once a later section answers them.
- Authors get a stream of notifications during my review instead of one coherent batch.
- Some thoughts are only for me (reminders, 1:1 talking points, opinions about people or politics) and must never be published.

**Who:** one user (me) on Confluence Cloud (`gridfuse.atlassian.net`), using Firefox first. Chrome may come later.

**What success looks like:**
1. Select text on a Confluence page and attach a private note. It survives reloads and page edits.
2. Each note is either **private** (never published) or **draft** (meant to be published).
3. A per-page **review**: collect drafts, edit and delete them, then submit everything at once as native Confluence inline comments. An optional summary becomes a footer comment.
4. Publishing a single note right away ("promote") also works, outside a review.
5. Nice-to-have: private notes on any web page.
6. Later: sync across my devices.

**Constraints:** personal tool, no admin install, no store listing required, Firefox release channel. Session-cookie or API-token auth only.

## Landscape

Full analysis in [appendix-prior-art.md](appendix-prior-art.md).

### Hypothesis
Open-source web annotator with an "Only Me" visibility setting. Notes are stored in Hypothesis's cloud, and it has no idea what a Confluence comment is. Its **anchoring engine** is the reference implementation for re-attaching notes to changing text (quote + position selectors, fuzzy matching, an orphans tab). It is BSD-2 licensed and can be reused. **Relevance:** we borrow the anchoring algorithm, not the product.

### Memex (WorldBrain)
A local-first annotator (IndexedDB) built on the older Hypothesis anchoring libraries. It shows that local-first notes in an extension are viable. It has no publish workflow.

### Diigo, Glasp, Weava, Liner
Cloud highlighters. Privacy is either a paid feature or not the default, and there is no Confluence integration. Not suitable.

### Confluence marketplace apps
"Notes for Confluence" offers private notes per page but not anchored to text, and with no promotion to comments. "Talk: Advanced Inline Comments" has restricted-visibility comments but is Data Center only, and both need an admin install. **No existing tool combines private anchored notes, local storage, and publishing as native inline comments.**

### GitHub and GitLab review flows
The UX model the user asked for.
- **GitHub:** "Start a review", a pending badge, a count on the submit button, and an optional summary comment.
- **GitLab:** each draft note is its own record, with `bulk_publish` to publish them all. Individual drafts can be published or deleted.

GitLab's per-note data model fits better, because we also need private notes that never publish. GitHub's UI conventions are the more familiar ones.

### Live site check
A read-only check of a real RFC page on our site ([appendix-live-site-validation.md](appendix-live-site-validation.md)). Real inline comments are often anchored to a term that appears **many times** on the page, and their bodies contain links, line breaks and bold text.

## Available Resources

### Confluence Cloud REST API v2
Details and payloads in [appendix-confluence-inline-comments-api.md](appendix-confluence-inline-comments-api.md).
- `POST /wiki/api/v2/inline-comments` takes `pageId`, `body` (`storage` or `atlas_doc_format`), and `inlineCommentProperties { textSelection, textSelectionMatchCount, textSelectionMatchIndex }`.
- `POST /wiki/api/v2/footer-comments` is used for the optional review summary.
- `GET /wiki/api/v2/pages/{id}?body-format=atlas_doc_format` returns the current version and the ADF, which is needed for match counting.
- **Critical finding:** Confluence counts matches against the page's **ADF text**, not the visible DOM text.
  - The text of each block is joined with no separator.
  - Mentions, emoji, status and dates count as empty text.
  - Code blocks and legacy macros are skipped.

  Atlassian's own renderer package contains the counting function (`getIndexMatch`), which we can port. A naive `window.getSelection().toString()` count will be wrong on real pages.
- Publishing an inline comment **changes the page body** (Confluence inserts a marker). With several comments in a row, recount before each POST.

### Authentication
- **Default:** a `fetch` from the content script on the Confluence tab. In Firefox MV3 that runs as the page itself (same origin, session cookies), which passes Atlassian's XSRF origin check.
- A POST from the background script likely fails with `403 XSRF check failed`.
- **Fallback:** an API token (Basic auth) stored in the extension settings.
- See [appendix-confluence-inline-comments-api.md](appendix-confluence-inline-comments-api.md) and [appendix-firefox-extension-platform.md](appendix-firefox-extension-platform.md).

### Confluence page DOM
- Content: `#main-content .ak-renderer-document`.
- Page id and version: `meta[name=ajs-page-id]`, `meta[name=ajs-page-version]`.
- Native highlights: `mark[data-mark-type=annotation][data-mark-annotation-type=inlineComment]`.
- Navigating to another page doesn't reload (single-page app), so the extension must watch for URL changes.
- Rendered nodes carry `data-renderer-start-pos`. That maps a DOM selection back to ADF positions.

### Text anchoring
Deep dive in [appendix-text-anchoring.md](appendix-text-anchoring.md).
- W3C `TextQuoteSelector` (the quoted text plus surrounding context) together with `TextPositionSelector` (character offsets).
- `approx-string-match` for fuzzy re-anchoring. It is maintained. The old `dom-anchor-*` libraries are dead.
- The **CSS Custom Highlight API** is in Firefox since 140, click hit-testing (`highlightsFromPoint`) since 150. It draws highlights without touching React's DOM, so Confluence re-renders don't wipe them.

### Firefox extension platform
Details in [appendix-firefox-extension-platform.md](appendix-firefox-extension-platform.md).
- **Background:** MV3 in Firefox uses an event page, not a service worker. Host permissions can be revoked by the user and must be checked at runtime.
- **Install:** Firefox release only installs signed add-ons, so we self-sign through AMO's unlisted channel (`web-ext sign`). New add-ons must declare `data_collection_permissions` (Firefox 140+).
- **Data loss risks:** `storage.local` is deleted on uninstall. Changing the add-on ID loses all data.
- **Sync quota:** `storage.sync` holds 100 KB total, 8 KB per item, 512 items, and doesn't reach Firefox Android or cross browsers.
- **Tooling:** WXT (forced to MV3 for Firefox) produces Firefox and Chrome builds from one codebase, including `sidebar_action` and `side_panel`.

## Approach Options

The browser extension (option A from intake) is decided. The remaining choices are inside it.

### Decision 1: Where notes live (storage and sync)

| Option | Effort | Privacy | Sync | Notes |
|---|---|---|---|---|
| **1a. `storage.local` + JSON export/import** | Low | Best (never leaves machine) | Manual | Lost on uninstall, so export is a safety net |
| 1b. `storage.sync` (Firefox Account) | Low | Good (Mozilla, end-to-end encrypted) | Automatic | 100 KB cap is about 200 to 400 notes, then it breaks. No mobile, no cross-browser |
| 1c. Private GitHub repo via Contents API | Medium | Good (private repo, needs a PAT) | Automatic, any browser | Personal access token in the extension. Company policy may object to work notes on GitHub |
| 1d. Restricted page in my Confluence personal space | Medium | OK (admins can see it) | Automatic, any browser | Same auth as publishing. Notes stay inside the company boundary |
| 1e. Confluence content properties on each page | Low | **Bad** (anyone with page access can read them) | Automatic | Ruled out for private notes |

**Recommendation:**
- **v1:** use 1a, behind a small `NoteStore` interface.
- **v2:** add a sync backend, where 1d (personal-space page) and 1c (GitHub) are the candidates. Prefer 1d if work notes must stay within company systems.
- Design the data model as a sync-friendly append log (ids, `updatedAt`, tombstones) from day one, so v2 doesn't need a migration.

### Decision 2: Publish path (auth)

| Option | Pros | Cons |
|---|---|---|
| **2a. Content-script fetch with the session cookie** | Zero setup, acts exactly as me, passes the XSRF check | Undocumented for third parties, could break |
| 2b. API token (Basic auth) from the background | Documented, stable | Setup step, a long-lived secret in extension storage |
| 2c. OAuth 3LO app | Proper | Needs an app registration and a redirect. Overkill for one user |

**Recommendation:** 2a as default, with 2b as a settings fallback that is used automatically if 2a returns 401 or 403.

### Decision 3: Computing `textSelectionMatchIndex`

| Option | Accuracy | Effort |
|---|---|---|
| **3a. Port Atlassian's `getIndexMatch` over fresh ADF, map the selection via `data-renderer-start-pos`** | Matches the server's rules | Medium |
| 3b. Count over the DOM text of `.ak-renderer-document` | Wrong whenever there are macros, mentions or code | Low |
| 3c. Try 3b, and on a 400 ask the user to pick the occurrence | Works, but annoying | Low |

**Recommendation:** 3a, with 3c's "pick the occurrence" dialog kept as the last-resort error path.

### Decision 4: Note lifecycle (data model)

Use GitLab-style per-note state rather than a single GitHub-style review object:

```
private  ──(mark as draft)──▶  draft  ──(publish / submit review)──▶  published
   ▲                              │                                     │
   └──────(keep private)──────────┘                     (stores commentId, link)
                                  └──(publish fails)──▶ draft + lastError
```

- A **review** is a lightweight per-page session: it has a start time and an optional summary, and points at its draft notes.
- **Submit review** publishes all drafts on the page in document order, then the optional summary as a footer comment.
- **Discard review** turns drafts back into private notes (it does not delete them).
- **Promote** on a single note publishes it immediately, with or without a review.

### Decision 5: UI surfaces

| Surface | Use |
|---|---|
| In-page popover (shadow DOM, near the selection) | Create and edit a note. Buttons: "Keep private", "Add to review" |
| Sidebar (`sidebar_action`, Chrome `side_panel` later) | Review panel: list of notes on this page in document order, filters (private, draft, published, orphaned), Submit review button with count |
| Highlights (CSS Custom Highlight API) + margin markers | Show where notes are. A different colour per state |
| Context menu + keyboard shortcut | Fast "add note on selection" |

**Recommendation:** all four. The sidebar is where the review happens, and the popover is where capture happens.

### Decision 6: Generic pages vs Confluence

Split the extension into a **core** (notes, anchoring, highlights, sidebar, storage) and **site adapters**. The Confluence adapter adds the content root, page identity, SPA navigation, the publish capability and rendering of native comments. A **generic adapter** (URL as identity, `document.body` as root, no publish) gives "notes on any page" almost for free, so it can ship in v1 or v1.1 behind a toggle.

## Out of Scope

- Sharing private notes with other people.
- AI suggestions or summaries.
- Two-way sync (pulling replies or resolutions back from Confluence into notes).
- Confluence Data Center or Server.
- Publishing to sites other than Confluence (generic pages get private notes only).
- Store listing and team distribution.

## Open Questions

Items that **block the spec** can be answered by a short spike on the real tenant. They become Task 0 of the plan rather than guesses.

1. **(Spike)** Does a content-script POST from Firefox MV3 pass the XSRF check on `gridfuse.atlassian.net`? What exact error body comes back for a wrong match count or for text that isn't found?
2. **(Spike)** Are selections spanning several paragraphs, table cells or a bold/link boundary accepted by the API?
3. **(Spike)** Does creating an inline comment bump the page version? Does the response include `inlineMarkerRef`?
4. **(Spike)** Does the highlight's `data-id` on the page equal the `inlineMarkerRef`? That would let us link published notes to native highlights.
5. **(Spike)** In edit mode and on Live Docs, can we capture notes at all, or is v1 view-mode only?
6. **(Decide)** Minimum Firefox version: 146 (underlined highlights) or 150 (click a highlight to open its note)? What version runs on your machines?
7. **(Decide)** Should the v2 sync backend be the personal Confluence space page (1d) or GitHub (1c)? This doesn't block v1.
8. **(Decide)** UI wording: "Review" or "Draft comments"? "Review" collides with Confluence page-approval apps, which is minor for a personal tool.

## Sources

- [appendix-live-site-validation.md](appendix-live-site-validation.md): read-only Rovo MCP check of page `2068971521`.
- [appendix-confluence-inline-comments-api.md](appendix-confluence-inline-comments-api.md): Atlassian REST v2 spec, `@atlaskit/renderer` source, a public Confluence page DOM.
- [appendix-text-anchoring.md](appendix-text-anchoring.md): W3C Web Annotation model, the hypothesis/client source, MDN for the Custom Highlight API.
- [appendix-firefox-extension-platform.md](appendix-firefox-extension-platform.md): MDN, Extension Workshop, WXT docs.
- [appendix-prior-art.md](appendix-prior-art.md): Hypothesis, Memex, Diigo, Glasp, Weava, Atlassian Marketplace, and the GitHub/GitLab review docs and APIs.
