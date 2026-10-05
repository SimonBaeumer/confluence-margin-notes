// What happens to a note once it is published: it "graduates" into a
// Confluence comment. Pure functions, no I/O.
//
// The note becomes a tombstone (deleted, state "published", publish info
// without the thread) so that every machine drops its copy: a deletion wins
// over any edit in the sync merge, so an older draft copy on another machine
// can never come back and be published a second time. Older versions of the
// extension see an ordinary deletion. The comment itself lives on as a local
// CommentRecord, read from Confluence from then on.

import { commentKey, latestReplyAt, nowIso, type CommentRecord, type Note } from './model';

/** A published note that has been turned into a tombstone. */
export function isGraduated(n: Note): boolean {
  return n.deleted && n.state === 'published' && !!n.published;
}

/** A published note that still has to be turned into a tombstone (data from older versions). */
export function needsGraduation(n: Note): boolean {
  return !n.deleted && n.state === 'published' && !!n.published;
}

export interface Graduation {
  tombstone: Note;
  comment: CommentRecord;
  /** The seen-map entry, keyed by commentKey(). */
  seen: { key: string; at: string };
}

/** The first version of the comment record, until Confluence is read. */
export function commentFromNote(n: Note): CommentRecord {
  const pub = n.published!;
  const t = pub.thread;
  return {
    id: pub.commentId,
    page: n.page,
    authorId: null,
    authorName: null,
    mine: true,
    body: n.body,
    quote: n.target.exact,
    inlineMarkerRef: pub.inlineMarkerRef,
    webUrl: pub.webUrl,
    createdAt: pub.publishedAt,
    resolution: t?.resolution ?? 'open',
    replies: t?.replies ?? [],
    checkedAt: null,
  };
}

export function graduate(n: Note, now = nowIso()): Graduation {
  const pub = n.published!;
  const comment = commentFromNote(n);
  // Replies that existed when it was published (or that older versions saw) are not news.
  const seenAt = pub.thread?.seenAt ?? latestReplyAt(comment, pub.publishedAt);
  const { thread: _thread, ...info } = pub;
  return {
    // A fresh updatedAt keeps the tombstone for the full TTL, so every machine gets to see it.
    tombstone: { ...n, state: 'published', published: info, deleted: true, lastError: null, updatedAt: now },
    comment,
    seen: { key: commentKey(n.page.site, pub.commentId), at: seenAt },
  };
}
