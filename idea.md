# margin-notes

## One-liner

A personal Firefox extension for private notes on Confluence pages (and later any web page), anchored to the text they're about. A note can be published as a native Confluence inline comment on its own, or together with others in one GitHub-style review.

## Problem

Confluence has only one kind of comment, and it is public and notifies people the moment you save it. Reviewing a long RFC therefore means one of two things:

- **Comment as you read.** Half-formed questions go out, some get answered three sections later, and the author gets a trickle of notifications for an unfinished review.
- **Take notes elsewhere** (a text file, paper) and re-type them as comments afterwards, finding each passage again by hand.

There is also a third kind of thought with no home at all: notes that should **never** be published (1:1 talking points, "ask X about this offline", opinions). Today they end up in a separate doc that has lost its connection to the passage.

Research found no existing tool that combines private notes anchored to text, local storage, and publishing as native Confluence comments ([appendix-prior-art.md](appendix-prior-art.md)).

## Who Is It For

One person: me, an engineering manager who reviews RFCs, designs and specs on `gridfuse.atlassian.net` in Firefox 150, on more than one machine. No team rollout, no store listing, no admin involvement.

## What Does Success Look Like

1. I can review an RFC like the 2026-10-01 XFRR one end to end without anyone being notified until I click **Submit review**.
2. Submitting publishes every draft as an inline comment on exactly the text I selected, including terms that appear many times on the page, in document order.
3. Private notes on the same page stay private forever, and I still see them highlighted when I come back weeks later.
4. When the author edits the page between my note and my submit, every note is either correctly re-attached or clearly flagged. **Nothing is ever published on the wrong text silently.**
5. In v2, notes I wrote on my laptop show up on my other machine.

## Core Concept

### Three kinds of note, one record

Every note is a single record with a **state**:

| State | Meaning | Highlight |
|---|---|---|
| **Private** | Only for me, never published | Yellow |
| **Draft** | Intended for publishing, waiting (usually part of a review) | Blue, with a "pending" badge |
| **Published** | Now a real Confluence inline comment, linked by comment id | None (Confluence draws its own), small marker links to the comment |

State changes:

```
            ┌──────── Keep private ────────┐
            ▼                              │
  [new] ─▶ Private ── Mark as draft ──▶ Draft ── Publish / Submit review ──▶ Published
            ▲                              │
            └──── Discard review ──────────┘
                                           └─ publish fails ─▶ Draft (+ error shown)
```

A note can always move between Private and Draft. Published is final in v1: no unpublish and no two-way sync.

### Capturing a note

Select text in the page and a small **"Add note"** button appears next to the selection (it can also be opened from the context menu or with a keyboard shortcut). It opens a popover with a small rich-text editor (paragraphs, line breaks, bold, italic, code, links, matching what real comments on our site use) and two buttons:

- **Keep private**
- **Add to review** (or **Publish now**, when no review is running)

Text that Confluence can't anchor comments to (inside code blocks or legacy macros) can only take private notes. The publish buttons are disabled with a short explanation.

### Reviewing a page

The **review** is a lightweight session on one page, borrowed from GitHub's UX and GitLab's per-note data model ([appendix-prior-art.md](appendix-prior-art.md)):

1. **Start review** (from the sidebar or the first "Add to review"). A banner and the toolbar badge show "Reviewing: 3 pending".
2. Add notes as you read. Each defaults to Draft while a review is running, and you can switch any of them to Private.
3. In the **sidebar** you see all notes on the page in document order, filtered by state. Click one to scroll to its highlight, and edit or delete drafts.
4. **Submit review:** a dialog lists the drafts with their anchor status. It has an optional summary field; when filled in, the summary is posted as a footer comment after the inline comments. **Submit** publishes them one by one with a progress view.
5. Partial failure is fine. Published notes are marked published, failed ones stay Draft with the error and a retry button.
6. **Discard review** turns all drafts back into Private notes. Nothing is lost.

**Promote** works outside a review too: any Private or Draft note has a **Publish now** action. It runs the same publish pipeline for a single note.

### Staying on the right text

A note can't be embedded in the page (that would change it for everyone), so it stores several clues and re-finds its spot on every load:

1. the block's stable `localId` from Confluence's document model,
2. the page version, so the tool can fetch that version and compare it with today's page,
3. the quoted text with context on each side,
4. positions within the block and the page.

The tool tries these from most to least precise, and every step must find the quote again before the note is placed. Each note shows its result: **anchored**, **moved**, **changed** ("was: … / now: …") or **orphaned** (listed in the sidebar with "re-attach to selection"). Successfully re-anchored notes are moved onto the current version.

Publishing adds a strict check. Right before each comment is posted, the latest page is fetched and the note is anchored again against that fresh copy. The occurrence Confluence needs (`textSelectionMatchIndex`) is computed from the same copy. Anchored and moved notes publish directly, changed notes need one confirmation, and orphaned or ambiguous notes are blocked.

Full mechanics: [appendix-explain-reanchoring.md](appendix-explain-reanchoring.md).

### Publishing

Comments are posted to Confluence's REST API (`POST /wiki/api/v2/inline-comments`, plus `footer-comments` for the summary). The request runs from the Confluence tab itself, so it uses my existing login with no setup. An API token in the settings is a fallback if that path is ever blocked. The note's rich text is converted to Confluence's document format (ADF). The occurrence count follows Confluence's own counting rules, ported from Atlassian's renderer ([appendix-confluence-inline-comments-api.md](appendix-confluence-inline-comments-api.md)). After success the note stores the comment id and marker id and links to the comment.

### Architecture at a glance

```
┌─────────────────────────────── Firefox extension ───────────────────────────────┐
│                                                                                  │
│  Content script (per tab)                     Sidebar (review panel)             │
│  ┌──────────────────────────────┐            ┌─────────────────────────┐        │
│  │ Site adapter                 │            │ notes on current page   │        │
│  │  ├ Confluence: root, page id,│◀─messages─▶│ filters, review banner  │        │
│  │  │  version, SPA nav, ADF,   │            │ submit dialog, progress │        │
│  │  │  publish                  │            └─────────────────────────┘        │
│  │  └ Generic (v1.1): URL, body │                                                │
│  │ Anchoring engine             │            Background (event page)            │
│  │ Highlights (CSS Highlight API)│◀─────────▶ ┌─────────────────────────┐        │
│  │ Capture popover (shadow DOM) │            │ NoteStore (storage.local)│        │
│  └──────────────────────────────┘            │ sync backend (v2)        │        │
│                                              └─────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Core:** notes, review sessions, anchoring, highlights, sidebar and store. Knows nothing about Confluence.
- **Site adapters:** provide what is specific to a site: content root, page identity and version, navigation events and, optionally, a **publish capability**. Confluence is the only adapter that can publish. A generic adapter (URL as identity, no publish) makes "notes on any page" a small addition.

### Storage and sync

- **v1:** everything in the extension's local storage on this machine, plus **Export / Import JSON** as a backup (local storage is wiped when the extension is uninstalled).
- **v2:** sync through a **restricted page in my Confluence personal space**. It uses the same login as publishing and stays within the company. The record format is designed for this from day one: stable ids, `updatedAt`, deletion markers (tombstones), and merging by "last writer wins" per note. Switching it on needs no migration.

## Key Design Decisions

1. **Browser extension, Firefox first.** Works on any page, needs no admin, and can use my existing Confluence session. Chrome later from the same codebase (WXT tooling). Rejected: userscript (weak storage and UI), Forge app (admin install, Confluence only). See [appendix-firefox-extension-platform.md](appendix-firefox-extension-platform.md).
2. **Per-note state (GitLab model), GitHub-style review UI.** Needed because private and draft notes live side by side on one page. The review is only a session, not a container that owns notes.
3. **Discard review keeps the notes.** Unlike GitLab, discarding turns drafts back into private notes. Losing review work is worse than having to tidy up.
4. **The summary comment is optional.** It is posted as a footer comment only when filled in.
5. **Publish through the tab's own session.** No setup and acts exactly as me. The trade-off is that it relies on undocumented behaviour, so an API token fallback exists.
6. **Anchoring based on Confluence's document model, not the visible text.** It uses block `localId`s, the version history and Confluence's own match-counting rules. This is more work than plain text search but is the only way to land on the right occurrence of a repeated term reliably.
7. **Never publish on an uncertain anchor.** Precision beats convenience whenever text becomes visible to colleagues.
8. **Highlights through the CSS Custom Highlight API.** It doesn't touch Confluence's DOM, so re-renders don't wipe highlights and nothing breaks. Firefox 150 adds click-to-open.
9. **Local-first, sync later through Confluence itself.** v1 ships without any sync infrastructure, and v2 reuses the auth we already have.
10. **View mode only in v1.** Notes are captured and shown on the rendered page, not in the editor.

## What This Is NOT

- Not a way to share private notes with others.
- Not AI-assisted (no suggestions, summaries or rewriting).
- Not two-way: replies, resolutions or edits made in Confluence are not pulled back into notes.
- Not for Confluence Data Center or Server, and not a publisher for other sites (GitLab, Google Docs). Generic pages get private notes only.
- Not distributed to others (no store listing, no team rollout).
- Not an editor-mode tool in v1 (no notes while editing a page or in Live Docs drafts).

## Language / Runtime

- **TypeScript** web extension, **Manifest V3**, built with **WXT** (forced to MV3 for Firefox) and **web-ext** for linting and self-signing through AMO's unlisted channel.
- Minimum **Firefox 150**. Chrome support comes later from the same code.
- Small, focused dependencies: `approx-string-match` (fuzzy matching), `diff-match-patch` (mapping positions across versions), and a small rich-text editor (choice deferred to the spec).
- Anchoring logic adapted from Hypothesis (BSD-2), and match counting ported from Atlassian's renderer.

## Releases

| Release | Contents |
|---|---|
| **v1** | Confluence adapter, private and draft notes, review with optional summary, Publish now, re-anchoring with visible status, sidebar, local storage, JSON export/import |
| **v1.1** | Generic adapter: private notes on any web page (opt-in per site) |
| **v2** | Sync through a restricted Confluence personal-space page. Chrome build |

Dependencies to respect: the v1.1 generic adapter depends on the core/adapter boundary from v1, and v2 sync depends on the v1 record format (ids, `updatedAt`, tombstones). Neither needs extra work in v1 beyond keeping those boundaries clean.

## Open Questions

**Spike on the real site before the spec is final** (becomes Task 0 of the plan):

1. Does a POST from the content script pass Atlassian's XSRF check in Firefox 150? What are the exact error bodies for "text not found" and "wrong match count"?
2. Are selections across paragraphs, table cells or formatting boundaries accepted by the API?
3. Does creating an inline comment bump the page version? Does the response include `inlineMarkerRef`?
4. Do block `localId`s survive in-block edits, moves and paragraph-to-list conversion? Does `GET /pages/{id}?version=N` return old ADF bodies?
5. Does the native highlight's `data-id` equal `inlineMarkerRef` (to link published notes to Confluence's highlights)?

**Decide (can be done during annotation):**

>> + Use "Draft comments" 6. Wording: "Review" (familiar from GitHub) or "Draft comments" (avoids a clash with Confluence page-approval apps)? This draft uses **Review**.
>> + For now ask every time7. Should a note created while a review is running default to Draft (as drafted) or ask every time?
>> + Yes, a global view would be nice. 8. Should orphaned notes from deleted or moved pages show up anywhere globally (an "all notes" view), or only on their page?
