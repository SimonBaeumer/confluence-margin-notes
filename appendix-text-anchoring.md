# Appendix: Text Anchoring and Highlighting

## Summary

This appendix covers how to describe a text selection so it can be found again after a reload and after other people edit the page, how the Hypothesis client does this in production today, and how to draw highlights without fighting a React-rendered page such as Confluence Cloud. The short version: store several W3C Web Annotation selectors per note (quote with context, plus position), re-anchor with Hypothesis-style fuzzy quote matching, treat failures as first-class "orphans", and paint with the CSS Custom Highlight API (fully usable in Firefox from version 146, hit-testing from 150) rather than wrapping text in spans.

## Findings

### W3C Web Annotation Data Model selectors

The W3C Web Annotation Data Model (Recommendation, 2017) defines a set of selectors that describe a segment of a resource. The ones relevant to HTML text:

| Selector | Fields | Robustness to edits | Notes |
|---|---|---|---|
| `TextQuoteSelector` | `exact` (required), `prefix`, `suffix` | High: survives moves and inserts elsewhere; breaks only if the quoted text itself changes a lot | The workhorse. Prefix and suffix disambiguate repeated quotes. Text is compared after normalization. |
| `TextPositionSelector` | `start`, `end` (character offsets, 0-based, end exclusive) | Low: any insert before the selection shifts offsets | Cheap and exact when the page is unchanged. Best used as a hint for the quote search. |
| `RangeSelector` | `startSelector`, `endSelector` (usually `XPathSelector`) | Low: depends on DOM structure, which React and Confluence change freely | Fast path only. |
| `XPathSelector` / `CssSelector` | `value` | Low to medium | Useful as a `refinedBy` scope (for example, "inside this block") if the page has stable ids. |
| `FragmentSelector` | `value`, `conformsTo` | Depends on the fragment | Could carry a text fragment (`#:~:text=`) for deep links. |

Every selector supports `refinedBy`, which applies one selector inside the result of another (for example a `CssSelector` for the content root refined by a `TextQuoteSelector`). The spec says multiple selectors on a target "SHOULD select the same content", which is exactly the "try several, verify against the quote" strategy Hypothesis uses.

Other model parts worth reusing: `motivation` (`commenting`, `highlighting`, `bookmarking`, `questioning`, `replying` and others), `TextualBody` with `value` and `format`, `creator`, `created`/`modified`, and `target.source` (the page URL). Using the W3C shape for storage costs little and makes export to Hypothesis or other tools trivial.

### How the Hypothesis client anchors (current `main` branch)

Source read directly from `hypothesis/client`, `src/annotator/anchoring/`.

**Describing a selection** (`html.ts`, `describe()`): for one DOM `Range`, it produces every selector type it can (`RangeSelector` with XPaths, `TextPositionSelector`, `TextQuoteSelector`, plus a media-time selector for transcripts), silently skipping any that fail. `TextQuoteAnchor.fromRange` captures **32 characters** of prefix and suffix (`const contextLen = 32`). Text is taken from "rendered text", where `<br>` is substituted by a space so that `<p>foo<br>bar</p>` yields `foo bar`, and offsets are mapped back to raw `textContent` positions.

**Re-anchoring** (`html.ts`, `anchor()`): selectors are tried in order "from simple to complex", each wrapped in a promise `catch` chain:

1. `RangeSelector` (XPath), then assert `range.toString() === quote.exact`.
2. `TextPositionSelector`, then the same quote assertion.
3. `TextQuoteSelector` with fuzzy search, using `TextPositionSelector.start` as a position `hint`.

If the quote check fails on the fast paths, it falls through to the quote search. An annotation without a `TextQuoteSelector` is treated as a page note and never highlighted.

**Fuzzy quote matching** (`match-quote.ts`, `matchQuote()`):

- First an exact `indexOf` scan for all occurrences. If any exist, only those are scored.
- Otherwise `approx-string-match` (Myers' bit-parallel algorithm, expected cost `O((maxErrors / 32) * text.length)`) finds candidates with `maxErrors = Math.min(256, quote.length / 2)`.
- Each candidate is scored with fixed weights: quote similarity **50**, prefix similarity **20**, suffix similarity **20**, proximity to the position hint **2** (tie breaker). Score is normalized to 0..1, and similarity is `1 - errors / length`.
- The best scoring candidate wins. Note: the doc comment mentions a "minimum quality threshold" but the current code returns the top candidate without one; a design for margin-notes should add an explicit threshold (for example reject below 0.7 and mark the note as "needs review") to avoid silently attaching to the wrong sentence.

**Orphans** (`guest.ts`, `anchor()`): an annotation is flagged `$orphan = true` when every target had selectors but none resolved to a region. The sidebar shows these in a separate "Orphans" tab instead of dropping them. The resolved `Range` is converted to a `TextRange` (offset based) immediately, so inserting highlight elements for other annotations does not invalidate it.

**Re-anchoring on DOM change**: for ordinary HTML, Hypothesis anchors once when the annotation loads and does **not** watch the page for mutations (the HTML integration's `MutationObserver` only watches `<head>` metadata for URL changes). Only the PDF integration observes the DOM (`MutationObserver` debounced at **100 ms**), re-anchors when PDF.js renders or destroys pages, and uses placeholder anchors for unrendered pages with a 3000 ms max wait when scrolling to one. This is the pattern to copy for a re-rendering SPA.

**Highlighting**: Hypothesis wraps each text node in the range with a custom `<hypothesis-highlight>` element (and draws SVG rects for PDFs). It does not use the CSS Custom Highlight API.

### Libraries

| Package | Latest | Last release | Status | Use |
|---|---|---|---|---|
| `approx-string-match` (Robert Knight, Hypothesis) | 2.0.0 | 2021-11 | Stable, still used by Hypothesis `main` (`^2.0.0`) | Fuzzy search core. Small, no deps. Recommended. |
| `dom-anchor-text-quote` (Randall Leeds) | 4.0.2 | 2017-02 | Unmaintained | Historic Hypothesis code, still used by Memex. Superseded by Hypothesis' in-tree `types.ts`. |
| `dom-anchor-text-position` | 5.0.0 | 2020-04 | Unmaintained | Same. |
| `@apache-annotator/dom` | 0.2.0 | 2021-09 | Project **retired** from the Apache Incubator on 2025-08-11, repo archived | Do not depend on it; useful as reading material (W3C selector implementations, `describeTextQuote` that picks minimal unique context). |
| `text-quote-selector` (hata6502) | 1.1.2 | 2023-11 | Small, single maintainer | Optional reference. |

Recommendation: depend only on `approx-string-match` and port (BSD-2 licensed) the ~500 lines of Hypothesis anchoring code (`types.ts`, `match-quote.ts`, `text-range.ts`, `rendered-text.ts`, `html.ts`) into the extension, adding a score threshold and a scoped root.

### Text fragments (`#:~:text=`)

Firefox supports opening text fragment links since **Firefox 131** (October 2024); creating them ("Copy Link to Highlight") arrived later behind a pref. Text fragments use `textStart,textEnd` with `prefix-` and `-suffix` but are **exact, word-boundary matches with no fuzziness**, so they are not a storage format for robust anchoring. They are useful for one thing: a deep link from the extension's note list back to the page that the browser itself scrolls to and highlights, even before the content script has re-anchored.

### Confluence specifics

- **Publishing as an inline comment** (REST API v2, `POST /wiki/api/v2/inline-comments`, scope `write:comment:confluence`): Confluence does not take offsets or XPaths. It takes `inlineCommentProperties.textSelection` (the exact text), `textSelectionMatchCount` (how many times that text occurs on the page) and `textSelectionMatchIndex` (zero-based which occurrence). So at publish time the extension must compute "occurrence N of M" of the re-anchored quote over the same text Confluence counts against (the page body as Confluence sees it, not the whole rendered page with nav, sidebar and macros). Atlassian community reports show the call fails when the count is computed over a different text scope (for example inside a macro body), so this mapping needs a spike. Selections that cross block boundaries (paragraphs, table cells) are a likely failure case; restrict publishable selections to a single block or warn.
- **Confluence orphans its own comments**: `InlineCommentResolutionStatus` is `open | reopened | resolved | dangling`. "Dangling" means the highlighted text was removed by an edit. Once published, a note's anchoring is Confluence's problem; margin-notes only needs to mirror the status.
- **Comment model fields**: `properties.inlineMarkerRef` ("Property value used to reference the highlighted element in DOM") and `properties.inlineOriginalSelection` (the highlighted text). The marker ref lets the extension find the published highlight in the rendered page and link a local note to its server comment.
- **Content root and versions**: Confluence Cloud view mode is rendered by the Atlaskit React renderer (content root observed as `.ak-renderer-document`; verify in a spike). Scoping anchoring to that root keeps offsets stable when the sidebar, breadcrumbs or comment counts change. Recording `pageId` and the page `version.number` at capture time allows a cheap "page edited since this note" signal and a fast path (same version means position selector is safe).

### Highlighting: wrapping spans vs CSS Custom Highlight API

**Wrapping spans** (Hypothesis, Memex, most highlighters): split text nodes and insert `<mark>`-like elements.

- Pros: works everywhere, easy click and hover handling, styling unlimited.
- Cons on React pages: React owns those text nodes. Foreign nodes get wiped on the next re-render, and worse, React can throw (`Failed to execute 'removeChild' on 'Node'`) when it tries to reconcile nodes that an extension moved. This is the long-standing React issue #11538 "Make React resilient to DOM mutations from Google Translate" (opened 2017, closed without a general fix). Confluence's renderer and editor are React, so wrapping risks both lost highlights and breaking the page for the user.

**CSS Custom Highlight API**: create `Range`s, group them in a `Highlight`, register with `CSS.highlights.set(name, highlight)`, style with `::highlight(name)`. No DOM mutation at all.

Firefox status (MDN browser-compat-data, checked 2026-10):

| Feature | Firefox |
|---|---|
| `Highlight`, `CSS.highlights` (`HighlightRegistry`), `::highlight()` | 140 (2025-06-24), enabled on all channels (bug 1964089) |
| `text-decoration` inside `::highlight()` | 146 (bug 1845446) |
| `text-shadow` inside `::highlight()` | 149 (bug 1845447); full support from 149 |
| `HighlightRegistry.highlightsFromPoint(x, y)` | 150 (2026-04-21, bug 1917991) |
| Chrome for comparison | 105 (API), `highlightsFromPoint` later |

Known Firefox quirk: `Highlight.prototype.add` is not chainable in Firefox 140 (`h.add(r1).add(r2)` fails); call `add` separately.

Limitations to design around:

- Allowed properties are limited: `color`, `background-color`, `text-decoration*`, `text-shadow`, `-webkit-text-stroke-*`/`-webkit-text-fill-color`. No `background-image`, borders, padding or pseudo content, so margin icons or comment-count badges must be separate overlay elements (positioned with `range.getClientRects()` in a shadow root outside React's tree).
- No events on highlights. Click and hover detection uses `highlightsFromPoint` (Firefox 150+) or manual hit testing with `getClientRects()`.
- Ranges in a highlight are live: if React replaces the text node, the range collapses or moves to the parent and the highlight silently disappears. Re-validate with `range.toString() === exact` after mutations.
- Name collisions: the page could register the same highlight name; prefix names (for example `margin-notes-private`, `margin-notes-pending`).
- Accessibility: highlights have no semantics; the note list in the sidebar is the accessible surface.
- Unverified for extensions: creating `Range`/`Highlight` objects in a Firefox content script (Xray-wrapped compartment) and registering them in the page's `CSS.highlights`. No bug report was found, but this must be checked in the first spike. Fallback: inject a tiny page-world script via `scripting.executeScript({world: "MAIN"})` that owns the registry.

### SPA re-renders and MutationObserver strategies

Patterns that apply to Confluence Cloud (React, client-side navigation between pages):

1. **Detect navigation**: Confluence changes URL without reload. Listen for `popstate`, poll or observe `<title>`, or use `webNavigation.onHistoryStateUpdated` in the background script, then re-run the full anchor pass for the new `pageId`.
2. **Wait for content**: anchor only once the content root exists and has been stable for a short window (for example no mutations for 300 ms), otherwise quotes match half-rendered text.
3. **Observe narrowly**: one `MutationObserver` on the content root with `{childList: true, subtree: true, characterData: true}`, debounced (Hypothesis PDF uses 100 ms). Ignore mutations caused by the extension itself (another reason not to wrap spans).
4. **Cheap validation first**: on each debounced batch, check each anchored range (`!range.collapsed && range.toString() === exact`). Only re-run the fuzzy search for notes that failed, and cache the page text so a batch of N failures costs one text extraction.
5. **Hysteresis for orphans**: do not flag a note as orphaned on a single failed pass while the page is still rendering; require it to fail after the content is stable. Collaborative edits from others arrive as live DOM updates in Confluence, so a note can legitimately flip between anchored, moved and orphaned during a session.
6. **Overlay outside React**: render margin markers in an extension-owned container (shadow DOM attached to `document.body` or a fixed overlay) and recompute positions on scroll, resize and `ResizeObserver` of the content root.

### Edge cases to plan for

- Repeated phrases ("TBD", "N/A"): prefix and suffix decide; 32 characters each is usually enough, consider 64 for short quotes.
- Very short quotes (one word): fuzzy matching with `maxErrors = len/2` can attach to an unrelated word; require exact match for quotes under ~8 characters, or widen context weight.
- Whitespace and `<br>` differences between capture and re-anchor: normalize the same way at both times (Hypothesis' rendered-text approach).
- Selections across table cells, list items, expand macros, or collapsed sections: collapsed content may not be in the DOM until expanded, which produces false orphans. Store a "block hint" (heading text or element id) to explain where the note was.
- Page edited so the quote now differs by a word: fuzzy match succeeds; show the original quote next to the note so the user can see what changed.

## Sample Data

W3C Web Annotation for a private note on a Confluence page (shape recommended for local storage and export):

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "id": "urn:uuid:5b0e8a8e-3c1f-4f5e-9d61-2c7f0b6d9a11",
  "type": "Annotation",
  "motivation": "commenting",
  "created": "2026-10-02T09:14:03Z",
  "modified": "2026-10-02T09:20:41Z",
  "creator": { "type": "Person", "nickname": "me" },
  "body": {
    "type": "TextualBody",
    "value": "Is 99.9% realistic given the single-AZ database? Ask Priya.",
    "format": "text/markdown"
  },
  "target": {
    "source": "https://example.atlassian.net/wiki/spaces/ENG/pages/123456789/Service+SLOs",
    "selector": [
      {
        "type": "CssSelector",
        "value": ".ak-renderer-document",
        "refinedBy": {
          "type": "TextQuoteSelector",
          "exact": "availability target of 99.9% per calendar month",
          "prefix": "The checkout service has an ",
          "suffix": ", measured at the load balancer"
        }
      },
      {
        "type": "CssSelector",
        "value": ".ak-renderer-document",
        "refinedBy": { "type": "TextPositionSelector", "start": 1842, "end": 1890 }
      }
    ]
  }
}
```

Hypothesis-style flat target (as produced by `describe()`; note the `RangeSelector` uses Hypothesis' own `startContainer`/`startOffset` XPath variant rather than the W3C `startSelector`/`endSelector` form, and is brittle on Confluence):

```json
{
  "source": "https://example.com/blog/post",
  "selector": [
    {
      "type": "RangeSelector",
      "startContainer": "/main[1]/article[1]/p[4]",
      "startOffset": 12,
      "endContainer": "/main[1]/article[1]/p[4]",
      "endOffset": 61
    },
    { "type": "TextPositionSelector", "start": 2210, "end": 2259 },
    {
      "type": "TextQuoteSelector",
      "exact": "the cache is invalidated on every deploy",
      "prefix": "In the current setup, however, ",
      "suffix": ". This means the first request af"
    }
  ]
}
```

Extension-side anchoring state for the same note (illustrative, not a standard):

```json
{
  "noteId": "5b0e8a8e-3c1f-4f5e-9d61-2c7f0b6d9a11",
  "site": "confluence",
  "pageId": "123456789",
  "capturedVersion": 17,
  "lastSeenVersion": 19,
  "anchorStatus": "anchored-fuzzy",
  "lastScore": 0.86,
  "lastAnchoredAt": "2026-10-02T11:02:00Z",
  "currentQuote": "availability target of 99.95% per calendar month",
  "blockHint": "h2: Targets",
  "published": null
}
```

Confluence inline comment create request (from the v2 OpenAPI schema `CreateInlineCommentModel`), publishing the second of three occurrences:

```json
{
  "pageId": "123456789",
  "body": {
    "representation": "storage",
    "value": "<p>Is 99.9% realistic given the single-AZ database?</p>"
  },
  "inlineCommentProperties": {
    "textSelection": "99.9%",
    "textSelectionMatchCount": 3,
    "textSelectionMatchIndex": 1
  }
}
```

Relevant part of the inline comment response model:

```json
{
  "id": "987654321",
  "status": "current",
  "pageId": "123456789",
  "resolutionStatus": "open",
  "resolutionLastModifierId": null,
  "resolutionLastModifiedAt": null,
  "version": { "number": 1, "createdAt": "2026-10-02T11:30:00.000Z" },
  "properties": {
    "inlineMarkerRef": "b7e0c3f2-1a2b-4c5d-8e9f-001122334455",
    "inlineOriginalSelection": "99.9%"
  }
}
```

Highlight API usage sketch:

```js
const priv = new Highlight();          // private notes
const pending = new Highlight();       // notes in the current review
priv.priority = 1; pending.priority = 2;
for (const r of privateRanges) priv.add(r);   // no chaining in Firefox
for (const r of pendingRanges) pending.add(r);
CSS.highlights.set("margin-notes-private", priv);
CSS.highlights.set("margin-notes-pending", pending);
/* injected stylesheet:
::highlight(margin-notes-private) { background-color: rgb(255 230 0 / .35); }
::highlight(margin-notes-pending) { background-color: rgb(0 120 255 / .25);
                                    text-decoration: underline dotted; }  // Firefox 146+
*/
```

## Implications for Design

- **Store selectors, not DOM paths.** Persist `TextQuoteSelector` (exact plus 32 to 64 characters of context) and `TextPositionSelector`, both relative to a scoped content root, plus `pageId` and captured page version. Skip `RangeSelector`/XPath for Confluence; it adds brittleness and no value once position plus quote verification exists.
- **Port Hypothesis' anchoring, add a threshold.** Order: position plus quote check (fast, exact), exact quote with context scoring, fuzzy quote via `approx-string-match`. Add a minimum score and a short-quote rule. Expose the outcome as a status (`anchored`, `anchored-fuzzy`, `orphaned`) because the UI needs it.
- **Orphans are a feature.** Keep them, show them in a dedicated list with the original quote and the block hint, and let the user re-attach by selecting new text (which just rewrites the selectors). Mirror Confluence's `dangling` status for published notes.
- **Use the CSS Custom Highlight API, not spans.** Set the minimum Firefox version to 146 (text-decoration for distinguishing pending vs private), or 150 if click-on-highlight via `highlightsFromPoint` is required; otherwise do manual hit testing. Overlay markers live in an extension-owned shadow root. This avoids the React reconciliation hazard on Confluence entirely.
- **Debounced re-anchoring loop.** One observer on the content root, 100 to 300 ms debounce, cheap range validation first, fuzzy search only for failures, hysteresis before declaring orphans, full re-run on SPA navigation.
- **Publishing needs a second mapping.** Converting a locally anchored note to a Confluence inline comment requires computing occurrence index and count of the exact text in Confluence's own body text. That is a separate algorithm from local anchoring and the riskiest integration point; spike it early. Restrict publishable selections to a single block.
- **Shared design surface.** The W3C annotation JSON is the natural internal model and export format for every interface (content script, sidebar, options page export, any future CLI). The anchoring module (describe, anchor, status) should be a pure function of `(root, selectors)` so it can be unit tested with saved Confluence HTML snapshots, independent of the browser extension shell.
- **Spike list.** (1) `CSS.highlights` from a Firefox content script. (2) Confluence content root selector and its stability across view mode, edit mode and live collaborative edits. (3) Inline comment `textSelectionMatchIndex` computation on pages with macros, tables and repeated text.

## Sources

- W3C Web Annotation Data Model, selectors and refinement: https://www.w3.org/TR/annotation-model/
- Hypothesis client anchoring source (read from `main`, 2026-10-02):
  - https://github.com/hypothesis/client/blob/main/src/annotator/anchoring/html.ts
  - https://github.com/hypothesis/client/blob/main/src/annotator/anchoring/match-quote.ts
  - https://github.com/hypothesis/client/blob/main/src/annotator/anchoring/types.ts
  - https://github.com/hypothesis/client/blob/main/src/annotator/guest.ts
  - https://github.com/hypothesis/client/blob/main/src/annotator/highlighter.ts
  - https://github.com/hypothesis/client/blob/main/src/annotator/integrations/pdf.tsx
  - https://github.com/hypothesis/client/blob/main/src/annotator/integrations/html.ts
- approx-string-match: https://github.com/robertknight/approx-string-match-js
- dom-anchor-text-quote: https://github.com/tilgovi/dom-anchor-text-quote ; dom-anchor-text-position: https://github.com/tilgovi/dom-anchor-text-position
- Apache Annotator (retired 2025-08-11): https://github.com/apache/incubator-annotator , https://incubator.apache.org/projects/annotator.html
- npm registry metadata for the packages above (`registry.npmjs.org`)
- MDN CSS Custom Highlight API: https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
- MDN `::highlight()`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::highlight
- MDN `highlightsFromPoint()`: https://developer.mozilla.org/en-US/docs/Web/API/HighlightRegistry/highlightsFromPoint
- MDN browser-compat-data: https://github.com/mdn/browser-compat-data (`css/selectors/highlight.json`, `api/HighlightRegistry.json`)
- Firefox 140 developer release notes: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/140
- Firefox 150 developer release notes: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/150
- Bugzilla 1964089 (enable Highlight API on all channels): https://bugzilla.mozilla.org/show_bug.cgi?id=1964089
- Firefox 131 developer release notes (text fragments): https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/131
- React issue #11538: https://github.com/facebook/react/issues/11538
- Confluence Cloud REST API v2, comments: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/ (schema read from https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json)
- Atlassian developer community, inline comment creation via API: https://community.developer.atlassian.com/t/programmatically-create-confluence-inline-comment/62847 , https://community.developer.atlassian.com/t/inline-comment-on-both-v-1-and-v-2-doesnt-provide-enough-data-to-recreate-the-inline-comment-using-post/68653
