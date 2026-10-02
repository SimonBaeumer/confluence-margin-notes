import { buildIndex } from '../src/core/adf-text';
import { describe as describeTarget } from '../src/core/anchoring';
import { SCHEMA_VERSION, type AdfNode, type Note } from '../src/core/model';
import { plainToAdf } from '../src/core/rich-text';
import { MemoryArea, NoteStore } from '../src/core/store';
import { ConfluenceClient } from '../src/confluence/client';
import { publishNote, submitDrafts, type PublishHooks } from '../src/confluence/publish';

const p = (localId: string, text: string): AdfNode => ({ type: 'paragraph', attrs: { localId }, content: [{ type: 'text', text }] });
const page = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });

function makeNote(adf: AdfNode, quote: string, occurrence: number, state: Note['state'] = 'draft', version = 1): Note {
  const idx = buildIndex(adf);
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = idx.text.indexOf(quote, start + 1);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `n-${quote}-${occurrence}`,
    page: { key: 'confluence:x:1', site: 'x', pageId: '1', url: 'https://x/wiki/1', title: 'T' },
    state,
    body: plainToAdf(`comment on ${quote}`),
    target: describeTarget(idx, start, start + quote.length, version),
    anchorStatus: 'anchored',
    currentExact: null,
    publishable: true,
    unpublishableReason: null,
    published: null,
    lastError: null,
    createdAt: '2026-10-02T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
    deleted: false,
  };
}

/** A fake Confluence that serves one page and records POSTs. */
function fakeServer(initial: AdfNode) {
  const state = { adf: initial, version: 1, posts: [] as any[], failNext: 0 as number, failStatus: 400 };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith('/wiki/api/v2/pages/1?')) {
      return new Response(JSON.stringify({ id: '1', title: 'T', version: { number: state.version }, body: { atlas_doc_format: { value: JSON.stringify(state.adf) } } }));
    }
    if (url === '/wiki/api/v2/inline-comments' && init?.method === 'POST') {
      if (state.failNext > 0) {
        state.failNext--;
        return new Response('{"errors":[{"status":400,"title":"bad selection"}]}', { status: state.failStatus });
      }
      const body = JSON.parse(String(init.body));
      state.posts.push(body);
      state.version++;
      return new Response(
        JSON.stringify({ id: String(100 + state.posts.length), properties: { inlineMarkerRef: 'ref', inlineOriginalSelection: body.inlineCommentProperties.textSelection }, _links: { webui: '/x', base: 'https://x/wiki' } }),
        { status: 201 },
      );
    }
    if (url === '/wiki/api/v2/footer-comments') {
      state.posts.push({ footer: JSON.parse(String(init!.body)) });
      return new Response(JSON.stringify({ id: '999' }), { status: 201 });
    }
    return new Response('not found', { status: 404 });
  };
  return { state, client: new ConfluenceClient(async () => null, fetch) };
}

function hooks(store: NoteStore, confirm = true): PublishHooks {
  return { confirmChanged: async () => confirm, progress: () => {}, save: async (n) => void (await store.put(n)) };
}

const adf = page(p('a', 'ShipmentRecord is used by the scheduler.'), p('b', 'Each ShipmentRecord is scored. ShipmentRecord again.'));

describe('NoteStore', () => {
  it('discarding draft comments keeps the notes as private', async () => {
    const store = new NoteStore(new MemoryArea());
    await store.startSession('confluence:x:1');
    await store.put(makeNote(adf, 'scheduler', 0));
    await store.discardSession('confluence:x:1');
    expect((await store.allNotes())[0]!.state).toBe('private');
    expect(await store.session('confluence:x:1')).toBeNull();
  });

  it('export and import merge by updatedAt and keep tombstones', async () => {
    const a = new NoteStore(new MemoryArea());
    const n = await a.put(makeNote(adf, 'scheduler', 0));
    await a.delete(n.id);
    const file = await a.exportAll();
    const b = new NoteStore(new MemoryArea());
    expect(await b.importAll(file)).toBe(1);
    expect(await b.allNotes()).toHaveLength(0);
    expect((await b.allNotes(true))[0]!.deleted).toBe(true);
    expect(await b.importAll(file)).toBe(0);
  });
});

describe('publish pipeline', () => {
  it('publishes the right occurrence of a repeated term', async () => {
    const { state, client } = fakeServer(adf);
    const store = new NoteStore(new MemoryArea());
    const note = await store.put(makeNote(adf, 'ShipmentRecord', 2));
    const r = await publishNote(client, note, hooks(store));
    expect(r.ok).toBe(true);
    expect(state.posts[0].inlineCommentProperties).toEqual({ textSelection: 'ShipmentRecord', textSelectionMatchCount: 3, textSelectionMatchIndex: 2 });
    expect(JSON.parse(state.posts[0].body.value)).toEqual(note.body);
    expect((await store.get(note.id))!.state).toBe('published');
  });

  it('recomputes the index after the page changed before publishing', async () => {
    const { state, client } = fakeServer(adf);
    const store = new NoteStore(new MemoryArea());
    const note = await store.put(makeNote(adf, 'ShipmentRecord', 1));
    // Someone adds a paragraph with another occurrence at the top.
    state.adf = page(p('z', 'New: ShipmentRecord intro.'), ...adf.content!);
    state.version = 2;
    await publishNote(client, note, hooks(store));
    expect(state.posts[0].inlineCommentProperties).toMatchObject({ textSelectionMatchCount: 4, textSelectionMatchIndex: 2 });
  });

  it('blocks orphaned notes and keeps them as drafts', async () => {
    const { state, client } = fakeServer(adf);
    const store = new NoteStore(new MemoryArea());
    const note = await store.put(makeNote(adf, 'used by the scheduler', 0));
    state.adf = page(p('q', 'Totally rewritten page without the old sentence whatsoever.'));
    state.version = 2;
    const r = await publishNote(client, note, hooks(store));
    expect(r.ok).toBe(false);
    expect(state.posts).toHaveLength(0);
    const after = (await store.get(note.id))!;
    expect(after.state).toBe('draft');
    expect(after.lastError).toMatch(/gone/);
  });

  it('asks before publishing on changed text and skips when declined', async () => {
    const { state, client } = fakeServer(adf);
    const store = new NoteStore(new MemoryArea());
    const note = await store.put(makeNote(adf, 'ShipmentRecord is used by the scheduler.', 0));
    state.adf = page(p('a', 'ShipmentRecord is used by the new scheduler.'), adf.content![1]!);
    state.version = 2;
    const r = await publishNote(client, note, hooks(store, false));
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(state.posts).toHaveLength(0);
  });

  it('retries once on 400 and then leaves the note as draft with the error', async () => {
    const { state, client } = fakeServer(adf);
    const store = new NoteStore(new MemoryArea());
    const note = await store.put(makeNote(adf, 'scheduler', 0));
    state.failNext = 2;
    const r = await publishNote(client, note, hooks(store));
    expect(r.ok).toBe(false);
    expect((await store.get(note.id))!.lastError).toMatch(/bad selection/);
  });

  it('submits drafts in document order, then the summary', async () => {
    const { state, client } = fakeServer(adf);
    const store = new NoteStore(new MemoryArea());
    const late = await store.put(makeNote(adf, 'again', 0));
    const early = await store.put(makeNote(adf, 'scheduler', 0));
    const res = await submitDrafts(client, '1', [late, early], plainToAdf('Looks good overall.'), hooks(store));
    expect(res.outcomes.every((o) => o.ok)).toBe(true);
    expect(state.posts.map((x) => x.inlineCommentProperties?.textSelection ?? 'footer')).toEqual(['scheduler', 'again', 'footer']);
  });
});
