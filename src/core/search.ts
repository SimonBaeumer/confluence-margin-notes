// Searching notes and comments from the sidebar.
//
// A query is a list of words and "quoted phrases"; an entry matches when every
// one of them is found in its text, quote, page title or replies (case and
// accents ignored). Filters narrow it down further:
//   notes:     is:private  is:draft  is:attention
//   comments:  is:comment  is:published (your comments)  by:me  by:others
//              is:resolved  is:open  is:deleted  is:unread  has:replies
// A filter of one kind also picks that kind, so `is:resolved` searches the
// comments even where the notes are shown.

import { unreadReplies, type AdfDoc, type CommentRecord, type Note } from './model';
import { adfToPlain } from './rich-text';

export const SEARCH_HELP =
  'Words and "phrases" must all match. Notes: is:private, is:draft, is:attention. Comments: is:comment, is:published, by:me, by:others, is:resolved, is:open, is:deleted, is:unread, has:replies.';

/** Something the sidebar lists: one of your notes, or a comment read from Confluence. */
export type Entry = { kind: 'note'; note: Note } | { kind: 'comment'; comment: CommentRecord; seenAt: string | null };

export type EntryKind = Entry['kind'];

const ATTENTION = new Set(['orphaned', 'ambiguous', 'changed']);

export function needsAttention(n: Note): boolean {
  return ATTENTION.has(n.anchorStatus);
}

const noteFilter =
  (f: (n: Note) => boolean) =>
  (e: Entry): boolean =>
    e.kind === 'note' && f(e.note);
const commentFilter =
  (f: (c: CommentRecord, seenAt: string | null) => boolean) =>
  (e: Entry): boolean =>
    e.kind === 'comment' && f(e.comment, e.seenAt);

const FILTERS: Record<string, { kind: EntryKind; test: (e: Entry) => boolean }> = {
  'is:private': { kind: 'note', test: noteFilter((n) => n.state === 'private') },
  'is:draft': { kind: 'note', test: noteFilter((n) => n.state === 'draft') },
  'is:attention': { kind: 'note', test: noteFilter(needsAttention) },
  'is:comment': { kind: 'comment', test: commentFilter(() => true) },
  'is:published': { kind: 'comment', test: commentFilter((c) => c.mine) },
  'by:me': { kind: 'comment', test: commentFilter((c) => c.mine) },
  'by:others': { kind: 'comment', test: commentFilter((c) => !c.mine) },
  'is:resolved': { kind: 'comment', test: commentFilter((c) => c.resolution === 'resolved') },
  'is:open': { kind: 'comment', test: commentFilter((c) => !['resolved', 'deleted'].includes(c.resolution)) },
  'is:deleted': { kind: 'comment', test: commentFilter((c) => c.resolution === 'deleted') },
  'is:unread': { kind: 'comment', test: commentFilter((c, seen) => unreadReplies(c, seen).length > 0) },
  'has:replies': { kind: 'comment', test: commentFilter((c) => c.replies.length > 0) },
};

export interface Query {
  terms: string[];
  filters: ((e: Entry) => boolean)[];
  /** The kind the filters ask for, if any (the first filter decides). */
  kind: EntryKind | null;
  /** Filter words that are not known, shown as a hint. */
  unknown: string[];
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function parseQuery(q: string): Query {
  const out: Query = { terms: [], filters: [], kind: null, unknown: [] };
  for (const m of q.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const phrase = m[1];
    if (phrase !== undefined) {
      const t = fold(phrase.trim().replace(/\s+/g, ' '));
      if (t) out.terms.push(t);
      continue;
    }
    const word = m[2]!;
    const key = word.toLowerCase();
    if (/^(is|has|by):/.test(key)) {
      const f = FILTERS[key];
      if (f) {
        out.filters.push(f.test);
        out.kind ??= f.kind;
      } else out.unknown.push(word);
    } else out.terms.push(fold(word));
  }
  return out;
}

export function isEmptyQuery(q: Query): boolean {
  return !q.terms.length && !q.filters.length;
}

/** Every searchable piece of an entry, cached per stored version. */
const textCache = new WeakMap<Note | CommentRecord, string>();

function bodyOf(e: Entry): AdfDoc {
  return e.kind === 'note' ? e.note.body : e.comment.body;
}

export function searchText(e: Entry): string {
  const key = e.kind === 'note' ? e.note : e.comment;
  let t = textCache.get(key);
  if (t === undefined) {
    const parts =
      e.kind === 'note'
        ? [adfToPlain(e.note.body), e.note.target.exact, e.note.page.title]
        : [
            adfToPlain(e.comment.body),
            e.comment.quote,
            e.comment.page.title,
            e.comment.authorName ?? '',
            ...e.comment.replies.map((r) => `${r.authorName ?? ''} ${r.text}`),
          ];
    t = fold(parts.join('\n').replace(/\s+/g, ' '));
    textCache.set(key, t);
  }
  return t;
}

export function matches(e: Entry, q: Query): boolean {
  if (!q.filters.every((f) => f(e))) return false;
  if (!q.terms.length) return true;
  const text = searchText(e);
  return q.terms.every((t) => text.includes(t));
}

/**
 * A short excerpt of the note body around the first matching term, split into
 * plain and highlighted parts. Falls back to the start of the body.
 */
export function snippet(e: Entry, q: Query, width = 110): { text: string; hit: boolean }[] {
  const body = adfToPlain(bodyOf(e)).replace(/\s+/g, ' ').trim();
  const folded = fold(body);
  // fold() keeps the length of most text; when it does not, highlighting is skipped.
  const aligned = folded.length === body.length;
  let at = -1;
  let term = '';
  for (const t of q.terms) {
    const i = folded.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) [at, term] = [i, t];
  }
  if (at < 0 || !aligned) return [{ text: body.length > width ? body.slice(0, width - 1) + '…' : body, hit: false }];
  const from = Math.max(0, at - Math.floor((width - term.length) / 2));
  const to = Math.min(body.length, from + width);
  const parts: { text: string; hit: boolean }[] = [];
  if (from > 0) parts.push({ text: '…', hit: false });
  let pos = from;
  const window = folded.slice(from, to);
  const re = new RegExp(q.terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  for (const m of window.matchAll(re)) {
    const s = from + (m.index ?? 0);
    if (s > pos) parts.push({ text: body.slice(pos, s), hit: false });
    parts.push({ text: body.slice(s, s + m[0].length), hit: true });
    pos = s + m[0].length;
  }
  if (pos < to) parts.push({ text: body.slice(pos, to), hit: false });
  if (to < body.length) parts.push({ text: '…', hit: false });
  return parts;
}
