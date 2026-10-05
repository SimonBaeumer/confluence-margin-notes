import { graduate } from '../src/core/graduate';
import { SCHEMA_VERSION, unreadReplies, type CommentRecord, type Note } from '../src/core/model';
import { plainToAdf } from '../src/core/rich-text';
import { matches, parseQuery, snippet, type Entry } from '../src/core/search';
import { ConfluenceClient } from '../src/confluence/client';
import { deleteComment, editComment, readComment, readPageComments } from '../src/confluence/comments';

function note(body: string, extra: Partial<Note> = {}): Note {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'n1',
    page: { key: 'confluence:x:1', site: 'x', pageId: '1', url: 'https://x/wiki/1', title: 'Solver RFC' },
    state: 'private',
    body: plainToAdf(body),
    target: {
      pageVersion: 1, startBlockLocalId: null, endBlockLocalId: null, startBlockOffset: 0, endBlockOffset: 5,
      start: 0, end: 5, exact: 'XFRROperatingPoint', prefix: '', suffix: '', originalExact: 'XFRROperatingPoint', originalVersion: 1,
    },
    anchorStatus: 'anchored',
    currentExact: null,
    publishable: true,
    unpublishableReason: null,
    published: null,
    lastError: null,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    deleted: false,
    ...extra,
  };
}

const published = (extra: Partial<Note> = {}) =>
  note('Why is this needed?', {
    state: 'published',
    published: { commentId: 'c1', inlineMarkerRef: 'm', webUrl: null, publishedAt: '2026-10-01T10:00:00Z' },
    ...extra,
  });

/** The comment record a published note starts out as. */
const mineRec = (extra: Partial<CommentRecord> = {}): CommentRecord => ({ ...graduate(published()).comment, ...extra });

const N = (n: Note): Entry => ({ kind: 'note', note: n });
const C = (c: CommentRecord, seenAt: string | null = null): Entry => ({ kind: 'comment', comment: c, seenAt });

describe('search', () => {
  it('matches all words and phrases across body, quote and title, ignoring case and accents', () => {
    const n = N(note('Ask Zoë about the café rollout'));
    expect(matches(n, parseQuery('zoe cafe'))).toBe(true);
    expect(matches(n, parseQuery('"about the cafe"'))).toBe(true);
    expect(matches(n, parseQuery('"the about"'))).toBe(false);
    expect(matches(n, parseQuery('xfrr solver'))).toBe(true);
    expect(matches(n, parseQuery('zoe missing'))).toBe(false);
  });

  it('does not match the structure of the stored body', () => {
    expect(matches(N(note('hello')), parseQuery('paragraph'))).toBe(false);
  });

  it('applies filters and reports unknown ones', () => {
    const q = parseQuery('is:draft is:bogus');
    expect(q.unknown).toEqual(['is:bogus']);
    expect(q.kind).toBe('note');
    expect(matches(N(note('x')), q)).toBe(false);
    expect(matches(N(note('x', { state: 'draft' })), q)).toBe(true);
  });

  it('keeps comment filters to comments and lets them pick the kind', () => {
    const others = mineRec({ id: 'c2', mine: false, authorName: 'Bob' });
    expect(parseQuery('is:open').kind).toBe('comment');
    expect(parseQuery('solver').kind).toBeNull();
    expect(matches(C(mineRec()), parseQuery('is:open'))).toBe(true);
    expect(matches(N(note('x')), parseQuery('is:open'))).toBe(false);
    expect(matches(C(mineRec()), parseQuery('is:draft'))).toBe(false);
    expect(matches(C(others), parseQuery('by:others bob'))).toBe(true);
    expect(matches(C(others), parseQuery('is:published'))).toBe(false);
    expect(matches(C(mineRec()), parseQuery('is:published why'))).toBe(true);
  });

  it('searches the replies of a comment and finds unread ones', () => {
    const c = mineRec({ replies: [{ id: 'r1', authorId: 'bob', authorName: 'Bob', createdAt: '2026-10-02T08:00:00Z', text: 'Because of X', mine: false }] });
    expect(matches(C(c), parseQuery('"because of x"'))).toBe(true);
    expect(matches(C(c, '2026-10-01T10:00:00Z'), parseQuery('is:unread'))).toBe(true);
    expect(matches(C(c, '2026-10-02T08:00:00Z'), parseQuery('is:unread'))).toBe(false);
    // Without a seen time nothing is new, and other people's comments never are.
    expect(unreadReplies(c, null)).toEqual([]);
    expect(unreadReplies({ ...c, mine: false }, '2026-10-01T10:00:00Z')).toEqual([]);
  });

  it('builds a snippet around the first hit', () => {
    const n = N(note('a '.repeat(100) + 'the important bit ' + 'b '.repeat(100)));
    const parts = snippet(n, parseQuery('important'));
    expect(parts.find((p) => p.hit)!.text).toBe('important');
    expect(parts[0]!.text).toBe('…');
  });
});

describe('graduation', () => {
  it('turns a published note into a tombstone, a comment record and a seen time', () => {
    const g = graduate(published(), '2026-10-03T00:00:00Z');
    expect(g.tombstone).toMatchObject({ id: 'n1', deleted: true, state: 'published', updatedAt: '2026-10-03T00:00:00Z' });
    expect(g.tombstone.published!.commentId).toBe('c1');
    expect(g.comment).toMatchObject({ id: 'c1', mine: true, quote: 'XFRROperatingPoint', resolution: 'open', checkedAt: null });
    expect(g.seen).toEqual({ key: 'x:c1', at: '2026-10-01T10:00:00Z' });
  });

  it('carries over what older versions knew about the thread', () => {
    const thread = { resolution: 'resolved' as const, replies: [], changedAt: '2026-10-02T00:00:00Z', seenAt: '2026-10-02T09:00:00Z' };
    const g = graduate(published({ published: { commentId: 'c1', inlineMarkerRef: 'm', webUrl: null, publishedAt: '2026-10-01T10:00:00Z', thread } }));
    expect(g.tombstone.published!.thread).toBeUndefined();
    expect(g.comment.resolution).toBe('resolved');
    expect(g.seen.at).toBe('2026-10-02T09:00:00Z');
  });
});

function fakeComments(opts: { gone?: boolean; onlyMine?: boolean } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.gone && url.startsWith('/wiki/api/v2/inline-comments/c1')) return json({}, 404);
    if (url.startsWith('/wiki/api/v2/pages/1/inline-comments')) {
      const adf = (t: string) => ({ atlas_doc_format: { value: JSON.stringify(plainToAdf(t)) } });
      return json({
        results: [
          { id: 'c1', resolutionStatus: 'resolved', version: { number: 3, authorId: 'me', createdAt: '2026-10-01T10:00:00Z' }, body: adf('Why is this needed?'), properties: { inlineMarkerRef: 'm', inlineOriginalSelection: 'XFRROperatingPoint' } },
          { id: 'c2', resolutionStatus: 'open', version: { number: 1, authorId: 'bob', createdAt: '2026-10-01T11:00:00Z' }, body: adf('Typo here'), properties: { inlineMarkerRef: 'm2', inlineOriginalSelection: 'solver' } },
        ],
      });
    }
    if (url.startsWith('/wiki/api/v2/inline-comments/c2/children')) return json({ results: [] });
    if (url.startsWith('/wiki/api/v2/inline-comments/c1/children')) {
      const results = [
          { id: 'r2', version: { authorId: 'me', createdAt: '2026-10-02T09:00:00Z' }, body: { atlas_doc_format: { value: JSON.stringify(plainToAdf('Thanks')) } } },
          { id: 'r1', version: { authorId: 'bob', createdAt: '2026-10-02T08:00:00Z' }, body: { atlas_doc_format: { value: JSON.stringify(plainToAdf('Because of X')) } } },
      ];
      return json({ results: opts.onlyMine ? results.slice(0, 1) : results });
    }
    if (url.startsWith('/wiki/api/v2/inline-comments/c1') && method === 'GET') {
      return json({ id: 'c1', resolutionStatus: 'resolved', version: { number: 3, authorId: 'me' } });
    }
    if (url.startsWith('/wiki/api/v2/inline-comments/')) return new Response(null, { status: method === 'DELETE' ? 204 : 200 });
    if (url === '/wiki/api/v2/users-bulk') return json({ results: [{ accountId: 'bob', displayName: 'Bob' }] });
    return json({}, 404);
  };
  return { calls, client: new ConfluenceClient(async () => null, fetch) };
}

describe('comments from Confluence', () => {
  it('reads a page: yours and others, new ones discovered, gone ones handled', async () => {
    const { client } = fakeComments();
    const goneMine = mineRec({ id: 'old', checkedAt: '2026-10-01T00:00:00Z' });
    const goneOthers = mineRec({ id: 'old2', mine: false, checkedAt: '2026-10-01T00:00:00Z' });
    const justPublished = mineRec({ id: 'new' });
    const r = await readPageComments(client, published().page, 'me', [mineRec(), goneMine, goneOthers, justPublished]);
    const byId = new Map(r.writes.map((c) => [c.id, c]));
    expect(byId.get('c1')).toMatchObject({ mine: true, resolution: 'resolved', quote: 'XFRROperatingPoint' });
    expect(byId.get('c1')!.replies.map((x) => [x.id, x.authorName, x.mine])).toEqual([
      ['r1', 'Bob', false],
      ['r2', null, true],
    ]);
    expect(byId.get('c2')).toMatchObject({ mine: false, authorName: 'Bob', quote: 'solver' });
    expect(byId.get('old')!.resolution).toBe('deleted');
    // Confluence may not list a comment published a moment ago.
    expect(byId.has('new')).toBe(false);
    expect(r.removes.map((c) => c.id)).toEqual(['old2']);
    expect(r.discovered.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('re-reads one comment and only reports changes', async () => {
    const { client } = fakeComments();
    const c = (await readComment(client, mineRec(), 'me'))!;
    expect(c.resolution).toBe('resolved');
    expect(unreadReplies(c, '2026-10-01T10:00:00Z').map((r) => r.id)).toEqual(['r1']);
    expect(await readComment(client, c, 'me')).toBeNull();
  });

  it('marks a comment deleted in Confluence', async () => {
    const { client } = fakeComments({ gone: true });
    expect((await readComment(client, mineRec(), 'me'))!.resolution).toBe('deleted');
  });

  it('edits the comment with the next version number', async () => {
    const { calls, client } = fakeComments();
    const body = plainToAdf('Rephrased');
    const c = await editComment(client, mineRec(), body);
    const put = calls.find((x) => x.method === 'PUT')!;
    expect(put.body.version.number).toBe(4);
    expect(JSON.parse(put.body.body.value)).toEqual(body);
    expect(c.body).toEqual(body);
    await expect(editComment(client, mineRec({ mine: false }), body)).rejects.toThrow(/your own/);
  });

  it('refuses to unpublish a comment with replies by other people', async () => {
    const { calls, client } = fakeComments();
    await expect(deleteComment(client, mineRec())).rejects.toThrow(/1 reply by other people/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('deletes your own replies before the comment, also when the comment is already gone', async () => {
    const { calls, client } = fakeComments({ onlyMine: true });
    await deleteComment(client, mineRec());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/wiki/api/v2/inline-comments/r2', '/wiki/api/v2/inline-comments/c1']);
    const gone = fakeComments({ gone: true });
    await expect(deleteComment(gone.client, mineRec())).resolves.toBeUndefined();
  });
});
