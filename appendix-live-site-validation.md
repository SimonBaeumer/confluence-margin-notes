# Appendix: Live Site Validation (example.atlassian.net)

## Summary
A read-only check (done 2026-10-02 through the Atlassian Rovo MCP) of how existing inline comments on a real RFC page are stored. It confirms the shape of the data that margin-notes must produce when publishing, and shows what real review comments look like: short, often anchored to a single repeated term, and sometimes containing links and formatting. No writes were made.

## Findings

### Target site
- Site: `https://example.atlassian.net` (Confluence Cloud), cloudId `fb7d36eb-936c-4e86-bcd0-1fdbc3937b0a`.
- Test page: an RFC page in space `GF` (page id `2068971521`) with many open inline comments, several from the user during a review session on 2026-10-01. That is the workflow margin-notes targets.

### How an inline comment is stored
Each inline comment (v2 API, `atlas_doc_format`) carries:
- `properties.inlineMarkerRef`: a UUID. It links the comment to an `<ac:inline-comment-marker ac:ref="...">` element in the page body. So creating an inline comment **changes the page body**, because Confluence wraps the selected text in a marker.
- `properties.inlineOriginalSelection`: the exact selected text, kept even if the page text later changes.
- `resolutionStatus`: `open`, `resolved`, `reopened` or `dangling` (`dangling` means the marker is gone from the page because the text was deleted).
- `body`: ADF document. Real comments contain `hardBreak`, `strong` marks and `inlineCard` (smart links), not just plain text.

### What real selections look like
Observed `inlineOriginalSelection` values on this page:
- a whole sentence (about 110 characters),
- a sentence fragment (`and emits only a BaseOperatingPoint`),
- a single term that appears **many times** on the page (`XFRROperatingPoint`). Two separate comments use that exact selection.

The repeated-term case is the important one. When publishing, choosing the right occurrence (`textSelectionMatchIndex`) is required, not optional.

## Sample Data

```json
{
  "id": "2069954561",
  "status": "current",
  "createdAt": "2026-10-01T14:52:30.417Z",
  "resolutionStatus": "open",
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      { "type": "paragraph", "content": [
        { "type": "text", "text": "What was the historical context for this? (for my own curiosity)" }
      ]}
    ]
  },
  "properties": {
    "inlineMarkerRef": "fba113a2-d19c-4927-b788-a9ae551de77e",
    "inlineOriginalSelection": "and emits only a BaseOperatingPoint"
  }
}
```

```json
{
  "body": { "type": "doc", "version": 1, "content": [
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Where are these datapoints coming from?" },
      { "type": "hardBreak" },
      { "type": "text", "text": "I could not find them in " },
      { "type": "inlineCard", "attrs": { "url": "https://gitlab.com/..." } },
      { "type": "text", "text": "." }
    ]}
  ]},
  "properties": {
    "inlineMarkerRef": "b04d8047-b8cb-4d9e-8f28-93048bcfefaa",
    "inlineOriginalSelection": "XFRROperatingPoint"
  }
}
```

(Comment bodies shortened, author ids removed.)

## Implications for Design
- **Occurrence disambiguation is essential.** A note on a common term must record which occurrence was meant (TextQuote prefix/suffix plus position), and publishing must turn that into the right Confluence match index.
- **Publish needs rich text.** Notes should at least support paragraphs, line breaks, bold/italic, code and links, converted to ADF (or storage format) at publish time.
- **Published notes can be linked back.** After publishing, store the returned comment id and `inlineMarkerRef`. Then the extension can show "published, see comment" and stop drawing its own highlight, because Confluence draws its own.
- **Drift is detectable.** `dangling` status and `inlineOriginalSelection` tell us when the commented text has since disappeared.
- **The OAuth app scopes already include `write:comment:confluence`.** Publishing comments is allowed for this user on this site (it is how they comment today).

## Sources
- Atlassian Rovo MCP: `getAccessibleAtlassianResources`, `searchConfluenceUsingCql` (`type = comment AND lastmodified >= now("-30d")`), `getConfluencePageInlineComments` (page `2068971521`, `contentFormat: adf`).
