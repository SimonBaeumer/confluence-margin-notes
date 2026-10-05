// Inline comments read from Confluence: listing a page's comments with their
// replies, re-reading one comment, editing its body and deleting it. These
// are the comment records the sidebar searches; published notes become one of
// them (see core/graduate.ts).

import type { AdfDoc, CommentRecord, CommentReply, CommentResolution, PageRef } from '../core/model';
import { emptyDoc, nowIso } from '../core/model';
import { plainToAdf } from '../core/rich-text';
import { ConfluenceError, type ConfluenceClient, type ExistingInlineComment } from './client';

const RESOLUTIONS = new Set<CommentResolution>(['open', 'reopened', 'resolved', 'dangling']);

/** Replies are fetched for at most this many comments per page read; the rest keep what was cached. */
export const MAX_REPLY_FETCHES = 60;

function isGone(e: unknown): boolean {
  return e instanceof ConfluenceError && (e.status === 404 || e.status === 410);
}

/** Display names are stable enough to cache for the lifetime of the tab. */
const names = new Map<string, string>();

async function resolveNames(client: ConfluenceClient, ids: (string | null)[]): Promise<void> {
  const missing = [...new Set(ids.filter((x): x is string => !!x))].filter((id) => !names.has(id));
  if (!missing.length) return;
  try {
    for (const [id, name] of await client.displayNames(missing)) names.set(id, name);
  } catch {
    // Names are a nicety: comments still show without them.
  }
}

function nameOf(id: string | null): string | null {
  return id ? (names.get(id) ?? null) : null;
}

function toReply(r: ExistingInlineComment, me: string): CommentReply {
  return { id: r.id, authorId: r.authorId, authorName: nameOf(r.authorId), createdAt: r.createdAt, text: r.bodyText, mine: !!r.authorId && r.authorId === me };
}

function resolutionOf(c: ExistingInlineComment): CommentResolution {
  const s = (c.resolutionStatus ?? 'open') as CommentResolution;
  return RESOLUTIONS.has(s) ? s : 'open';
}

function toRecord(c: ExistingInlineComment, replies: CommentReply[], page: PageRef, me: string, prev: CommentRecord | null, now: string): CommentRecord {
  return {
    id: c.id,
    page,
    authorId: c.authorId,
    authorName: nameOf(c.authorId),
    mine: !!c.authorId && c.authorId === me,
    body: c.body ?? (c.bodyText ? plainToAdf(c.bodyText) : (prev?.body ?? emptyDoc())),
    quote: c.inlineOriginalSelection ?? prev?.quote ?? '',
    inlineMarkerRef: c.inlineMarkerRef ?? prev?.inlineMarkerRef ?? null,
    webUrl: c.webUrl ?? prev?.webUrl ?? null,
    // The first version's time; later reads only see the latest version's.
    createdAt: prev?.createdAt ?? c.createdAt,
    resolution: resolutionOf(c),
    replies,
    checkedAt: now,
  };
}

export interface PageCommentsResult {
  /** Records to save (new or changed). */
  writes: CommentRecord[];
  /** Cached records that are gone from the page and not yours: forget them. */
  removes: CommentRecord[];
  /** Comments seen for the first time: their current replies count as read. */
  discovered: CommentRecord[];
}

/**
 * Reads every inline comment on a page and compares it with the cache. Your
 * own comments that disappeared are kept as "deleted", other people's are
 * forgotten.
 */
export async function readPageComments(
  client: ConfluenceClient,
  page: PageRef,
  me: string,
  cached: CommentRecord[],
): Promise<PageCommentsResult> {
  const now = nowIso();
  const list = (await client.listInlineComments(page.pageId!)).filter((c) => !c.parentCommentId);
  const prevById = new Map(cached.map((c) => [c.id, c]));
  const replies = new Map<string, ExistingInlineComment[]>();
  // Yours first, so their replies (and unread counts) are always current.
  const order = [...list].sort((a, b) => Number(b.authorId === me) - Number(a.authorId === me));
  for (const c of order.slice(0, MAX_REPLY_FETCHES)) {
    try {
      replies.set(c.id, await client.listReplies(c.id));
    } catch (e) {
      if (!isGone(e)) throw e;
    }
  }
  await resolveNames(client, [...list.map((c) => c.authorId), ...[...replies.values()].flat().map((r) => r.authorId)]);
  const out: PageCommentsResult = { writes: [], removes: [], discovered: [] };
  for (const c of list) {
    const prev = prevById.get(c.id) ?? null;
    const raw = replies.get(c.id);
    const rec = toRecord(c, raw ? raw.map((r) => toReply(r, me)) : (prev?.replies ?? []), page, me, prev, now);
    if (!prev || !prev.checkedAt) out.discovered.push(rec);
    if (commentChanged(prev, rec)) out.writes.push(rec);
  }
  const live = new Set(list.map((c) => c.id));
  for (const prev of cached) {
    if (live.has(prev.id)) continue;
    // Just published: Confluence may not list it yet.
    if (!prev.checkedAt) continue;
    if (!prev.mine) out.removes.push(prev);
    else if (prev.resolution !== 'deleted') out.writes.push({ ...prev, resolution: 'deleted', checkedAt: now });
  }
  return out;
}

/** Re-reads one comment (on any page of the site). Returns the new record, or null when nothing changed. */
export async function readComment(client: ConfluenceClient, rec: CommentRecord, me: string): Promise<CommentRecord | null> {
  let next: CommentRecord;
  try {
    const c = await client.getInlineComment(rec.id);
    const raw = await client.listReplies(rec.id);
    await resolveNames(client, [c.authorId, ...raw.map((r) => r.authorId)]);
    next = toRecord(c, raw.map((r) => toReply(r, me)), rec.page, me, rec, nowIso());
  } catch (e) {
    if (!isGone(e)) throw e;
    next = { ...rec, resolution: 'deleted', checkedAt: nowIso() };
  }
  return commentChanged(rec, next) ? next : null;
}

/** True when two records differ in anything worth saving (not checkedAt). */
export function commentChanged(a: CommentRecord | null | undefined, b: CommentRecord): boolean {
  if (!a) return true;
  if (!a.checkedAt) return true;
  if (a.resolution !== b.resolution || a.replies.length !== b.replies.length || a.mine !== b.mine) return true;
  if (a.authorName !== b.authorName || a.quote !== b.quote || a.inlineMarkerRef !== b.inlineMarkerRef) return true;
  if (JSON.stringify(a.body) !== JSON.stringify(b.body)) return true;
  return a.replies.some((r, i) => {
    const o = b.replies[i]!;
    return r.id !== o.id || r.text !== o.text || r.authorName !== o.authorName;
  });
}

/** Replaces the comment's text in Confluence. Returns the updated record. */
export async function editComment(client: ConfluenceClient, rec: CommentRecord, body: AdfDoc): Promise<CommentRecord> {
  if (!rec.mine) throw new Error('Only your own comments can be edited.');
  let current;
  try {
    current = await client.getInlineComment(rec.id);
  } catch (e) {
    if (isGone(e)) throw new Error('The comment no longer exists in Confluence.');
    throw e;
  }
  if (current.version === null) throw new Error('Confluence did not return the comment version.');
  await client.updateInlineComment(rec.id, current.version, body);
  return { ...rec, body };
}

/**
 * Deletes the comment in Confluence. A comment that is already gone counts as
 * success.
 *
 * Confluence does not delete replies with their comment: they stay behind as
 * separate top-level comments on the page. So your own replies are deleted
 * first, and a comment with replies by other people is not deleted at all.
 */
export async function deleteComment(client: ConfluenceClient, rec: CommentRecord): Promise<void> {
  if (!rec.mine) throw new Error('Only your own comments can be unpublished.');
  try {
    const root = await client.getInlineComment(rec.id);
    const replies = await client.listReplies(rec.id);
    const others = replies.filter((r) => r.authorId !== root.authorId);
    if (others.length) {
      throw new Error(
        `The comment has ${others.length} repl${others.length === 1 ? 'y' : 'ies'} by other people, which Confluence would keep as separate comments. Resolve it in Confluence instead.`,
      );
    }
    for (const r of replies) await client.deleteInlineComment(r.id);
    await client.deleteInlineComment(rec.id);
  } catch (e) {
    if (!isGone(e)) throw e;
  }
}

/** The confirmation shown before unpublishing. */
export function unpublishQuestion(rec: CommentRecord): string {
  const mine = rec.replies.filter((r) => r.mine).length;
  const extra = mine ? ` and your ${mine} repl${mine === 1 ? 'y' : 'ies'} to it` : '';
  return `Delete this comment${extra} in Confluence? It stays as a private note.`;
}
