import { SCHEMA_VERSION, type Note } from '../src/core/model';
import { plainToAdf } from '../src/core/rich-text';
import { fingerprint, MemoryArea, NoteStore } from '../src/core/store';
import { ConfluenceClient } from '../src/confluence/client';
import { emptySyncDoc, localPurgeCutoff, merge, TOMBSTONE_TTL_MS, type SyncDoc } from '../src/sync/merge';
import { parseSyncPage, renderSyncPage } from '../src/sync/page-format';
import { purgeLocal, readSyncState, SYNC_CONFIG_KEY, SYNC_STATE_KEY, SyncService } from '../src/sync/service';

const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function note(id: string, updatedAt: string, extra: Partial<Note> = {}): Note {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    page: { key: 'confluence:x:1', site: 'x', pageId: '1', url: 'https://x/wiki/1', title: 'T' },
    state: 'private',
    body: plainToAdf(`note ${id}`),
    target: {
      pageVersion: 1, startBlockLocalId: null, endBlockLocalId: null, startBlockOffset: 0, endBlockOffset: 1,
      start: 0, end: 1, exact: 'a', prefix: '', suffix: '', originalExact: 'a', originalVersion: 1,
    },
    anchorStatus: 'anchored',
    currentExact: null,
    publishable: true,
    unpublishableReason: null,
    published: null,
    lastError: null,
    createdAt: updatedAt,
    updatedAt,
    deleted: false,
    ...extra,
  };
}

function doc(notes: Note[], purged: Record<string, string> = {}): SyncDoc {
  return { ...emptySyncDoc(ago(DAY)), notes, purged };
}

describe('merge', () => {
  it('takes notes that exist on one side only', () => {
    const m = merge([note('a', ago(DAY))], doc([note('b', ago(DAY))]), NOW);
    expect(m.localWrites.map((n) => n.id)).toEqual(['b']);
    expect(m.doc.notes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(m.remoteChanged).toBe(true);
  });

  it('keeps the newer copy and reports no change when both sides agree', () => {
    const newer = note('a', ago(1000), { body: plainToAdf('new') });
    const m = merge([newer], doc([note('a', ago(DAY))]), NOW);
    expect(m.doc.notes[0]!.body).toEqual(newer.body);
    expect(m.localWrites).toEqual([]);
    const again = merge([newer], m.doc, NOW);
    expect(again.remoteChanged).toBe(false);
    expect(again.localWrites).toEqual([]);
  });

  it('lets a deletion win over a later edit', () => {
    const m = merge([note('a', ago(1000))], doc([note('a', ago(DAY), { deleted: true })]), NOW);
    expect(m.localWrites[0]!.deleted).toBe(true);
  });

  it('turns old tombstones into purged ids and removes purged notes locally', () => {
    const old = note('a', ago(TOMBSTONE_TTL_MS + DAY), { deleted: true });
    const m = merge([old], doc([]), NOW);
    expect(m.doc.notes).toEqual([]);
    expect(m.doc.purged).toEqual({ a: old.updatedAt });
    expect(m.localRemoves).toEqual(['a']);
    // A machine that still has the note live gets it removed.
    const other = merge([note('a', ago(1000))], m.doc, NOW);
    expect(other.localRemoves).toEqual(['a']);
    expect(other.doc.notes).toEqual([]);
  });

  it('forgets purged ids after a year', () => {
    const m = merge([], doc([], { a: ago(400 * DAY) }), NOW);
    expect(m.doc.purged).toEqual({});
    expect(m.remoteChanged).toBe(true);
  });

  it('never marks replies unread again', () => {
    const thread = (seenAt: string) => ({
      commentId: 'c', inlineMarkerRef: null, webUrl: null, publishedAt: ago(DAY),
      thread: { resolution: 'open' as const, replies: [], changedAt: ago(DAY), seenAt },
    });
    const local = note('a', ago(2000), { state: 'published', published: thread(ago(500)) });
    const remote = note('a', ago(1000), { state: 'published', published: thread(ago(DAY)) });
    const m = merge([local], doc([remote]), NOW);
    expect(m.doc.notes[0]!.published!.thread!.seenAt).toBe(ago(500));
  });
});

describe('localPurgeCutoff', () => {
  it('waits for a tombstone to be synced before dropping it', () => {
    expect(localPurgeCutoff(NOW, false, null)).toBe(ago(TOMBSTONE_TTL_MS));
    expect(localPurgeCutoff(NOW, true, null)).toBe('');
    expect(localPurgeCutoff(NOW, true, ago(40 * DAY))).toBe(ago(40 * DAY));
    expect(localPurgeCutoff(NOW, true, ago(1000))).toBe(ago(TOMBSTONE_TTL_MS));
  });
});

describe('sync page format', () => {
  it('round-trips notes whose text contains markup and CDATA ends', () => {
    const tricky = note('a', ago(DAY), { body: plainToAdf('a ]]> b <ac:x> & c') });
    const d = doc([tricky]);
    const html = renderSyncPage(d);
    expect(html.match(/\]\]>/g)).toHaveLength(1);
    expect(parseSyncPage(html, NOW.toISOString())).toEqual(d);
  });

  it('treats a page without data as empty and refuses foreign data', () => {
    expect(parseSyncPage('<p>new page</p>', NOW.toISOString()).notes).toEqual([]);
    expect(() => parseSyncPage('<ac:plain-text-body><![CDATA[{"x":1}]]></ac:plain-text-body>', '')).toThrow(/not hold/);
    expect(() => parseSyncPage('<ac:plain-text-body><![CDATA[{nope]]></ac:plain-text-body>', '')).toThrow(/not valid JSON/);
  });
});

/** A fake Confluence with one personal space and page versioning. */
function fakeConfluence() {
  const s = {
    pages: new Map<string, { title: string; version: number; value: string }>(),
    restricted: new Set<string>(),
    conflictNext: 0,
    writes: 0,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith('/wiki/rest/api/user/current')) {
      return json({ accountId: 'me', displayName: 'Me', personalSpace: { id: 77, key: '~me' } });
    }
    if (url.startsWith('/wiki/api/v2/pages?space-id=')) {
      const title = new URL('https://x' + url).searchParams.get('title');
      return json({ results: [...s.pages].filter(([, p]) => p.title === title).map(([id, p]) => ({ id, title: p.title })) });
    }
    if (url.startsWith('/wiki/api/v2/pages?private=true') && method === 'POST') {
      const id = String(100 + s.pages.size);
      s.pages.set(id, { title: body.title, version: 1, value: body.body.value });
      s.restricted.add(id);
      return json({ id });
    }
    const restr = url.match(/^\/wiki\/rest\/api\/content\/(\d+)\/restriction/);
    if (restr) {
      if (method === 'PUT') {
        s.restricted.add(restr[1]!);
        return json({});
      }
      const users = s.restricted.has(restr[1]!) ? [{ accountId: 'me' }] : [];
      return json({ restrictions: { user: { results: users }, group: { results: [] } } });
    }
    const page = url.match(/^\/wiki\/api\/v2\/pages\/(\d+)/);
    if (page) {
      const p = s.pages.get(page[1]!);
      if (!p) return json({}, 404);
      if (method === 'PUT') {
        if (s.conflictNext > 0) {
          s.conflictNext--;
          p.version++;
          return json({ errors: [{ title: 'Version conflict' }] }, 409);
        }
        if (body.version.number !== p.version + 1) return json({ errors: [{ title: 'Version conflict' }] }, 409);
        p.version++;
        p.value = body.body.value;
        s.writes++;
        return json({});
      }
      return json({ id: page[1], title: p.title, version: { number: p.version }, body: { storage: { value: p.value } }, _links: { webui: '/spaces/~me/pages/' + page[1] } });
    }
    return json({}, 404);
  };
  return { s, client: new ConfluenceClient(async () => null, fetch) };
}

describe('SyncService', () => {
  it('syncs notes and deletions between two machines through one page', async () => {
    const { s, client } = fakeConfluence();
    const areaA = new MemoryArea();
    const areaB = new MemoryArea();
    const a = new NoteStore(areaA);
    const b = new NoteStore(areaB);
    const syncA = new SyncService(client, a, areaA);
    const syncB = new SyncService(client, b, areaB);

    const n = await a.put(note('n1', ago(DAY)));
    await syncA.setup('x');
    expect(s.pages.size).toBe(1);

    await b.put(note('n2', ago(DAY)));
    await syncB.setup('x');
    // B found A's page instead of creating a second one.
    expect(s.pages.size).toBe(1);
    expect((await b.allNotes()).map((x) => x.id).sort()).toEqual(['n1', 'n2']);

    await syncA.run();
    expect((await a.allNotes()).map((x) => x.id).sort()).toEqual(['n1', 'n2']);

    await a.delete(n.id);
    await syncA.run();
    await syncB.run();
    expect((await b.allNotes()).map((x) => x.id)).toEqual(['n2']);
    expect((await readSyncState(areaB))!.lastError).toBeNull();

    // Nothing changed: no new page version.
    const writes = s.writes;
    await syncA.run();
    expect(s.writes).toBe(writes);
  });

  it('merges again after a version conflict', async () => {
    const { s, client } = fakeConfluence();
    const area = new MemoryArea();
    const store = new NoteStore(area);
    const sync = new SyncService(client, store, area);
    await sync.setup('x');
    await store.put(note('n1', ago(DAY)));
    s.conflictNext = 1;
    await sync.run();
    const page = [...s.pages.values()][0]!;
    expect(parseSyncPage(page.value, '').notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('records the error and does not write when the page holds foreign data', async () => {
    const { s, client } = fakeConfluence();
    const area = new MemoryArea();
    const store = new NoteStore(area);
    const sync = new SyncService(client, store, area);
    await sync.setup('x');
    const page = [...s.pages.values()][0]!;
    page.value = '<ac:plain-text-body><![CDATA[{"hello":1}]]></ac:plain-text-body>';
    await store.put(note('n1', ago(DAY)));
    await expect(sync.run()).rejects.toThrow(/not hold/);
    expect((await readSyncState(area))!.lastError).toMatch(/not hold/);
    expect(page.value).toContain('hello');
  });
});

describe('purgeLocal', () => {
  it('drops old tombstones without sync and only synced ones with sync', async () => {
    const area = new MemoryArea();
    const store = new NoteStore(area);
    await area.set({
      'note:old': note('old', ago(40 * DAY), { deleted: true }),
      'note:new': note('new', ago(DAY), { deleted: true }),
      'note:live': note('live', ago(90 * DAY)),
    });
    await area.set({ [SYNC_CONFIG_KEY]: { host: 'x' }, [SYNC_STATE_KEY]: { lastSyncAt: ago(50 * DAY) } });
    expect(await purgeLocal(area, store, NOW)).toBe(0);
    await area.remove([SYNC_CONFIG_KEY, SYNC_STATE_KEY]);
    expect(await purgeLocal(area, store, NOW)).toBe(1);
    expect((await store.allNotes(true)).map((n) => n.id).sort()).toEqual(['live', 'new']);
  });
});

describe('NoteStore.applyRemote', () => {
  it('skips notes edited locally after the merge read them', async () => {
    const area = new MemoryArea();
    const store = new NoteStore(area);
    const read = await store.put(note('a', ago(DAY)));
    await store.update('a', { body: plainToAdf('edited meanwhile') });
    const n = await store.applyRemote([note('a', ago(10))], [], new Map([['a', fingerprint(read)]]));
    expect(n).toBe(0);
    expect((await store.get('a'))!.body).toEqual(plainToAdf('edited meanwhile'));
  });
});
