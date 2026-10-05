// Sync through a restricted page in the user's Confluence personal space.
//
// Runs in the content script of a Confluence tab on the site the sync page
// lives on, so it uses the same session as publishing. One run: read the sync
// page -> merge with the local notes -> write a new page version if anything
// changed (retrying on a version conflict) -> apply the merge locally -> purge
// tombstones that are no longer needed. Published notes are synced as
// tombstones only; their comments come from Confluence (see core/graduate.ts).

import { fingerprint, type NoteStore, type StorageAreaLike } from '../core/store';
import { ConfluenceError, type ConfluenceClient } from '../confluence/client';
import { emptySyncDoc, localPurgeCutoff, merge } from './merge';
import { parseSyncPage, renderSyncPage, SYNC_PAGE_TITLE } from './page-format';

export const SYNC_CONFIG_KEY = 'sync:config';
export const SYNC_STATE_KEY = 'sync:state';

export interface SyncConfig {
  /** The Confluence site the sync page is on, e.g. "example.atlassian.net". */
  host: string;
  pageId: string;
  pageUrl: string | null;
  spaceKey: string;
  accountId: string;
  setupAt: string;
}

export interface SyncState {
  /** Start of the last successful run. */
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** A short description of what the last successful run did. */
  lastResult: string | null;
}

const MAX_CONFLICT_RETRIES = 3;
const RESTRICTION_CHECK_MS = 3600 * 1000;

export async function readSyncConfig(area: StorageAreaLike): Promise<SyncConfig | null> {
  return ((await area.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY] as SyncConfig | undefined) ?? null;
}

export async function readSyncState(area: StorageAreaLike): Promise<SyncState | null> {
  return ((await area.get(SYNC_STATE_KEY))[SYNC_STATE_KEY] as SyncState | undefined) ?? null;
}

/** Drops local tombstones that sync (if on) no longer needs. Returns how many. */
export async function purgeLocal(area: StorageAreaLike, store: NoteStore, now = new Date()): Promise<number> {
  const config = await readSyncConfig(area);
  const state = await readSyncState(area);
  return store.purgeDeleted(localPurgeCutoff(now, !!config, state?.lastSyncAt ?? null));
}

export class SyncService {
  private running: Promise<SyncState> | null = null;
  private restrictionCheckedAt = 0;

  constructor(
    private readonly client: ConfluenceClient,
    private readonly store: NoteStore,
    private readonly area: StorageAreaLike,
  ) {}

  /** Finds or creates the sync page in the user's personal space and runs a first sync. */
  async setup(host: string): Promise<SyncConfig> {
    const user = await this.client.currentUser();
    if (!user.personalSpace) throw new Error('You have no personal space on this site. Create one in Confluence first.');
    const space = user.personalSpace;
    const existing = await this.client.findPageByTitle(space.id, SYNC_PAGE_TITLE);
    const pageId = existing
      ? existing.id
      : (await this.client.createPrivatePage(space.id, SYNC_PAGE_TITLE, renderSyncPage(emptySyncDoc(new Date().toISOString())))).id;
    await this.ensureRestricted(pageId, user.accountId);
    const page = await this.client.getStoragePage(pageId);
    // Refuse a page with the right title but foreign content before anything is written to it.
    parseSyncPage(page.value, new Date().toISOString());
    const config: SyncConfig = {
      host,
      pageId,
      pageUrl: page.webUrl,
      spaceKey: space.key,
      accountId: user.accountId,
      setupAt: new Date().toISOString(),
    };
    await this.area.set({
      [SYNC_CONFIG_KEY]: config,
      [SYNC_STATE_KEY]: { lastSyncAt: null, lastAttemptAt: null, lastError: null, lastResult: null } satisfies SyncState,
    });
    this.restrictionCheckedAt = Date.now();
    await this.run();
    return config;
  }

  /** The sync page must be readable by its owner only, or no notes are written to it. */
  private async ensureRestricted(pageId: string, accountId: string): Promise<void> {
    const ok = (r: { userIds: string[]; groups: number }) => r.userIds.length > 0 && r.userIds.every((id) => id === accountId) && r.groups === 0;
    if (ok(await this.client.readRestriction(pageId))) return;
    await this.client.restrictToUser(pageId, accountId);
    if (!ok(await this.client.readRestriction(pageId))) {
      throw new Error('The sync page could not be restricted to you, so no notes were written to it.');
    }
  }

  /**
   * Runs one sync. Concurrent calls in this tab share the run in progress;
   * runs in other tabs or on other machines are caught by the page version
   * check. (No Web Locks: in a Firefox content script they belong to the page
   * and their promises cannot be awaited.)
   */
  run(): Promise<SyncState> {
    this.running ??= this.runOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async runOnce(): Promise<SyncState> {
    const config = await readSyncConfig(this.area);
    if (!config) throw new Error('Sync is not set up.');
    const prev = (await readSyncState(this.area)) ?? { lastSyncAt: null, lastAttemptAt: null, lastError: null, lastResult: null };
    const startedAt = new Date().toISOString();
    try {
      if (Date.now() - this.restrictionCheckedAt > RESTRICTION_CHECK_MS) {
        await this.ensureRestricted(config.pageId, config.accountId);
        this.restrictionCheckedAt = Date.now();
      }
      let result = '';
      for (let attempt = 0; ; attempt++) {
        const page = await this.client.getStoragePage(config.pageId);
        const remote = parseSyncPage(page.value, startedAt);
        // Published notes from older versions become tombstones before they are sent.
        await this.store.graduatePublished();
        const local = await this.store.allNotes(true);
        const expected = new Map(local.map((n) => [n.id, fingerprint(n)]));
        const m = merge(local, remote, new Date(), await this.store.seen());
        if (m.remoteChanged) {
          try {
            await this.client.updateStoragePage(config.pageId, page.title, page.version, renderSyncPage(m.doc), 'margin-notes sync');
          } catch (e) {
            // Another machine or tab wrote in between: merge again with its version.
            if (e instanceof ConfluenceError && e.status === 409 && attempt < MAX_CONFLICT_RETRIES) continue;
            throw e;
          }
        }
        const applied = await this.store.applyRemote(m.localWrites, m.localRemoves, expected);
        await this.store.ensureComments(m.localWrites);
        await this.store.applySeen(m.seenWrites);
        // Published notes received from machines still on an older version.
        await this.store.graduatePublished();
        result = [applied ? `${applied} note${applied === 1 ? '' : 's'} updated here` : '', m.remoteChanged ? 'changes sent' : '']
          .filter(Boolean)
          .join(', ') || 'Up to date';
        break;
      }
      const state: SyncState = { lastSyncAt: startedAt, lastAttemptAt: startedAt, lastError: null, lastResult: result };
      await this.area.set({ [SYNC_STATE_KEY]: state });
      await purgeLocal(this.area, this.store);
      return state;
    } catch (e) {
      const state: SyncState = { ...prev, lastAttemptAt: startedAt, lastError: (e as Error).message };
      await this.area.set({ [SYNC_STATE_KEY]: state });
      throw e;
    }
  }
}
