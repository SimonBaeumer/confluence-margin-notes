// Merging the local notes with the copy on the sync page, and the rules for
// purging deleted notes. Pure functions, no I/O.
//
// Rules, per note id:
//   - purged on the sync page: removed locally (its deletion is final),
//   - only on one side: taken from that side,
//   - on both sides: a deletion wins over an edit (re-anchoring touches notes
//     automatically and must not bring a deleted note back), otherwise the
//     newer updatedAt wins (ties keep the sync page's copy).
// Tombstones older than TOMBSTONE_TTL_MS leave the sync page and become a
// purged id; purged ids are forgotten after PURGED_TTL_MS. A machine that has
// not synced for longer than that can bring deleted notes back.
//
// Published notes are tombstones too (see core/graduate.ts): their comments
// are read from Confluence on every machine and are not synced. Only the seen
// map is, merged per comment by the later time.

import { SCHEMA_VERSION, type Note } from '../core/model';

export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
export const PURGED_TTL_MS = 365 * 24 * 3600 * 1000;

export interface SyncDoc {
  format: 'margin-notes-sync';
  schemaVersion: number;
  updatedAt: string;
  notes: Note[];
  /** Ids of notes whose deletion is final, with the time they were deleted. */
  purged: Record<string, string>;
  /** Per comment ("<site>:<comment id>"), replies up to this time count as read. */
  seen: Record<string, string>;
}

export interface MergeResult {
  /** Notes to write locally, as they are. */
  localWrites: Note[];
  /** Note ids to remove locally. */
  localRemoves: string[];
  /** The new content of the sync page. */
  doc: SyncDoc;
  /** Seen-map entries that are newer on the sync page. */
  seenWrites: Record<string, string>;
  /** Whether the sync page needs a new version. */
  remoteChanged: boolean;
}

export function emptySyncDoc(now: string): SyncDoc {
  return { format: 'margin-notes-sync', schemaVersion: SCHEMA_VERSION, updatedAt: now, notes: [], purged: {}, seen: {} };
}

function pick(local: Note, remote: Note): Note {
  if (local.deleted !== remote.deleted) return local.deleted ? local : remote;
  return local.updatedAt > remote.updatedAt ? local : remote;
}

function same(a: Note | undefined, b: Note | undefined): boolean {
  if (!a || !b) return a === b;
  return a.updatedAt === b.updatedAt && a.deleted === b.deleted;
}

function mergeSeen(local: Record<string, string>, remote: Record<string, string>, cutoff: string) {
  const seen: Record<string, string> = {};
  const seenWrites: Record<string, string> = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[k] ?? '';
    const r = remote[k] ?? '';
    const at = l > r ? l : r;
    // Read state of comments nobody looked at for a year is not worth keeping.
    if (at < cutoff) continue;
    seen[k] = at;
    if (at > l) seenWrites[k] = at;
  }
  return { seen, seenWrites };
}

export function merge(local: Note[], remote: SyncDoc, now: Date, localSeen: Record<string, string> = {}): MergeResult {
  const nowIso = now.toISOString();
  const tombstoneCutoff = new Date(now.getTime() - TOMBSTONE_TTL_MS).toISOString();
  const purgedCutoff = new Date(now.getTime() - PURGED_TTL_MS).toISOString();

  const purged: Record<string, string> = {};
  for (const [id, at] of Object.entries(remote.purged ?? {})) if (at >= purgedCutoff) purged[id] = at;

  const localById = new Map(local.map((n) => [n.id, n]));
  const remoteById = new Map(remote.notes.map((n) => [n.id, n]));
  const localWrites: Note[] = [];
  const localRemoves: string[] = [];
  const merged: Note[] = [];

  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (purged[id] !== undefined) {
      if (l) localRemoves.push(id);
      continue;
    }
    const winner = l && r ? pick(l, r) : (l ?? r)!;
    if (winner.deleted && winner.updatedAt < tombstoneCutoff) {
      purged[id] = winner.updatedAt;
      if (l) localRemoves.push(id);
      continue;
    }
    merged.push(winner);
    if (!same(winner, l)) localWrites.push(winner);
  }

  merged.sort((a, b) => a.id.localeCompare(b.id));
  const remoteSeen = remote.seen ?? {};
  const { seen, seenWrites } = mergeSeen(localSeen, remoteSeen, purgedCutoff);
  const sameMap = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
  const remoteChanged =
    merged.length !== remote.notes.length ||
    merged.some((n) => !same(n, remoteById.get(n.id))) ||
    !sameMap(purged, remote.purged ?? {}) ||
    !sameMap(seen, remoteSeen);

  return {
    localWrites,
    localRemoves,
    seenWrites,
    doc: { format: 'margin-notes-sync', schemaVersion: SCHEMA_VERSION, updatedAt: remoteChanged ? nowIso : remote.updatedAt, notes: merged, purged, seen },
    remoteChanged,
  };
}

/**
 * The time before which local tombstones can be dropped. Without sync that is
 * TOMBSTONE_TTL_MS ago. With sync a tombstone must also have reached the sync
 * page first, so the cutoff is never later than the start of the last sync.
 */
export function localPurgeCutoff(now: Date, syncEnabled: boolean, lastSyncAt: string | null): string {
  const ttl = new Date(now.getTime() - TOMBSTONE_TTL_MS).toISOString();
  if (!syncEnabled) return ttl;
  if (!lastSyncAt) return '';
  return lastSyncAt < ttl ? lastSyncAt : ttl;
}
