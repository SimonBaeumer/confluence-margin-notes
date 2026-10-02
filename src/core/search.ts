// Searching notes from the sidebar.
//
// A query is a list of words and "quoted phrases"; a note matches when every
// one of them is found in its text, quote, page title or replies (case and
// accents ignored). Filters narrow it down further:
//   is:private  is:draft  is:published  is:resolved  is:open  is:deleted
//   has:replies  is:unread  is:attention

import { unreadReplies, type Note } from './model';
import { adfToPlain } from './rich-text';

export const SEARCH_HELP = 'Words and "phrases" must all match. Filters: is:private, is:draft, is:published, is:resolved, is:open, is:unread, has:replies, is:attention.';

const ATTENTION = new Set(['orphaned', 'ambiguous', 'changed']);

const FILTERS: Record<string, (n: Note) => boolean> = {
  'is:private': (n) => n.state === 'private',
  'is:draft': (n) => n.state === 'draft',
  'is:published': (n) => n.state === 'published',
  'is:resolved': (n) => n.published?.thread?.resolution === 'resolved',
  'is:open': (n) => n.state === 'published' && !['resolved', 'deleted'].includes(n.published?.thread?.resolution ?? 'open'),
  'is:deleted': (n) => n.published?.thread?.resolution === 'deleted',
  'is:unread': (n) => unreadReplies(n).length > 0,
  'has:replies': (n) => (n.published?.thread?.replies.length ?? 0) > 0,
  'is:attention': (n) => n.state !== 'published' && ATTENTION.has(n.anchorStatus),
};

export interface Query {
  terms: string[];
  filters: ((n: Note) => boolean)[];
  /** Filter words that are not known, shown as a hint. */
  unknown: string[];
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function parseQuery(q: string): Query {
  const out: Query = { terms: [], filters: [], unknown: [] };
  for (const m of q.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const phrase = m[1];
    if (phrase !== undefined) {
      const t = fold(phrase.trim().replace(/\s+/g, ' '));
      if (t) out.terms.push(t);
      continue;
    }
    const word = m[2]!;
    const key = word.toLowerCase();
    if (/^(is|has):/.test(key)) {
      const f = FILTERS[key];
      if (f) out.filters.push(f);
      else out.unknown.push(word);
    } else out.terms.push(fold(word));
  }
  return out;
}

export function isEmptyQuery(q: Query): boolean {
  return !q.terms.length && !q.filters.length;
}

/** Every searchable piece of a note, cached per note version. */
const textCache = new WeakMap<Note, string>();

export function searchText(n: Note): string {
  let t = textCache.get(n);
  if (t === undefined) {
    const replies = n.published?.thread?.replies.map((r) => `${r.authorName ?? ''} ${r.text}`).join('\n') ?? '';
    t = fold([adfToPlain(n.body), n.target.exact, n.page.title, replies].join('\n').replace(/\s+/g, ' '));
    textCache.set(n, t);
  }
  return t;
}

export function matches(n: Note, q: Query): boolean {
  if (!q.filters.every((f) => f(n))) return false;
  if (!q.terms.length) return true;
  const text = searchText(n);
  return q.terms.every((t) => text.includes(t));
}

/**
 * A short excerpt of the note body around the first matching term, split into
 * plain and highlighted parts. Falls back to the start of the body.
 */
export function snippet(n: Note, q: Query, width = 110): { text: string; hit: boolean }[] {
  const body = adfToPlain(n.body).replace(/\s+/g, ' ').trim();
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
