// Content script controller for Confluence pages.

import { browser } from 'wxt/browser';
import { buildIndex, computeMatch, type PageTextIndex } from '../core/adf-text';
import { anchor, describe, rebase, type AnchorResult } from '../core/anchoring';
import { pageKeyFor, SETTINGS_KEY, type ActionResult, type PageInfo, type Settings, type ToContent } from '../core/messages';
import { SCHEMA_VERSION, nowIso, type AdfDoc, type Note, type PageRef } from '../core/model';
import { plainToAdf } from '../core/rich-text';
import { isNoteKey, isSessionKey, NoteStore } from '../core/store';
import { ConfluenceClient } from '../confluence/client';
import { DomMapper, findCommentMark, findRoot, readPageMeta, type PageMeta } from '../confluence/dom';
import { editPublished, markThreadSeen, refreshThread, unpublish } from '../confluence/comments';
import { gateFor, indexForVersion, publishNote, submitDrafts, type PublishHooks } from '../confluence/publish';
import { readSyncConfig, SYNC_CONFIG_KEY, SyncService } from '../sync/service';
import { Highlighter, type Painted } from './highlights';
import { Overlay, type DialogItem, type SubmitDialog } from './overlay';

const POLL_MS = 700;
const MUTATION_DEBOUNCE_MS = 350;
const JUMP_ATTEMPTS = 12;
const JUMP_RETRY_MS = 250;
const SYNC_FIRST_MS = 3000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 10 * 1000;
/** A published note's thread is read again at most this often per tab. */
const THREAD_TTL_MS = 2 * 60 * 1000;
const THREAD_SWEEP_MS = 10 * 60 * 1000;
const THREAD_SWEEP_MAX = 25;

function uuid(): string {
  return crypto.randomUUID();
}

/** Resolves once `read` returns the same value for a few frames (or after 1.5 s). */
async function settled(read: () => number | undefined): Promise<void> {
  const deadline = Date.now() + 1500;
  let last = read();
  let still = 0;
  while (still < 4 && Date.now() < deadline) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = read();
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

function statusText(note: Note, r: AnchorResult | undefined): string | null {
  if (!r) return null;
  if (r.status === 'orphaned') return 'The text this note was on is gone. Re-attach it from the sidebar.';
  if (r.status === 'ambiguous') return 'The text now appears in several identical places. Re-attach it from the sidebar.';
  if (r.status === 'changed' || note.target.exact !== note.target.originalExact) {
    return `The text changed. Was: “${note.target.originalExact.slice(0, 100)}”`;
  }
  if (r.status === 'moved') return null;
  return null;
}

export class App {
  private readonly store = new NoteStore(browser.storage.local);
  private readonly client = new ConfluenceClient(async () => {
    const r = await browser.storage.local.get(SETTINGS_KEY);
    const s = r[SETTINGS_KEY] as Settings | undefined;
    return s?.apiEmail && s?.apiToken ? { email: s.apiEmail, token: s.apiToken } : null;
  });
  private readonly overlay = new Overlay(document);
  private readonly highlighter = new Highlighter(document);

  private meta: PageMeta | null = null;
  private pageRef: PageRef | null = null;
  private index: PageTextIndex | null = null;
  private indexVersion: number | null = null;
  private mapper: DomMapper | null = null;
  private notes: Note[] = [];
  private results = new Map<string, AnchorResult>();
  private loading: Promise<void> | null = null;
  private lastKey = '';
  private observer: MutationObserver | null = null;
  private observedRoot: HTMLElement | null = null;
  private mutationTimer: number | undefined;
  private unavailable: string | null = null;
  private publishing = false;
  private readonly sync = new SyncService(this.client, this.store, browser.storage.local);
  private syncEnabled = false;
  private syncTimer: number | undefined;
  private threadCheckedAt = new Map<string, number>();

  start(): void {
    setInterval(() => this.tick(), POLL_MS);
    this.tick();
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      if (keys.some((k) => isNoteKey(k) || isSessionKey(k))) void this.refreshNotes();
      if (keys.some(isNoteKey)) this.scheduleSync(SYNC_DEBOUNCE_MS);
      if (keys.includes(SYNC_CONFIG_KEY)) void this.initSync();
    });
    void this.initSync();
    setInterval(() => this.scheduleSync(0), SYNC_INTERVAL_MS);
    setInterval(() => void this.sweepThreads(), THREAD_SWEEP_MS);
    browser.runtime.onMessage.addListener((msg: ToContent) => this.onMessage(msg));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e), true);
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey) this.onSelectionMaybe();
    });
    document.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) this.overlay.hideAddButton();
    });
    window.addEventListener('scroll', () => this.overlay.hideAddButton(), { passive: true });
  }

  // ---- page lifecycle -------------------------------------------------------

  private tick(): void {
    const meta = readPageMeta();
    const root = findRoot();
    const key = meta && root ? `${meta.pageId}@${meta.version}` : '';
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.reset();
      if (!meta) {
        this.unavailable = /edit-v2|resumedraft/.test(location.pathname)
          ? 'Notes are available in view mode only.'
          : 'Not a Confluence page.';
        return;
      }
      if (!root) {
        this.unavailable = 'Waiting for the page content…';
        return;
      }
      this.meta = meta;
      this.loading = this.load(meta);
    }
    if (root && root !== this.observedRoot) {
      // Confluence sometimes swaps the whole renderer root: re-map and repaint.
      this.observe(root);
      this.rebuildMapper();
      this.paint();
    }
  }

  private reset(): void {
    this.meta = null;
    this.pageRef = null;
    this.index = null;
    this.mapper = null;
    this.notes = [];
    this.results.clear();
    this.highlighter.clear();
    this.overlay.closePopover();
    this.overlay.hideAddButton();
    this.overlay.showBanner(0, () => {}, () => {});
    this.unavailable = null;
    void browser.runtime.sendMessage({ type: 'badge', count: 0 }).catch(() => {});
  }

  private async load(meta: PageMeta): Promise<void> {
    this.pageRef = {
      key: pageKeyFor(meta.host, meta.pageId),
      site: meta.host,
      pageId: meta.pageId,
      url: location.origin + location.pathname,
      title: meta.title,
    };
    try {
      // The DOM shows the version in the meta tag; index exactly that version so DOM and ADF agree.
      const snap = Number.isFinite(meta.version)
        ? await this.client.getPage(meta.pageId, meta.version)
        : await this.client.getPage(meta.pageId);
      if (this.meta !== meta) return;
      this.index = buildIndex(snap.adf);
      this.indexVersion = snap.version;
      this.pageRef.title = snap.title || meta.title;
      this.rebuildMapper();
      await this.refreshNotes();
      void this.refreshThreads(this.notes.filter((n) => n.state === 'published'));
    } catch (e) {
      // A load the page has moved on from must not report into the next one.
      if (this.meta !== meta) return;
      this.unavailable = `Could not load the page text: ${(e as Error).message}`;
      console.warn('[margin-notes]', e);
    }
  }

  private observe(root: HTMLElement): void {
    this.observer?.disconnect();
    this.observedRoot = root;
    this.observer = new MutationObserver(() => {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = window.setTimeout(() => {
        this.rebuildMapper();
        this.paint();
      }, MUTATION_DEBOUNCE_MS);
    });
    this.observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  private rebuildMapper(): void {
    const root = findRoot();
    if (!root || !this.index) return;
    this.mapper = new DomMapper(root, this.index);
    if (this.mapper.coverage < 0.8) console.warn('[margin-notes] only', Math.round(this.mapper.coverage * 100), '% of blocks mapped');
  }

  // ---- notes ----------------------------------------------------------------

  private async refreshNotes(): Promise<void> {
    if (!this.pageRef || !this.index || this.indexVersion === null) return;
    const pageKey = this.pageRef.key;
    const index = this.index;
    const version = this.indexVersion;
    // A reset or reload replaces the index while we await: stop then, the new load refreshes again.
    const stale = () => this.index !== index;
    const notes = await this.store.notesForPage(pageKey);
    if (stale()) return;
    this.notes = notes;
    for (const n of notes) {
      if (n.state === 'published') {
        // Only located, never saved: we paint it until Confluence shows its own highlight.
        this.results.set(n.id, anchor(n.target, index, version));
        continue;
      }
      await this.anchorNote(n, index, version);
      if (stale()) return;
    }
    this.paint();
    this.updateBanner();
  }

  /** Re-anchors a note and saves it when its target or status changed. */
  private async anchorNote(n: Note, index: PageTextIndex, version: number): Promise<void> {
    let r = anchor(n.target, index, version);
    if ((r.status === 'orphaned' || r.status === 'ambiguous') && n.target.pageVersion !== version && n.page.pageId) {
      const old = await indexForVersion(this.client, n.page.pageId, n.target.pageVersion);
      r = anchor(n.target, index, version, old);
    }
    if (this.index !== index) return;
    this.results.set(n.id, r);
    const patch: Partial<Note> = {};
    const displayStatus = r.status === 'anchored' && n.target.exact !== n.target.originalExact ? 'changed' : r.status;
    if (n.anchorStatus !== displayStatus) patch.anchorStatus = displayStatus;
    if (r.status === 'anchored' || r.status === 'moved' || r.status === 'changed') {
      const target = rebase(n.target, index, r, version);
      if (JSON.stringify(target) !== JSON.stringify(n.target)) patch.target = target;
      const m = computeMatch(index, r.start, r.end);
      if (n.publishable !== m.ok) patch.publishable = m.ok;
      const reason = m.ok ? null : m.reason;
      if (n.unpublishableReason !== reason) patch.unpublishableReason = reason;
      const cur = r.exact !== n.target.originalExact ? r.exact : null;
      if (n.currentExact !== cur) patch.currentExact = cur;
    }
    if (Object.keys(patch).length) {
      Object.assign(n, patch);
      await this.store.update(n.id, patch);
    }
  }

  private paint(): void {
    if (!this.mapper || !Highlighter.supported()) return;
    const items: Painted[] = [];
    for (const n of this.notes) {
      // Confluence only draws a new comment's highlight once it re-renders the page (often only
      // after a reload). Until then the published note keeps ours, or it would vanish.
      if (n.state === 'published' && this.commentMark(n.id)) continue;
      const r = this.results.get(n.id);
      if (!r || r.start < 0) continue;
      const ranges = this.mapper.offsetsToRanges(r.start, r.end);
      if (!ranges.length) continue;
      if (n.state === 'published') {
        items.push({ noteId: n.id, kind: 'published', ranges });
        continue;
      }
      const attention = r.status === 'ambiguous' || r.status === 'changed' || n.target.exact !== n.target.originalExact;
      items.push({ noteId: n.id, kind: attention ? 'attention' : n.state === 'draft' ? 'draft' : 'private', ranges });
    }
    this.highlighter.paint(items);
  }

  private drafts(): Note[] {
    return this.notes.filter((n) => n.state === 'draft');
  }

  private updateBanner(): void {
    const count = this.drafts().length;
    this.overlay.showBanner(count, () => void this.openSubmit(), () => void this.discard());
    void browser.runtime.sendMessage({ type: 'badge', count }).catch(() => {});
  }

  private async discard(): Promise<void> {
    if (!this.pageRef) return;
    const n = this.drafts().length;
    if (!confirm(`Turn ${n} draft comment${n === 1 ? '' : 's'} back into private notes? Nothing is deleted.`)) return;
    await this.store.discardSession(this.pageRef.key);
  }

  // ---- capture --------------------------------------------------------------

  private currentSelection(): { range: Range; start: number; end: number } | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !this.mapper) return null;
    const range = sel.getRangeAt(0);
    const root = findRoot();
    if (!root || !root.contains(range.commonAncestorContainer)) return null;
    let offs = this.mapper.rangeToOffsets(range);
    if (!offs) {
      // The DOM may have been re-rendered since the last mutation batch.
      this.rebuildMapper();
      offs = this.mapper.rangeToOffsets(range);
    }
    if (!offs) return null;
    if (!this.index!.text.slice(offs.start, offs.end).trim()) return null;
    return { range, ...offs };
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.overlay.owns(e.target)) return;
    setTimeout(() => this.onSelectionMaybe(), 10);
  }

  private onSelectionMaybe(): void {
    if (this.overlay.popoverOpen || this.overlay.dialogOpen) return;
    const s = this.currentSelection();
    if (!s) {
      this.overlay.hideAddButton();
      return;
    }
    this.overlay.showAddButton(s.range.getBoundingClientRect(), () => this.startCapture());
  }

  startCapture(): void {
    if (!this.index || !this.pageRef || this.indexVersion === null) {
      alert(this.unavailable ?? 'margin-notes is still loading this page.');
      return;
    }
    const s = this.currentSelection();
    if (!s) {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) alert('Notes can only be attached to the page text (not to macros, the title or comments).');
      return;
    }
    const rect = s.range.getBoundingClientRect();
    const target = describe(this.index, s.start, s.end, this.indexVersion);
    const match = computeMatch(this.index, s.start, s.end);
    const page = this.pageRef;
    this.overlay.showCreate({
      mode: 'create',
      quote: target.exact,
      publishable: match.ok,
      unpublishableReason: match.ok ? null : match.reason,
      anchorRect: rect,
      onSave: async (action, body) => {
        const note: Note = {
          schemaVersion: SCHEMA_VERSION,
          id: uuid(),
          page,
          state: action === 'private' ? 'private' : 'draft',
          body,
          target,
          anchorStatus: 'anchored',
          currentExact: null,
          publishable: match.ok,
          unpublishableReason: match.ok ? null : match.reason,
          published: null,
          lastError: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          deleted: false,
        };
        if (action === 'draft') await this.store.startSession(page.key);
        await this.store.put(note);
        document.getSelection()?.removeAllRanges();
        if (action === 'publish') await this.publishOne(note.id);
      },
    });
  }

  // ---- interacting with existing notes ---------------------------------------

  private onClick(e: MouseEvent): void {
    if (this.overlay.owns(e.target) || this.overlay.popoverOpen) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const id = this.highlighter.noteAt(e.clientX, e.clientY);
    if (id) this.openNote(id);
  }

  private openNote(id: string): void {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return;
    const ranges = this.highlighter.rangesFor(id);
    const rect = ranges[0]?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2 - 190, 120, 0, 0);
    this.overlay.showEdit({
      mode: 'edit',
      note,
      anchorRect: rect,
      statusText: statusText(note, this.results.get(id)),
      onSave: (body: AdfDoc) => void this.store.update(id, { body }),
      onState: async (state) => {
        if (state === 'draft') await this.store.startSession(note.page.key);
        await this.store.update(id, { state, lastError: null });
      },
      onPublish: () => void this.publishOne(id),
      onDelete: () => void this.store.delete(id),
      onEditPublished: (body) => this.editPublishedNote(id, body),
      onUnpublish: () => this.unpublishNote(id),
    });
    // Opening a published note shows its replies, so they count as read.
    const seen = markThreadSeen(note);
    if (seen) void this.store.update(id, { published: seen.published });
  }

  /** Confluence's highlight of a published note, if it is on this page. */
  private commentMark(id: string): HTMLElement | null {
    const ref = this.notes.find((n) => n.id === id)?.published?.inlineMarkerRef;
    const root = findRoot();
    return ref && root ? findCommentMark(root, ref) : null;
  }

  private scrollTo(id: string): boolean {
    const mark = this.commentMark(id);
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
    const ranges = this.highlighter.rangesFor(id);
    const first = ranges[0];
    if (!first) return false;
    const el = first.startContainer.parentElement;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlighter.flash(id);
    return true;
  }

  /**
   * Scrolls to a note and opens it. Confluence renders long pages
   * progressively, so a note further down may have no DOM yet: scroll to the
   * end of what is rendered and look again.
   */
  async jumpTo(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < JUMP_ATTEMPTS; attempt++) {
      if (this.scrollTo(id)) {
        const rect = () => (this.commentMark(id) ?? this.highlighter.rangesFor(id)[0])?.getBoundingClientRect();
        // Popovers are placed from the target's position, so wait for the scroll to end. Content
        // rendered above the target can still push it out of view meanwhile: scroll again then.
        for (let i = 0; i < 4; i++) {
          await settled(() => rect()?.top);
          const r = rect();
          if (!r || (r.top >= 0 && r.bottom <= window.innerHeight)) break;
          this.scrollTo(id);
        }
        // Clicking Confluence's highlight opens its comment thread.
        const mark = this.commentMark(id);
        if (mark) mark.click();
        else this.openNote(id);
        return true;
      }
      const rendered = findRoot()?.querySelectorAll('[data-renderer-start-pos]');
      rendered?.[rendered.length - 1]?.scrollIntoView({ block: 'end' });
      await new Promise((r) => setTimeout(r, JUMP_RETRY_MS));
      this.rebuildMapper();
      this.paint();
    }
    return false;
  }

  private async reattach(id: string): Promise<string | null> {
    const s = this.currentSelection();
    if (!s) return 'Select the new text on the page first, then click Re-attach.';
    const note = await this.store.get(id);
    if (!note || !this.index || this.indexVersion === null) return 'Note not found.';
    const target = describe(this.index, s.start, s.end, this.indexVersion);
    const m = computeMatch(this.index, s.start, s.end);
    await this.store.update(id, {
      target,
      anchorStatus: 'anchored',
      currentExact: null,
      publishable: m.ok,
      unpublishableReason: m.ok ? null : m.reason,
      lastError: null,
    });
    document.getSelection()?.removeAllRanges();
    return null;
  }

  // ---- sync -------------------------------------------------------------------

  /** Sync runs only in tabs of the site the sync page is on. */
  private async initSync(): Promise<void> {
    const config = await readSyncConfig(browser.storage.local);
    const enabled = config?.host === location.host;
    if (enabled && !this.syncEnabled) this.scheduleSync(SYNC_FIRST_MS);
    this.syncEnabled = enabled;
  }

  private scheduleSync(delay: number): void {
    if (!this.syncEnabled) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      // The service records the error in its state, where the sidebar shows it.
      this.sync.run().catch((e) => console.warn('[margin-notes] sync failed:', (e as Error).message));
    }, delay);
  }

  private async setupSync(): Promise<string | null> {
    try {
      await this.sync.setup(location.host);
      this.syncEnabled = true;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  private async syncNow(): Promise<string | null> {
    if (!this.syncEnabled) return 'Sync is set up for another site. Open a page there to sync.';
    clearTimeout(this.syncTimer);
    try {
      await this.sync.run();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ---- published comments -------------------------------------------------------

  /** Reads resolution and replies of published notes back from Confluence. */
  private async refreshThreads(notes: Note[], force = false): Promise<string | null> {
    let error: string | null = null;
    for (const n of notes) {
      if (n.state !== 'published' || n.page.site !== location.host) continue;
      if (!force && Date.now() - (this.threadCheckedAt.get(n.id) ?? 0) < THREAD_TTL_MS) continue;
      this.threadCheckedAt.set(n.id, Date.now());
      try {
        const updated = await refreshThread(this.client, n);
        if (updated) {
          // Save on top of the latest copy, the note may have been edited meanwhile.
          const cur = await this.store.get(n.id);
          if (cur?.state === 'published' && cur.published?.commentId === n.published?.commentId) {
            await this.store.update(n.id, { published: updated.published });
          }
        }
      } catch (e) {
        error = (e as Error).message;
        console.warn('[margin-notes] could not read comment', n.published?.commentId, error);
      }
    }
    return error;
  }

  /** Every so often, published notes on other pages of this site are checked too. */
  private async sweepThreads(): Promise<void> {
    if (document.hidden) return;
    const all = (await this.store.allNotes()).filter(
      (n) => n.state === 'published' && n.page.site === location.host && n.published?.thread?.resolution !== 'deleted',
    );
    all.sort((a, b) => (this.threadCheckedAt.get(a.id) ?? 0) - (this.threadCheckedAt.get(b.id) ?? 0));
    await this.refreshThreads(all.slice(0, THREAD_SWEEP_MAX));
  }

  private async editPublishedNote(id: string, body: AdfDoc): Promise<string | null> {
    const n = await this.store.get(id);
    if (!n) return 'Note not found.';
    if (n.page.site !== location.host) return `Open a page on ${n.page.site} to edit this comment.`;
    try {
      const updated = await editPublished(this.client, n, body);
      await this.store.put(updated);
      return null;
    } catch (e) {
      const msg = `Could not update the comment: ${(e as Error).message}`;
      await this.store.update(id, { lastError: msg });
      return msg;
    }
  }

  private async unpublishNote(id: string): Promise<string | null> {
    const n = await this.store.get(id);
    if (!n) return 'Note not found.';
    if (n.page.site !== location.host) return `Open a page on ${n.page.site} to unpublish this comment.`;
    try {
      await this.store.put(await unpublish(this.client, n));
      return null;
    } catch (e) {
      const msg = `Could not delete the comment: ${(e as Error).message}`;
      await this.store.update(id, { lastError: msg });
      return msg;
    }
  }

  // ---- publishing -------------------------------------------------------------

  private dialogItem(n: Note): DialogItem {
    let r = this.results.get(n.id);
    if (!r && this.index && this.indexVersion !== null) {
      // A note created a moment ago may not have been through a refresh yet.
      r = anchor(n.target, this.index, this.indexVersion);
      this.results.set(n.id, r);
    }
    if (!n.publishable) return { note: n, status: 'Cannot publish', tone: 'err', blockedReason: n.unpublishableReason };
    if (!r) return { note: n, status: 'Unchecked', tone: 'warn', blockedReason: null };
    const g = gateFor(n, r);
    if (g.gate === 'blocked') return { note: n, status: r.status, tone: 'err', blockedReason: g.reason };
    if (g.gate === 'confirm') return { note: n, status: 'Text changed', tone: 'warn', blockedReason: null };
    return { note: n, status: r.status, tone: 'ok', blockedReason: null };
  }

  private hooks(dialog: SubmitDialog): PublishHooks {
    return {
      confirmChanged: (note, was, now) => dialog.confirm(note.id, was, now),
      progress: (id, phase, detail) => {
        if (phase === 'checking') dialog.setStatus(id, 'Checking…', 'warn');
        else if (phase === 'posting') dialog.setStatus(id, 'Posting…', 'warn');
        else if (phase === 'done') dialog.setStatus(id, 'Published', 'ok');
        else dialog.setStatus(id, 'Not published', 'err', detail);
      },
      save: async (note) => {
        await this.store.put(note);
      },
    };
  }

  async openSubmit(): Promise<void> {
    if (!this.pageRef || this.publishing) return;
    await this.loading;
    const page = this.pageRef;
    const drafts = [...this.drafts()].sort((a, b) => (this.results.get(a.id)?.start ?? a.target.start) - (this.results.get(b.id)?.start ?? b.target.start));
    const session = await this.store.session(page.key);
    const dialog = this.overlay.showSubmitDialog({
      title: `Submit draft comments (${drafts.length})`,
      items: drafts.map((n) => this.dialogItem(n)),
      summary: session?.summary ?? '',
      onSummaryChange: (s) => void this.store.setSummary(page.key, s),
      onSubmit: async () => {
        this.publishing = true;
        dialog.running();
        const summaryText = dialog.summary().trim();
        await this.store.setSummary(page.key, summaryText);
        try {
          const res = await submitDrafts(
            this.client,
            page.pageId!,
            drafts.filter((n) => n.publishable),
            summaryText ? plainToAdf(summaryText) : null,
            this.hooks(dialog),
          );
          const ok = res.outcomes.filter((o) => o.ok).length;
          const failed = res.outcomes.filter((o) => !o.ok);
          for (const f of failed) dialog.addRetry(f.noteId, () => void this.retry(f.noteId, dialog));
          let text = `${ok} of ${drafts.length} published.`;
          if (res.summary?.ok) text += ' Summary posted.';
          if (res.summary && !res.summary.ok) text += ` Summary failed: ${res.summary.error}`;
          if (failed.length) text += ' The rest stay as drafts.';
          dialog.done(text);
          if (!failed.length && (!summaryText || res.summary?.ok)) await this.store.endSession(page.key);
          else if (res.summary?.ok) await this.store.setSummary(page.key, '');
        } finally {
          this.publishing = false;
        }
      },
    });
  }

  private async retry(noteId: string, dialog: SubmitDialog): Promise<void> {
    const n = await this.store.get(noteId);
    if (!n || n.state === 'published') return;
    await publishNote(this.client, n, this.hooks(dialog));
  }

  async publishOne(noteId: string): Promise<void> {
    await this.loading;
    const n = await this.store.get(noteId);
    if (!n || n.state === 'published' || this.publishing) return;
    const dialog = this.overlay.showSubmitDialog({
      title: 'Publish comment',
      items: [this.dialogItem(n)],
      summary: null,
      onSubmit: async () => {
        this.publishing = true;
        dialog.running();
        try {
          const o = await publishNote(this.client, n, this.hooks(dialog));
          dialog.done(o.ok ? 'Published.' : 'Not published. The note keeps its previous state.');
        } finally {
          this.publishing = false;
        }
      },
    });
  }

  /** State dump for e2e tests. */
  debug(): unknown {
    const sel = document.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    return {
      key: this.lastKey,
      unavailable: this.unavailable,
      indexVersion: this.indexVersion,
      blocks: this.index?.blocks.length ?? null,
      coverage: this.mapper?.coverage ?? null,
      popoverOpen: this.overlay.popoverOpen,
      dialogOpen: this.overlay.dialogOpen,
      selection: range ? { text: range.toString(), offsets: this.mapper?.rangeToOffsets(range) ?? null } : null,
      notes: this.notes.map((n) => ({ id: n.id, state: n.state, exact: n.target.exact, result: this.results.get(n.id) })),
    };
  }

  // ---- messages ---------------------------------------------------------------

  private async onMessage(msg: ToContent): Promise<unknown> {
    switch (msg.type) {
      case 'add-note':
        this.startCapture();
        return true;
      case 'get-page': {
        await this.loading;
        const anchors: PageInfo['anchors'] = {};
        for (const [id, r] of this.results) anchors[id] = { status: r.status, exact: r.exact };
        const info: PageInfo = { page: this.pageRef, unavailable: this.pageRef ? null : this.unavailable, version: this.indexVersion, anchors };
        return info;
      }
      case 'scroll-to':
        this.scrollTo(msg.noteId);
        return true;
      case 'edit-note':
        this.scrollTo(msg.noteId);
        setTimeout(() => this.openNote(msg.noteId), 450);
        return true;
      case 'jump-to':
        await this.loading;
        return await this.jumpTo(msg.noteId);
      case 'open-submit':
        await this.openSubmit();
        return true;
      case 'publish-now':
        await this.publishOne(msg.noteId);
        return true;
      case 'reattach':
        return { error: await this.reattach(msg.noteId) };
      case 'edit-published':
        return { error: await this.editPublishedNote(msg.noteId, msg.body) } satisfies ActionResult;
      case 'unpublish':
        return { error: await this.unpublishNote(msg.noteId) } satisfies ActionResult;
      case 'refresh-threads': {
        const published = (await this.store.allNotes()).filter((n) => n.state === 'published' && n.page.site === location.host);
        return { error: await this.refreshThreads(published, true) } satisfies ActionResult;
      }
      case 'sync-setup':
        return { error: await this.setupSync() } satisfies ActionResult;
      case 'sync-now':
        return { error: await this.syncNow() } satisfies ActionResult;
    }
  }
}
