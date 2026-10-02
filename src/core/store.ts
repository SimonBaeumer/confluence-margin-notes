// NoteStore on top of storage.local.
//
// One key per note ("note:<id>") and per draft session ("session:<pageKey>"),
// so concurrent writers (content script, sidebar) never overwrite each other's
// records. Every context reads and writes storage directly and listens to
// storage.onChanged; the background page is not a bottleneck.

import { SCHEMA_VERSION, nowIso, type DraftSession, type Note } from './model';

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ExportFile {
  format: 'margin-notes-export';
  schemaVersion: number;
  exportedAt: string;
  notes: Note[];
  sessions: DraftSession[];
}

const NOTE = 'note:';
const SESSION = 'session:';

export class NoteStore {
  constructor(private readonly area: StorageAreaLike) {}

  async allNotes(includeDeleted = false): Promise<Note[]> {
    const all = await this.area.get(null);
    const notes = Object.entries(all)
      .filter(([k]) => k.startsWith(NOTE))
      .map(([, v]) => v as Note);
    return includeDeleted ? notes : notes.filter((n) => !n.deleted);
  }

  async notesForPage(pageKey: string): Promise<Note[]> {
    return (await this.allNotes()).filter((n) => n.page.key === pageKey);
  }

  async get(id: string): Promise<Note | null> {
    const r = await this.area.get(NOTE + id);
    return (r[NOTE + id] as Note | undefined) ?? null;
  }

  async put(note: Note): Promise<Note> {
    const stored = { ...note, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso() };
    await this.area.set({ [NOTE + note.id]: stored });
    return stored;
  }

  async update(id: string, patch: Partial<Note>): Promise<Note | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    return this.put({ ...cur, ...patch });
  }

  /** Soft delete: the tombstone lets v2 sync propagate the deletion. */
  async delete(id: string): Promise<void> {
    await this.update(id, { deleted: true });
  }

  async session(pageKey: string): Promise<DraftSession | null> {
    const r = await this.area.get(SESSION + pageKey);
    return (r[SESSION + pageKey] as DraftSession | undefined) ?? null;
  }

  async allSessions(): Promise<DraftSession[]> {
    const all = await this.area.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(SESSION))
      .map(([, v]) => v as DraftSession);
  }

  async startSession(pageKey: string): Promise<DraftSession> {
    const existing = await this.session(pageKey);
    if (existing) return existing;
    const s: DraftSession = { pageKey, startedAt: nowIso(), summary: '', updatedAt: nowIso() };
    await this.area.set({ [SESSION + pageKey]: s });
    return s;
  }

  async setSummary(pageKey: string, summary: string): Promise<void> {
    const s = (await this.session(pageKey)) ?? (await this.startSession(pageKey));
    await this.area.set({ [SESSION + pageKey]: { ...s, summary, updatedAt: nowIso() } });
  }

  async endSession(pageKey: string): Promise<void> {
    await this.area.remove(SESSION + pageKey);
  }

  /** Discard draft comments: drafts go back to private, nothing is deleted. */
  async discardSession(pageKey: string): Promise<void> {
    for (const n of await this.notesForPage(pageKey)) {
      if (n.state === 'draft') await this.put({ ...n, state: 'private', lastError: null });
    }
    await this.endSession(pageKey);
  }

  /**
   * Writes notes received from sync as they are (keeping their updatedAt) and
   * removes notes purged elsewhere. `expected` holds each note as the merge
   * read it (see fingerprint; absent: did not exist); a note edited meanwhile
   * is left alone and goes out with the next sync. Returns the number of notes changed.
   */
  async applyRemote(writes: Note[], removes: string[], expected: Map<string, string>): Promise<number> {
    const ids = [...writes.map((n) => n.id), ...removes];
    if (!ids.length) return 0;
    const cur = await this.area.get(ids.map((id) => NOTE + id));
    const unchanged = (id: string) => fingerprint(cur[NOTE + id] as Note | undefined) === (expected.get(id) ?? fingerprint(undefined));
    const items: Record<string, unknown> = {};
    for (const n of writes) if (unchanged(n.id)) items[NOTE + n.id] = n;
    const gone = removes.filter((id) => unchanged(id) && cur[NOTE + id]).map((id) => NOTE + id);
    if (Object.keys(items).length) await this.area.set(items);
    if (gone.length) await this.area.remove(gone);
    return Object.keys(items).length + gone.length;
  }

  /** Removes deleted notes (tombstones) whose deletion is older than `cutoff`. Returns how many. */
  async purgeDeleted(cutoff: string): Promise<number> {
    const old = (await this.allNotes(true)).filter((n) => n.deleted && n.updatedAt < cutoff);
    if (old.length) await this.area.remove(old.map((n) => NOTE + n.id));
    return old.length;
  }

  async exportAll(): Promise<ExportFile> {
    return {
      format: 'margin-notes-export',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      notes: await this.allNotes(true),
      sessions: await this.allSessions(),
    };
  }

  /** Merges an export, last writer wins per note (by updatedAt). Returns the number of notes taken. */
  async importAll(file: ExportFile): Promise<number> {
    if (file.format !== 'margin-notes-export') throw new Error('Not a margin-notes export file.');
    let taken = 0;
    const items: Record<string, unknown> = {};
    for (const n of file.notes) {
      const cur = await this.get(n.id);
      if (!cur || cur.updatedAt < n.updatedAt) {
        items[NOTE + n.id] = n;
        taken++;
      }
    }
    for (const s of file.sessions) {
      const cur = await this.session(s.pageKey);
      if (!cur || cur.updatedAt < s.updatedAt) items[SESSION + s.pageKey] = s;
    }
    if (Object.keys(items).length) await this.area.set(items);
    return taken;
  }
}

/** Identifies one stored version of a note (updatedAt alone can repeat within a millisecond). */
export function fingerprint(note: Note | undefined): string {
  return note ? JSON.stringify(note) : '';
}

export function isNoteKey(key: string): boolean {
  return key.startsWith(NOTE);
}

export function isSessionKey(key: string): boolean {
  return key.startsWith(SESSION);
}

/** In-memory storage area for tests. */
export class MemoryArea implements StorageAreaLike {
  data = new Map<string, unknown>();
  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const list = keys == null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}
