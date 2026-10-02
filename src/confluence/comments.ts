// What happens to a note after it is published: reading the comment's
// resolution and replies back from Confluence, editing the comment's body and
// unpublishing (deleting) it.

import type { AdfDoc, CommentReply, CommentResolution, CommentThread, Note } from '../core/model';
import { nowIso } from '../core/model';
import { ConfluenceError, type ConfluenceClient } from './client';

const RESOLUTIONS = new Set<CommentResolution>(['open', 'reopened', 'resolved', 'dangling']);

function isGone(e: unknown): boolean {
  return e instanceof ConfluenceError && (e.status === 404 || e.status === 410);
}

/** Display names are stable enough to cache for the lifetime of the tab. */
const names = new Map<string, string>();

async function resolveNames(client: ConfluenceClient, ids: string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !names.has(id));
  if (!missing.length) return;
  try {
    for (const [id, name] of await client.displayNames(missing)) names.set(id, name);
  } catch {
    // Names are a nicety: replies still show without them.
  }
}

/** True when two threads differ in anything worth saving (not the bookkeeping times). */
export function threadChanged(a: CommentThread | null | undefined, b: CommentThread): boolean {
  if (!a) return true;
  if (a.resolution !== b.resolution || a.replies.length !== b.replies.length) return true;
  return a.replies.some((r, i) => {
    const o = b.replies[i]!;
    return r.id !== o.id || r.text !== o.text || r.authorName !== o.authorName;
  });
}

/**
 * Reads the comment's current state from Confluence. Returns the note with an
 * updated thread, or null when nothing changed.
 */
export async function refreshThread(client: ConfluenceClient, note: Note): Promise<Note | null> {
  const pub = note.published;
  if (note.state !== 'published' || !pub) return null;
  const prev = pub.thread ?? null;
  let resolution: CommentResolution;
  let replies: CommentReply[] = [];
  try {
    const root = await client.getInlineComment(pub.commentId);
    const status = (root.resolutionStatus ?? 'open') as CommentResolution;
    resolution = RESOLUTIONS.has(status) ? status : 'open';
    const raw = await client.listReplies(pub.commentId);
    await resolveNames(client, raw.map((r) => r.authorId).filter((x): x is string => !!x));
    replies = raw.map((r) => ({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorId ? (names.get(r.authorId) ?? null) : null,
      createdAt: r.createdAt,
      text: r.bodyText,
      mine: !!r.authorId && r.authorId === root.authorId,
    }));
  } catch (e) {
    if (!isGone(e)) throw e;
    resolution = 'deleted';
    replies = prev?.replies ?? [];
  }
  const next: CommentThread = {
    resolution,
    replies,
    changedAt: nowIso(),
    // Replies that already existed when the note was published (or first checked) are not news.
    seenAt: prev ? prev.seenAt : pub.publishedAt,
  };
  if (!threadChanged(prev, next)) return null;
  return { ...note, published: { ...pub, thread: next } };
}

/** Marks every reply of a published note as read. Returns null when there is nothing to mark. */
export function markThreadSeen(note: Note): Note | null {
  const t = note.published?.thread;
  if (!t) return null;
  const latest = t.replies.reduce((m, r) => ((r.createdAt ?? '') > m ? (r.createdAt ?? '') : m), t.seenAt ?? '');
  if (!latest || latest === t.seenAt) return null;
  return { ...note, published: { ...note.published!, thread: { ...t, seenAt: latest } } };
}

/** Replaces the published comment's text in Confluence. Returns the updated note. */
export async function editPublished(client: ConfluenceClient, note: Note, body: AdfDoc): Promise<Note> {
  const pub = note.published;
  if (note.state !== 'published' || !pub) throw new Error('This note is not published.');
  let current;
  try {
    current = await client.getInlineComment(pub.commentId);
  } catch (e) {
    if (isGone(e)) throw new Error('The comment no longer exists in Confluence.');
    throw e;
  }
  if (current.version === null) throw new Error('Confluence did not return the comment version.');
  await client.updateInlineComment(pub.commentId, current.version, body);
  return { ...note, body, lastError: null };
}

/**
 * Deletes the comment in Confluence (with its replies) and turns the note back
 * into a private note. A comment that is already gone counts as success.
 */
export async function unpublish(client: ConfluenceClient, note: Note): Promise<Note> {
  const pub = note.published;
  if (note.state !== 'published' || !pub) throw new Error('This note is not published.');
  try {
    await client.deleteInlineComment(pub.commentId);
  } catch (e) {
    if (!isGone(e)) throw e;
  }
  return { ...note, state: 'private', published: null, lastError: null };
}
