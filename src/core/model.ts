// Note records and related types. Everything here is plain JSON so it can go
// through storage.local, runtime messaging and (in v2) a sync backend as is.

export const SCHEMA_VERSION = 1;

/**
 * "published" only lives on as a tombstone: once a note is published, its
 * comment is read from Confluence (see CommentRecord) and the note itself is
 * deleted (see graduate.ts).
 */
export type NoteState = 'private' | 'draft' | 'published';

/** Result of the last re-anchoring pass, shown next to every note. */
export type AnchorStatus = 'anchored' | 'moved' | 'changed' | 'ambiguous' | 'orphaned' | 'pending';

/** Minimal ADF document as produced by the note editor. */
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/** Identifies the page a note belongs to. */
export interface PageRef {
  /** "confluence:<host>:<pageId>" or, for generic pages, "url:<normalized url>". */
  key: string;
  site: string;
  pageId: string | null;
  url: string;
  title: string;
}

/**
 * Where the note sits. Offsets are in the ADF text model (see adf-text.ts),
 * which is the same text Confluence counts inline comment matches against.
 */
export interface Target {
  pageVersion: number;
  startBlockLocalId: string | null;
  endBlockLocalId: string | null;
  /** Offsets within the start block / end block. */
  startBlockOffset: number;
  endBlockOffset: number;
  /** Offsets in the concatenated page text. */
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
  /** Text and version at capture time, kept for the "was: … / now: …" view. */
  originalExact: string;
  originalVersion: number;
}

/** Confluence's resolution status of an inline comment, plus "deleted" when it is gone. */
export type CommentResolution = 'open' | 'reopened' | 'resolved' | 'dangling' | 'deleted';

export interface CommentReply {
  id: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string | null;
  text: string;
  /** Written by the author of the comment (you). */
  mine: boolean;
}

/** What happened to a published comment in Confluence, read back on page loads. */
export interface CommentThread {
  resolution: CommentResolution;
  replies: CommentReply[];
  /** When the resolution or the replies last changed. */
  changedAt: string;
  /** Replies created up to this time count as read. */
  seenAt: string | null;
}

export interface PublishInfo {
  commentId: string;
  inlineMarkerRef: string | null;
  webUrl: string | null;
  publishedAt: string;
  /** Only in data from older versions, which tracked the thread on the note. */
  thread?: CommentThread | null;
}

/**
 * An inline comment as last read from Confluence, kept in this browser only
 * (never synced: Confluence is the source of truth). Covers your comments and
 * other people's, whether published through margin-notes or not.
 */
export interface CommentRecord {
  /** The Confluence comment id. */
  id: string;
  page: PageRef;
  authorId: string | null;
  authorName: string | null;
  /** Written by you. */
  mine: boolean;
  body: AdfDoc;
  /** The text the comment is on. */
  quote: string;
  inlineMarkerRef: string | null;
  webUrl: string | null;
  createdAt: string | null;
  resolution: CommentResolution;
  replies: CommentReply[];
  /** When it was last read from Confluence (null: not yet, e.g. right after publishing). */
  checkedAt: string | null;
}

export interface Note {
  schemaVersion: number;
  id: string;
  page: PageRef;
  state: NoteState;
  body: AdfDoc;
  target: Target;
  anchorStatus: AnchorStatus;
  /** Current text when status is "changed". */
  currentExact: string | null;
  publishable: boolean;
  unpublishableReason: string | null;
  published: PublishInfo | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Tombstone for sync; deleted notes are kept until compaction. */
  deleted: boolean;
}

/** A per-page "draft comments" session (the GitHub-style review). */
export interface DraftSession {
  pageKey: string;
  startedAt: string;
  summary: string;
  updatedAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function emptyDoc(): AdfDoc {
  return { type: 'doc', version: 1, content: [] };
}

const RESOLUTION_LABEL: Record<CommentResolution, string> = {
  open: 'Open',
  reopened: 'Reopened',
  resolved: 'Resolved',
  dangling: 'Text removed from the page',
  deleted: 'Deleted in Confluence',
};

/** One line on what happened to a comment, e.g. "Resolved, 2 replies". */
export function commentLabel(c: CommentRecord): string {
  const n = c.replies.length;
  return `${RESOLUTION_LABEL[c.resolution]}, ${n ? `${n} repl${n === 1 ? 'y' : 'ies'}` : 'no replies'}`;
}

/**
 * Replies by other people to your comment that arrived after it was last
 * looked at. `seenAt` comes from the seen map (see NoteStore.seen); without
 * one nothing counts as new.
 */
export function unreadReplies(c: CommentRecord, seenAt: string | null): CommentReply[] {
  if (!c.mine || !seenAt) return [];
  return c.replies.filter((r) => !r.mine && (r.createdAt ?? '') > seenAt);
}

/** The newest reply time, or `fallback` when there are no replies. */
export function latestReplyAt(c: CommentRecord, fallback: string): string {
  return c.replies.reduce((m, r) => ((r.createdAt ?? '') > m ? (r.createdAt ?? '') : m), fallback);
}

/** Key of a comment in the seen map and in storage: "<site>:<comment id>". */
export function commentKey(site: string, commentId: string): string {
  return `${site}:${commentId}`;
}
