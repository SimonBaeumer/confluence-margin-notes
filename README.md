# margin-notes

A personal Firefox extension for private notes on Confluence Cloud pages, anchored to the text they're about. A note can stay private forever, or become a **draft comment** that is published as a native Confluence inline comment, either on its own (**Publish now**) or together with others in one batch (**Submit**), GitHub-review style. Nobody is notified until you publish.

Background, research and design: [idea.md](idea.md), [research.md](research.md) and the `appendix-*.md` files.

## Using it

- **Select text** on a Confluence page (view mode), then click **Add note** (or press `Alt+Shift+M`, or use the context menu). Write the note and choose:
  - **Keep private**: yellow highlight, never published.
  - **Add draft comment**: blue highlight, collected for the next submit.
  - **Publish now**: posted as an inline comment right away.
- **Click a highlight** to edit the note, switch it between private and draft, publish it, or delete it.
- The **Draft comments** pill at the bottom right shows how many drafts are pending. **Submit** opens a dialog with every draft in document order and an optional summary (posted as a page comment after the inline comments). **Discard** turns all drafts back into private notes; nothing is deleted.
- The **sidebar** (toolbar button or `Alt+Shift+N`) lists the notes on the current page with filters, shows notes that need attention (text changed, ambiguous, orphaned), lets you re-attach them to a new selection, and has an **All notes** view across pages plus JSON export/import.

### Staying on the right text

Each note stores the block `localId`, the page version, the quote with 64 characters of context and its offsets, all in Confluence's own ADF text model. On every load it is re-found through a cascade (same version, block id, version diff, fuzzy quote search) and shows its result: **anchored**, **moved**, **changed** ("was: …"), **ambiguous** or **orphaned**.

Publishing re-checks every note against the latest page right before its POST. Anchored and moved notes publish directly, changed ones need a confirmation, ambiguous and orphaned ones are blocked. The occurrence index Confluence needs is computed from that same fresh snapshot. Nothing is ever published on uncertain text.

## Verified on Confluence Cloud (2026-10-02, Firefox 154)

The open spike questions from [idea.md](idea.md), answered on a test page with a long RFC-style document:

| Question | Answer |
|---|---|
| Does a content-script POST pass the XSRF check? | Yes. Same-origin `fetch` with the session cookie works; no token needed. |
| Error bodies for a bad selection? | Text not found, wrong match count and index out of range all return the same `400 {"errors":[{"code":"BAD_REQUEST","title":"Can not create inline comment"}]}`. The server verifies the count, so a wrong count can never land on the wrong text. |
| Selections across paragraphs, formatting, smart links? | All accepted. The selection is sent in the ADF text model (`"release.Phase 2 and 3"`, atoms as empty text) and Confluence marks every text piece in range. |
| Does a comment bump the page version? | No. The body gains an `annotation` mark but `version.number` stays the same. |
| `inlineMarkerRef` in the create response? | Yes, in `properties`. The rendered `mark[data-id]` equals it. |
| Do highlights from a content script reach the page? | Yes, `CSS.highlights` registrations from the isolated world render normally. |
| Renderer positions? | `data-renderer-start-pos` is the position after the block's opening token. Code blocks carry none and are found by `data-local-id`. |
| Re-anchoring after an edit (API edit: insertion at top, reworded sentence, deleted paragraph)? | Repeated term kept its occurrence, moved text anchored, the reworded sentence became **changed** (publishing asked for confirmation), the deleted one became **orphaned** and could be re-attached. |

Not verified yet: whether the Confluence *editor* keeps block `localId`s on edits (the test edited via the API, which keeps them; the cascade does not depend on it), and behaviour on Live Docs.

## Development

```sh
npm install
npm run check        # typecheck + unit tests
npm run dev          # Firefox with the extension loaded, hot reload
npm run build        # .output/firefox-mv3
npm run lint:ext     # web-ext lint (what AMO runs when signing)
```

`npm run build:e2e` builds a test variant: the in-page UI uses an open shadow root, and two DOM events are available for browser automation (`mn-e2e-debug` writes the content script state to `document.documentElement.dataset.mnDebug`, `mn-e2e-open-sidebar` opens the sidebar page in a tab pinned to the current tab).

### Layout

| Path | What |
|---|---|
| `src/core/adf-text.ts` | ADF text model and match counting, ported from `getIndexMatch` in `@atlaskit/renderer` |
| `src/core/anchoring.ts` | Describe and re-anchor targets (quote scoring adapted from Hypothesis, BSD-2) |
| `src/core/store.ts` | `NoteStore` on `storage.local`: one key per note, tombstones, export/import |
| `src/core/rich-text.ts` | Note bodies as an ADF subset, editor DOM to ADF and back |
| `src/confluence/client.ts` | REST v2 client (same-origin session, API token fallback, 429 backoff) |
| `src/confluence/dom.ts` | DOM ⇄ ADF offset mapping via `data-renderer-start-pos` and a per-block text diff |
| `src/confluence/publish.ts` | Publish gate, sequential submit, duplicate detection after uncertain failures |
| `src/content/` | Content script: page lifecycle, highlights (CSS Custom Highlight API), in-page UI |
| `entrypoints/sidepanel/` | Sidebar (Preact) |
| `entrypoints/background.ts` | Context menu, keyboard command, toolbar badge |

## Installing permanently

Firefox release only installs signed add-ons. Sign through AMO's unlisted channel (no store listing):

```sh
export WEB_EXT_API_KEY=...      # AMO > Developer Hub > Manage API Keys (JWT issuer)
export WEB_EXT_API_SECRET=...
npm run build && npm run sign   # signed .xpi in web-ext-artifacts/
```

Then install it via `about:addons` > gear > **Install Add-on From File**. Keep the add-on ID (`margin-notes@simonbaeumer.local`) unchanged, or `storage.local` (all your notes) is lost. Uninstalling also deletes it, so export regularly.
