# Explainer: Keeping Notes on the Right Text When the Page Changes

> How a private note stays attached to the passage it was written about, across page edits and versions, and how we make sure it lands on the right text when published.

## Intuition

Imagine putting a sticky note in a printed report. Later someone hands you a reprint where paragraphs were added, sentences reworded and pages renumbered. You don't look for "page 4, line 12" any more. You look for **the sentence you remember**, check that the **sentences around it** look familiar, and if the paragraph has a **section heading** you remember, you start there. If the sentence was rewritten you can probably still spot it. If it was deleted, you keep the sticky note aside and say so, rather than sticking it somewhere random.

margin-notes does exactly this, but it also has two advantages a human with a reprint doesn't: Confluence gives every paragraph a permanent **ID tag**, and it keeps **every old version** of the page. So the tool can look up the version you annotated and work out precisely where that text went.

## Mental Model

Confluence native comments and our private notes solve the problem differently:

- **Native inline comments are embedded in the document.** When you publish, Confluence puts an invisible `annotation` mark on the selected text in the page body. When someone edits the page, the mark travels with the text, like formatting does. That's why native comments stay attached after the author renames things. Once a note is published, **Confluence owns its anchoring** and we stop worrying about it.
- **Private notes cannot be embedded**, because that would change the page for everyone. So a private note stores a **description** of where it belongs and re-finds the spot every time the page loads. Each note records several independent clues at capture time:

| Clue | Example | Survives |
|---|---|---|
| Page id + version | `123456789`, v7 | Nothing (it is the reference point) |
| Block `localId` | `a1b2c3d4e5f6` (the paragraph or list item) | Edits inside the block, moving the block, edits elsewhere |
| Quote + context | "A short interruption…" with 64 chars before and after | Edits elsewhere, block re-creation |
| Offset in block / page | char 0 to 52 in that block | Nothing changing before it |

On load, the tool tries the cheapest, most precise clue first and falls back step by step. Each step must **re-verify the quote**, so a stale clue can never place the note silently on wrong text. The result is one of four visible states:

- **Anchored:** exact text found where expected.
- **Moved:** exact text found, but somewhere else (the block moved, or text was inserted before it).
- **Changed:** the text was edited. The note sits on the most likely successor, and you see "was: … / now: …".
- **Orphaned:** the text is gone. The note is listed in the sidebar's Orphans section with a "re-attach to selection" action.

**Trade-off:** more clues means more stored data per note (about 300 bytes) and slightly more work on load, but far fewer silent mis-placements. Silent mis-placement is the failure that matters most when a note gets published to colleagues.

## Mechanics

### Capture (when you select text and write a note)

1. Map the DOM selection to ADF via the renderer's `data-renderer-start-pos` attributes and find the enclosing block node and its `localId`.
2. Record:

```json
{
  "target": {
    "pageId": "123456789",
    "pageVersion": 7,
    "blockLocalId": "a1b2c3d4e5f6",
    "blockOffset": { "start": 0, "end": 52 },
    "quote": {
      "exact": "A short interruption during the rollout is expected.",
      "prefix": "…all teams move to the new schedule.",
      "suffix": "Known gap: the report can currently only…"
    },
    "pageTextPosition": { "start": 4810, "end": 4862 }
  }
}
```

The text model used for `blockOffset`, `quote` and `pageTextPosition` is the **ADF text model** that Confluence uses for `textSelectionMatchCount` (see [appendix-confluence-inline-comments-api.md](appendix-confluence-inline-comments-api.md)). Then the same coordinates serve both re-anchoring and publishing.

### Re-anchor cascade (every page load and SPA navigation)

```
fetch current page ADF + version (or read from the rendered DOM if version unchanged)

1. version == note.pageVersion
     → use blockLocalId + blockOffset directly          → ANCHORED (verify quote)
2. block with blockLocalId exists
     → exact search for quote.exact inside the block     → ANCHORED / MOVED
     → fuzzy search inside the block (approx-string-match)→ CHANGED (if score ≥ threshold)
3. version diff mapping:
     fetch body of note.pageVersion (Confluence keeps all versions),
     diff old page text → new page text (diff-match-patch),
     map pageTextPosition through the diff
     → if mapped span still equals quote.exact          → MOVED
     → if mapped span overlaps edited region            → CHANGED (show was/now)
4. whole-page fuzzy quote search, scored like Hypothesis
   (quote 50, prefix 20, suffix 20, proximity 2), require score ≥ threshold
   and require exact match for quotes < 8 chars       → MOVED / CHANGED
5. nothing above threshold                              → ORPHANED
```

After a successful re-anchor, the note's target is **rebased** onto the current version: it updates `pageVersion`, offsets, `localId` and the quote to the current text. It keeps `originalQuote` and `originalVersion` so the "was: …" view still works. Rebasing keeps step 3 cheap, because diffs stay small. Old version bodies are cached per `(pageId, version)` in `storage.local`.

### Repeated text (the `ShipmentRecord` problem)

A note on a term that appears 12 times is disambiguated by `blockLocalId` first, then by prefix and suffix, then by proximity to `pageTextPosition`. When none of these separate the candidates (identical sentences in two table cells after the block was re-created), the state is **CHANGED (ambiguous)** and you pick the occurrence once.

### Publishing safely

Publishing is where a wrong anchor becomes visible to colleagues, so it has a strict gate:

1. Right before each POST, fetch the current ADF + version.
2. Re-run the cascade against that fresh ADF. **Only ANCHORED or MOVED notes publish automatically.** CHANGED notes need one confirmation ("the text now reads …, publish here?"). ORPHANED or ambiguous notes are blocked until you re-attach them.
3. Compute `textSelection`, `textSelectionMatchCount` and `textSelectionMatchIndex` from that same fresh ADF, so the count and the anchor come from one snapshot.
4. POST. If the page version changed in between (someone saved during your submit), the server may reject with 400. Re-fetch and retry once, then leave the note as a draft with `lastError`.
5. On success, store `commentId` and `inlineMarkerRef`. Verify the response's `inlineOriginalSelection` equals what we sent. From now on Confluence's annotation mark is the source of truth, and our own highlight for this note is turned off.
6. During a review submit, steps 1 to 5 run **per note, sequentially**, because each publish inserts a new annotation mark and bumps the body.

## Edge Cases

- **`localId` stability is assumed, not yet proven.** The Confluence editor preserves `localId` attributes when text inside a block is edited, but it may regenerate them on copy-paste, block-type conversion (paragraph to list item), or legacy-editor conversion. That's why it is only a hint verified by the quote, never trusted alone. Spike: edit a test page and compare `localId`s across versions.
- **Old-version body fetch** (`GET /wiki/api/v2/pages/{id}?version=N&body-format=atlas_doc_format`) is assumed to work for all past versions. If not, fall back to storing a compact text snapshot of the block (not the whole page) at capture time.
- **Selections across blocks** (two paragraphs, or table cells) store a start and end clue pair. Whether Confluence accepts publishing them is an open spike question. If not, the composer warns at capture time for draft notes.
- **Unpublished edits.** Live Docs and collaborative editing can show content that is not yet a saved version. v1 anchors against saved versions only, and capture is disabled in edit mode.
- **Text inside code blocks or legacy macros** is invisible to Confluence's matching rules, so a note there can be private but cannot be published. The composer greys out "Add to review" for such selections.
- **Your own published comment gets resolved or the text deleted.** Confluence marks it `resolved` or `dangling`. Since two-way sync is out of scope, we only show the last-known state and a link.

## Sources

- Live ADF of a real RFC page via Rovo MCP `getConfluencePage` (2026-10-02): every block has `localId`, and inline comments are `annotation` marks with `id = inlineMarkerRef`, which can overlap.
- [appendix-text-anchoring.md](appendix-text-anchoring.md) (Hypothesis cascade and scoring), [appendix-confluence-inline-comments-api.md](appendix-confluence-inline-comments-api.md) (ADF match counting, versions).
- diff-match-patch (Google), whose `patch` and `diff_xIndex` functions map positions through a diff.
