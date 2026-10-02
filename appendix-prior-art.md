# Appendix: Prior Art for Private Annotation and Review Workflows

## Summary

This appendix surveys existing web annotation tools (Hypothesis, Diigo, Glasp, Weava, Memex, Liner), Confluence marketplace apps that offer private or restricted comments, and the batch review workflows of GitHub, GitLab and Google Docs. No existing tool combines all three things margin-notes wants: private text-anchored notes on Confluence Cloud, local-only storage, and a "collect drafts, then publish selected ones as native Confluence inline comments" review flow. The closest conceptual match is Hypothesis "Only Me" annotations plus GitLab draft notes; the closest data model match is GitLab's draft notes API.

## Findings

### Web annotation tools

| Tool | Private notes | Storage | Anchoring | Confluence fit | Status (2026) |
|---|---|---|---|---|---|
| Hypothesis | Yes: "Only Me" visibility; also private groups | Cloud (hypothes.is or self-hosted `h` server) | W3C selectors, fuzzy quote matching (see anchoring appendix) | Works on any page via extension, but notes live on Hypothesis servers, which is a data-leak concern for internal Confluence content; no Confluence integration | Active, open source (BSD-2) |
| Memex (WorldBrain) | Yes, private by default | Offline-first (IndexedDB via Dexie), optional cloud sync and sharing via "Spaces" | `dom-anchor-text-quote`, `dom-anchor-text-position`, `approx-string-match`, `dom-highlight-range` (same lineage as Hypothesis) | Generic; no Confluence publishing | Open source, last push 2025-12, extension 3.20.x |
| Diigo | Yes: highlights and sticky notes private, group, or shared link | Cloud | Proprietary | Generic | Long-lived, slow-moving |
| Glasp | Private only on paid plans; free highlights are public by default | Cloud | Proprietary | Generic; social-first, wrong default for work content | Active |
| Weava | Yes, folders and citations | Cloud | Proprietary | Generic, research and citation oriented | Active |
| Liner | Started as a highlighter (2016), now an AI research and search product | Cloud | Proprietary | Not relevant anymore | Pivoted |

Notes per tool:

- **Hypothesis.** Three visibility levels: public, group, and "Only Me" (padlock icon). Its own help documents a "draft" workflow: post as Only Me, later edit and switch visibility to a group. That is a manual, one-at-a-time version of review mode, and it proves that "private first, publish later" is a natural workflow for annotators. Privacy is implemented as permissions on a server record (`permissions.read` contains only the user), so "private" still means "stored on someone else's server". Strengths: the best open anchoring implementation, an Orphans tab, and a documented JSON API. Weakness for this idea: cloud storage of notes on internal pages, and nothing it publishes ends up as a Confluence-native comment.
- **Memex.** The most relevant local-first precedent: everything in IndexedDB on the device, export via `dexie-export-import`, optional sync. Shows that a single-user, local-only extension with optional export is viable. It reuses the old Hypothesis anchoring libraries, confirming those are the community default.
- **Glasp, Weava, Diigo.** Mainstream cloud highlighters. Patterns worth borrowing: colors per highlight, a per-page list of notes in a sidebar, a global "all my notes" dashboard with search, Markdown/CSV export. Glasp's public-by-default is a warning: the default visibility must be private.
- **Liner.** Illustrates that pure highlighting is a commodity; value comes from workflow integration (here: Confluence publishing and review mode).

### Confluence marketplace apps

- **Notes for Confluence** (Cloud, Forge, v3.0.0 released 2026-09): private personal notes per page, opened from the page byline, "Only the author can view, edit, or delete their note", stored in Atlassian infrastructure, page content untouched. Notes are **page level, not anchored to text**, and there is no publish-to-comment path. Roadmap mentions multiple notes, public notes, and a dashboard. Validates demand for private notes on Confluence; leaves text anchoring and review mode open.
- **Talk: Advanced Inline Comments** (Stiltsoft): inline comments with per-discussion viewing permissions (users and groups), space-level default permissions, comment reports and archiving. **Data Center only** (marketplace listing: `cloud: false, dataCenter: true`), so not available for Confluence Cloud. Its existence shows teams want restricted-visibility inline comments, but restricted is still "shared with someone", not private drafts.
- **Native Confluence Cloud.** Inline comments made while editing a page are visible only to people in that editing session until the page is published; after publishing, unresolved ones become visible to viewers. This is a narrow form of drafts tied to editing, not to reviewing someone else's published page. There is no native "pending review" for viewers.
- **Document workflow apps** (Comala Document Management, Workflows for Confluence): approval states for pages, not private comments. Not prior art for the note UX, but a reminder that "review" in Confluence often means page approval workflows; naming should avoid confusion.

### GitHub pull request reviews

UX:

- On a diff line, the user chooses **"Add single comment"** (publishes now) or **"Start a review"** (creates a pending review). After starting, the button becomes **"Add review comment"**.
- Pending comments render inline with a **"Pending"** label; a counter on the "Finish your review" / "Review changes" button shows how many are pending.
- Pending comments can be edited or deleted freely; nobody else sees them.
- Submitting opens a dialog with an optional summary body and a verdict: **Comment**, **Approve**, **Request changes**. All pending comments publish at once, as one review, with one notification.
- A user can have **only one pending review per pull request** at a time. Pending reviews persist across sessions and devices (they are server side).

Data model (REST): a review has `state` (`PENDING`, then `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`), an optional `body`, `submitted_at` (null while pending), and child review comments linked by `pull_request_review_id`. Create a pending review by calling `POST /repos/{owner}/{repo}/pulls/{n}/reviews` **without** `event`; submit with `POST .../reviews/{review_id}/events` and `event`; only unsubmitted reviews can be deleted (`DELETE .../reviews/{review_id}`).

### GitLab merge request reviews and draft notes

UX:

- **"Start a review"** (also flips reviewer status to "Reviewer started review"), then **"Add to review"** for each comment, or **"Add comment now"** to bypass the review.
- Pending comments carry an **"Unpublished"** indicator.
- A draft can also carry thread actions: "Resolve thread" / "Reopen thread" applied when published.
- **"Your review"** panel lists all pending comments for editing, then submit with an outcome (**Approve**, **Comment**, **Request changes**) and an optional summary. **"Discard review"** deletes all drafts (irreversible).
- Quick action `/submit_review` submits from a normal comment.

Data model (REST `draft_notes`): each draft is an independent resource on the MR with `note`, optional `position` (diff anchor), optional `in_reply_to_discussion_id`, `resolve_discussion`, `commit_id`. Drafts can be listed, fetched, updated, deleted, **published one at a time** (`PUT .../draft_notes/:id/publish`) or **all at once** (`POST .../draft_notes/bulk_publish`). There is no separate "review" object; the review is simply "all my drafts on this MR".

GitLab's model is closer to margin-notes than GitHub's: drafts are individual records that can be published singly or in bulk, which maps directly onto "some notes get published, some stay private".

### Google Docs suggesting mode

- A mode switch (Editing / Suggesting / Viewing) changes what every edit means: in Suggesting mode, edits become proposals shown as colored inline changes with a comment card.
- The owner accepts or rejects each suggestion inline, or uses **Tools > Review suggested edits** to step through them with **Accept all** / **Reject all**.
- Suggestions and comments are visible to collaborators immediately; there is no private draft phase. Relevant patterns: an explicit, visible **mode** indicator, a review panel that steps through items in document order, and bulk accept/reject.

### Synthesis: the pending vs submitted lifecycle

Across GitHub, GitLab and Hypothesis, a note has a small lifecycle:

```
private (never published)          draft/pending (in a review)        published
       |   "add to review"  --->          |   "submit review"  --->      |
       |  <--- "remove from review"       |   "publish single"  --->     |
       |                                  |   "discard review" ---> deleted
```

GitHub and GitLab only have the middle and right states; Hypothesis has left and right but no batch. margin-notes needs all three, plus local-only "private forever" being the default.

## Sample Data

GitLab: create a draft note (request) and the documented response shape:

```http
POST /api/v4/projects/42/merge_requests/7/draft_notes
Content-Type: application/json

{
  "note": "This retry loop never backs off. Should we cap it?",
  "position": {
    "position_type": "text",
    "base_sha": "a1b2c3", "start_sha": "a1b2c3", "head_sha": "d4e5f6",
    "new_path": "src/retry.ts", "old_path": "src/retry.ts",
    "new_line": 58
  },
  "resolve_discussion": false
}
```

```json
{
  "id": 5,
  "author_id": 23,
  "merge_request_id": 11,
  "resolve_discussion": false,
  "discussion_id": null,
  "note": "Example title",
  "commit_id": null,
  "line_code": null,
  "position": {
    "base_sha": null,
    "start_sha": null,
    "head_sha": null,
    "old_path": null,
    "new_path": null,
    "position_type": "text",
    "old_line": null,
    "new_line": null,
    "line_range": null
  }
}
```

GitLab: publish all drafts of the current user on an MR (no body), or a single one:

```http
POST /api/v4/projects/42/merge_requests/7/draft_notes/bulk_publish
PUT  /api/v4/projects/42/merge_requests/7/draft_notes/5/publish
```

GitHub: create a pending review (no `event`), then submit it:

```http
POST /repos/acme/shop/pulls/12/reviews
{
  "commit_id": "ecdd80bb57125d7ba9641ffaa4d7d2c19d3f3091",
  "body": "This is close to perfect! Please address the suggested inline change.",
  "comments": [
    { "path": "file.md", "position": 6, "body": "Please add more information here, and fix this typo." },
    { "path": "src/app.ts", "line": 40, "side": "RIGHT", "start_line": 36, "start_side": "RIGHT",
      "body": "Multi-line comment on lines 36 to 40." }
  ]
}

POST /repos/acme/shop/pulls/12/reviews/80/events
{ "event": "COMMENT", "body": "Optional summary, replaces or adds the review body." }
```

```json
{
  "id": 80,
  "user": { "login": "octocat" },
  "body": "",
  "state": "PENDING",
  "submitted_at": null,
  "commit_id": "ecdd80bb57125d7ba9641ffaa4d7d2c19d3f3091",
  "pull_request_url": "https://api.github.com/repos/acme/shop/pulls/12"
}
```

Hypothesis: a private ("Only Me") annotation as returned by its API (abridged). Privacy is expressed as `permissions.read` containing only the author:

```json
{
  "id": "Rq8f2ZbVEeyQ1Ofk",
  "created": "2026-09-30T08:01:12.512Z",
  "updated": "2026-09-30T08:01:12.512Z",
  "user": "acct:simon@hypothes.is",
  "uri": "https://example.com/article",
  "text": "Check this claim against the Q3 numbers.",
  "tags": ["todo"],
  "group": "__world__",
  "permissions": {
    "read": ["acct:simon@hypothes.is"],
    "admin": ["acct:simon@hypothes.is"],
    "update": ["acct:simon@hypothes.is"],
    "delete": ["acct:simon@hypothes.is"]
  },
  "target": [
    {
      "source": "https://example.com/article",
      "selector": [
        { "type": "TextPositionSelector", "start": 4120, "end": 4161 },
        { "type": "TextQuoteSelector", "exact": "revenue grew 40% quarter over quarter",
          "prefix": "In the last reporting period ", "suffix": ", driven mostly by" }
      ]
    }
  ],
  "document": { "title": ["Example article"] },
  "hidden": false,
  "flagged": false
}
```

Illustrative margin-notes review record, borrowing GitLab's "drafts are independent records" model (not a standard):

```json
{
  "reviewId": "rv_01J9Z3K7Q2",
  "pageId": "123456789",
  "pageUrl": "https://example.atlassian.net/wiki/spaces/ENG/pages/123456789",
  "state": "open",
  "startedAt": "2026-10-02T09:00:00Z",
  "submittedAt": null,
  "summary": null,
  "noteIds": ["5b0e8a8e-3c1f-4f5e-9d61-2c7f0b6d9a11", "c0ffee00-1111-2222-3333-444455556666"],
  "results": []
}
```

## Implications for Design

- **Default private, local, forever.** Every competitor that stores in the cloud (Hypothesis, Diigo, Glasp, Weava, Notes for Confluence) is a poor fit for internal Confluence content; Memex shows local-first works. Store in extension storage (IndexedDB or `storage.local`) with explicit export/import; make any sync an opt-in later.
- **Three-state lifecycle per note.** `private` (default), `pending` (in the current review), `published` (linked to a Confluence comment id). Moving between private and pending must be cheap and reversible; publishing is the only one-way step. This is the gap no existing tool fills.
- **Borrow GitLab's data model, GitHub's UX.** Drafts as independent note records that can be published singly ("Add comment now" equivalent: "Publish now") or in bulk ("Submit review"). The review itself is just a grouping with an optional summary; Confluence has no review object, so the summary would become a footer comment (optional, like GitHub's body).
- **Borrow these UX patterns:**
  - "Start a review" as an explicit mode with a persistent, visible indicator and pending count (GitHub button counter, GitLab "Your review" panel, Google Docs mode switch).
  - Two buttons at note creation while a review is active: "Add to review" and "Keep private" (GitLab's "Add to review" vs "Add comment now", adapted).
  - A "Unpublished" / "Pending" badge on draft highlights, and a distinct highlight style for private vs pending.
  - A review panel listing pending notes in document order with edit, delete, "move back to private", and a final submit with optional summary.
  - "Discard review" that returns notes to private rather than deleting them (safer than GitLab's irreversible discard, because private notes have standalone value here).
  - One open review per page (GitHub constraint), which keeps the model simple.
  - An Orphans list (Hypothesis) for notes that no longer anchor, with "re-attach".
- **Partial failure on submit.** GitLab and GitHub submit atomically on the server; margin-notes will create N separate Confluence inline comments, each of which can fail (text not found, match index wrong, permissions). The review must record per-note results and leave failed notes pending with an error, so submit is resumable.
- **Naming.** "Review" in Confluence often means page approval (Comala, Workflows). Consider labels like "Draft comments" or "Comment batch" in UI copy to avoid confusion, while keeping "review" internally.
- **Interop for free.** Storing notes as W3C annotations (see anchoring appendix) makes export to Hypothesis format nearly a field rename, which is a good escape hatch for the user.

## Sources

- Hypothesis annotation basics and visibility: https://web.hypothes.is/help/annotation-basics/
- Hypothesis drafts via "Only Me": https://web.hypothes.is/help/saving-draft-annotations-before-sharing-with-your-group/
- Hypothesis privacy policy: https://web.hypothes.is/privacy/
- Hypothesis API docs: https://h.readthedocs.io/en/latest/api-reference/
- Memex repository and dependencies: https://github.com/WorldBrain/Memex (package.json on `develop`), Firefox add-on: https://addons.mozilla.org/en-US/firefox/addon/worldbrain/
- Glasp private highlights: https://glasp.co/features/private-highlight
- Weava: https://www.weavatools.com/organize-with-weava/
- Diigo: https://en.wikipedia.org/wiki/Diigo
- Liner pivot: https://liner.com/news/from-highlighter-to-search-giant-liner%E2%80%99s-10-year-bet-on-information-discovery
- Notes for Confluence: https://marketplace.atlassian.com/apps/1562042119/notes-for-confluence (details from Marketplace REST API `rest/2/addons/notes.for.confluence/versions/latest`)
- Talk: Advanced Inline Comments: https://marketplace.atlassian.com/apps/978531/talk-advanced-inline-comments , permissions docs: https://docs.stiltsoft.com/display/Talk/Managing+Permissions (hosting from Marketplace REST API)
- Confluence Cloud comments help (inline comments while editing): https://support.atlassian.com/confluence-cloud/docs/comment-on-pages-and-blog-posts/
- GitHub REST API, pull request reviews: https://docs.github.com/en/rest/pulls/reviews
- GitHub docs, reviewing proposed changes: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request
- GitLab draft notes API: https://docs.gitlab.com/api/draft_notes/
- GitLab merge request reviews: https://docs.gitlab.com/user/project/merge_requests/reviews/
- Google Docs suggest edits: https://support.google.com/docs/answer/6033474
- Google Docs API, comments and suggestions: https://developers.google.com/workspace/docs/api/how-tos/suggestions
