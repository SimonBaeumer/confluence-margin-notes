import { SCHEMA_VERSION, unreadReplies, type Note } from '../src/core/model';
import { plainToAdf } from '../src/core/rich-text';
import { matches, parseQuery, snippet } from '../src/core/search';
import { ConfluenceClient } from '../src/confluence/client';
import { editPublished, markThreadSeen, refreshThread, unpublish } from '../src/confluence/comments';

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

describe('search', () => {
  it('matches all words and phrases across body, quote and title, ignoring case and accents', () => {
    const n = note('Ask Zoë about the café rollout');
    expect(matches(n, parseQuery('zoe cafe'))).toBe(true);
    expect(matches(n, parseQuery('"about the cafe"'))).toBe(true);
    expect(matches(n, parseQuery('"the about"'))).toBe(false);
    expect(matches(n, parseQuery('xfrr solver'))).toBe(true);
    expect(matches(n, parseQuery('zoe missing'))).toBe(false);
  });

  it('does not match the structure of the stored body', () => {
    expect(matches(note('hello'), parseQuery('paragraph'))).toBe(false);
  });

  it('applies filters and reports unknown ones', () => {
    const q = parseQuery('is:draft is:bogus');
    expect(q.unknown).toEqual(['is:bogus']);
    expect(matches(note('x'), q)).toBe(false);
    expect(matches(note('x', { state: 'draft' }), q)).toBe(true);
    expect(matches(published(), parseQuery('is:open'))).toBe(true);
  });

  it('builds a snippet around the first hit', () => {
    const n = note('a '.repeat(100) + 'the important bit ' + 'b '.repeat(100));
    const parts = snippet(n, parseQuery('important'));
    expect(parts.find((p) => p.hit)!.text).toBe('important');
    expect(parts[0]!.text).toBe('…');
  });
});

function fakeComments(opts: { gone?: boolean; onlyMine?: boolean } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.gone && url.startsWith('/wiki/api/v2/inline-comments/c1')) return json({}, 404);
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

describe('published comments', () => {
  it('reads resolution and replies, and only reports changes', async () => {
    const { client } = fakeComments();
    const n = (await refreshThread(client, published()))!;
    const t = n.published!.thread!;
    expect(t.resolution).toBe('resolved');
    expect(t.replies.map((r) => [r.id, r.authorName, r.mine])).toEqual([
      ['r1', 'Bob', false],
      ['r2', null, true],
    ]);
    expect(unreadReplies(n).map((r) => r.id)).toEqual(['r1']);
    expect(await refreshThread(client, n)).toBeNull();
    const seen = markThreadSeen(n)!;
    expect(unreadReplies(seen)).toEqual([]);
    expect(markThreadSeen(seen)).toBeNull();
  });

  it('marks a comment deleted in Confluence', async () => {
    const { client } = fakeComments({ gone: true });
    expect((await refreshThread(client, published()))!.published!.thread!.resolution).toBe('deleted');
  });

  it('edits the comment with the next version number', async () => {
    const { calls, client } = fakeComments();
    const body = plainToAdf('Rephrased');
    const n = await editPublished(client, published(), body);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.version.number).toBe(4);
    expect(JSON.parse(put.body.body.value)).toEqual(body);
    expect(n.body).toEqual(body);
  });

  it('refuses to unpublish a comment with replies by other people', async () => {
    const { calls, client } = fakeComments();
    await expect(unpublish(client, published())).rejects.toThrow(/1 reply by other people/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('deletes your own replies before the comment, also when the comment is already gone', async () => {
    const { calls, client } = fakeComments({ onlyMine: true });
    const n = await unpublish(client, published());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/wiki/api/v2/inline-comments/r2', '/wiki/api/v2/inline-comments/c1']);
    expect(n).toMatchObject({ state: 'private', published: null });
    const gone = fakeComments({ gone: true });
    expect((await unpublish(gone.client, published())).state).toBe('private');
  });
});
