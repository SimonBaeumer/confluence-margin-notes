// Content script controller for Confluence pages.

import { browser } from 'wxt/browser';
import { buildIndex, computeMatch, type PageTextIndex } from '../core/adf-text';
import { anchor, describe, rebase, targetForQuote, type AnchorResult } from '../core/anchoring';
import { pageKeyFor, SETTINGS_KEY, type ActionResult, type PageInfo, type Settings, type ToContent } from '../core/messages';
import { isGraduated } from '../core/graduate';
import { SCHEMA_VERSION, commentKey, latestReplyAt, newReplyDraft, nowIso, type AdfDoc, type CommentRecord, type Note, type PageRef, type ReplyDraft } from '../core/model';
import { domToAdf, isEmptyDoc, plainToAdf } from '../core/rich-text';
import { isCommentKey, isNoteKey, isReplyKey, isSeenKey, isSessionKey, NoteStore } from '../core/store';
import { ConfluenceClient } from '../confluence/client';
import { confirmDiscardComment, DomMapper, findCommentMark, findCommentThread, findRoot, readPageMeta, type PageMeta } from '../confluence/dom';
import { deleteComment, editComment, readComment, readPageComments } from '../confluence/comments';
import { gateFor, indexForVersion, publishNote, publishReply, submitDrafts, type PublishHooks } from '../confluence/publish';
import { readSyncConfig, SYNC_CONFIG_KEY, SyncService } from '../sync/service';
import { Highlighter, type Painted } from './highlights';
import { Overlay, ThreadStrip, type DialogItem, type ReplyBadge, type SubmitDialog } from './overlay';

const POLL_MS = 700;
const MUTATION_DEBOUNCE_MS = 350;
const JUMP_ATTEMPTS = 12;
const JUMP_RETRY_MS = 250;
const SYNC_FIRST_MS = 3000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 10 * 1000;
/** A page's comments (or one of your comments elsewhere) are read again at most this often per tab. */
const COMMENTS_TTL_MS = 2 * 60 * 1000;
const COMMENT_SWEEP_MS = 10 * 60 * 1000;
const COMMENT_SWEEP_MAX = 25;

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
  /** Private notes and drafts on this page. */
  private notes: Note[] = [];
  /**
   * Notes on this page that were published (tombstones, see graduate.ts). We
   * highlight their text until Confluence draws the comment's own highlight,
   * which it often only does after a reload.
   */
  private published: Note[] = [];
  /** Cached comments on this page. */
  private comments: CommentRecord[] = [];
  /** Your reply drafts (and private notes) on this page's comments. */
  private replies: ReplyDraft[] = [];
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
  /** When a page's comments (by page key) or one comment (by comment key) were last read. */
  private commentsCheckedAt = new Map<string, number>();
  private me: Promise<string> | null = null;
  /** Our strip in Confluence's open comment thread, and the comment it is for. */
  private strip: { ui: ThreadStrip; commentId: string } | null = null;
  private frame = 0;

  start(): void {
    setInterval(() => this.tick(), POLL_MS);
    this.tick();
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      if (keys.some((k) => isNoteKey(k) || isReplyKey(k) || isSessionKey(k) || isCommentKey(k))) void this.refreshNotes();
      if (keys.some((k) => isNoteKey(k) || isReplyKey(k) || isSeenKey(k))) this.scheduleSync(SYNC_DEBOUNCE_MS);
      if (keys.includes(SYNC_CONFIG_KEY)) void this.initSync();
    });
    // Published notes from older versions become comments.
    void this.store.graduatePublished();
    void this.initSync();
    setInterval(() => this.scheduleSync(0), SYNC_INTERVAL_MS);
    setInterval(() => void this.sweepComments(), COMMENT_SWEEP_MS);
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
    window.addEventListener('scroll', () => (this.overlay.hideAddButton(), this.schedule()), { passive: true, capture: true });
    window.addEventListener('resize', () => this.schedule());
    // Confluence opens and re-renders its comment thread popup at any time.
    new MutationObserver(() => this.schedule()).observe(document.body, { childList: true, subtree: true });
  }

  /** Updates the thread strip and the reply badges once per frame. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.decorateThread();
      this.updateBadges();
      this.overlay.avoid(findCommentThread(document)?.root.getBoundingClientRect() ?? null);
    });
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
    this.published = [];
    this.comments = [];
    this.replies = [];
    this.results.clear();
    this.highlighter.clear();
    this.overlay.closePopover();
    this.overlay.hideAddButton();
    this.overlay.showBanner(0, () => {}, () => {});
    this.overlay.showReplyBadges([], 0, () => {});
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
      void this.refreshPageComments();
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
    const all = (await this.store.allNotes(true)).filter((n) => n.page.key === pageKey);
    const comments = await this.store.commentsForPage(pageKey);
    const replies = await this.store.repliesForPage(pageKey);
    if (stale()) return;
    this.notes = all.filter((n) => !n.deleted && n.state !== 'published');
    this.comments = comments;
    this.replies = replies;
    const live = new Set(comments.filter((c) => c.resolution !== 'deleted').map((c) => c.id));
    this.published = all.filter((n) => isGraduated(n) && live.has(n.published!.commentId));
    for (const n of this.published) {
      // Only located, never saved: we paint it until Confluence shows its own highlight.
      this.results.set(n.id, anchor(n.target, index, version));
    }
    for (const n of this.notes) {
      await this.anchorNote(n, index, version);
      if (stale()) return;
    }
    this.paint();
    this.updateBanner();
    this.renderStrip();
    this.updateBadges();
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
    for (const n of this.published) {
      // Confluence only draws a new comment's highlight once it re-renders the page (often only
      // after a reload). Until then the published note keeps ours, or it would vanish.
      if (this.markFor(n.published!.inlineMarkerRef)) continue;
      const r = this.results.get(n.id);
      if (!r || r.start < 0) continue;
      const ranges = this.mapper.offsetsToRanges(r.start, r.end);
      if (ranges.length) items.push({ noteId: n.id, kind: 'published', ranges });
    }
    for (const n of this.notes) {
      const r = this.results.get(n.id);
      if (!r || r.start < 0) continue;
      const ranges = this.mapper.offsetsToRanges(r.start, r.end);
      if (!ranges.length) continue;
      const attention = r.status === 'ambiguous' || r.status === 'changed' || n.target.exact !== n.target.originalExact;
      items.push({ noteId: n.id, kind: attention ? 'attention' : n.state === 'draft' ? 'draft' : 'private', ranges });
    }
    this.highlighter.paint(items);
  }

  private drafts(): Note[] {
    return this.notes.filter((n) => n.state === 'draft');
  }

  private replyDrafts(): ReplyDraft[] {
    return this.replies.filter((r) => r.state === 'draft').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private updateBanner(): void {
    const count = this.drafts().length + this.replyDrafts().length;
    this.overlay.showBanner(count, () => void this.openSubmit(), () => void this.discard());
    this.schedule();
    void browser.runtime.sendMessage({ type: 'badge', count }).catch(() => {});
  }

  private async discard(): Promise<void> {
    if (!this.pageRef) return;
    // The banner asked for confirmation already.
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

  private rectFor(id: string): DOMRect {
    return this.highlighter.rangesFor(id)[0]?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2 - 190, 120, 0, 0);
  }

  private openNote(id: string): void {
    const pub = this.published.find((n) => n.id === id);
    if (pub) return this.openComment(pub.published!.commentId, this.rectFor(id));
    const note = this.notes.find((n) => n.id === id);
    if (!note) return;
    const rect = this.rectFor(id);
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
    });
  }

  /** Our popover for a comment Confluence has not drawn yet. */
  private openComment(commentId: string, rect: DOMRect): void {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return;
    this.overlay.showComment({
      comment: c,
      anchorRect: rect,
      onEdit: (body) => this.editCommentBody(c.page.site, c.id, body),
      onUnpublish: () => this.unpublishComment(c.page.site, c.id),
    });
    // Opening a comment shows its replies, so they count as read.
    void this.markSeen(c);
  }

  private async markSeen(c: CommentRecord): Promise<void> {
    await this.store.applySeen({ [commentKey(c.page.site, c.id)]: latestReplyAt(c, c.createdAt ?? '') });
  }

  /** Confluence's highlight of a comment, if it is on this page. */
  private markFor(ref: string | null | undefined): HTMLElement | null {
    const root = findRoot();
    return ref && root ? findCommentMark(root, ref) : null;
  }

  /** The tombstone we highlight for a comment, if any. */
  private publishedNoteFor(commentId: string): Note | undefined {
    return this.published.find((n) => n.published!.commentId === commentId);
  }

  private commentMark(commentId: string): HTMLElement | null {
    const c = this.comments.find((x) => x.id === commentId);
    return this.markFor(c?.inlineMarkerRef ?? this.publishedNoteFor(commentId)?.published?.inlineMarkerRef);
  }

  /** Scrolls to a note, or to a comment (Confluence's highlight, else ours). */
  private scrollTo(id: string, isComment = false): boolean {
    if (isComment) {
      const mark = this.commentMark(id);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      }
      const pub = this.publishedNoteFor(id);
      if (!pub) return false;
      id = pub.id;
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
  async jumpTo(id: string, isComment = false): Promise<boolean> {
    const hlId = () => (isComment ? (this.publishedNoteFor(id)?.id ?? '') : id);
    for (let attempt = 0; attempt < JUMP_ATTEMPTS; attempt++) {
      if (this.scrollTo(id, isComment)) {
        const rect = () => ((isComment ? this.commentMark(id) : null) ?? this.highlighter.rangesFor(hlId())[0])?.getBoundingClientRect();
        // Popovers are placed from the target's position, so wait for the scroll to end. Content
        // rendered above the target can still push it out of view meanwhile: scroll again then.
        for (let i = 0; i < 4; i++) {
          await settled(() => rect()?.top);
          const r = rect();
          if (!r || (r.top >= 0 && r.bottom <= window.innerHeight)) break;
          this.scrollTo(id, isComment);
        }
        // Clicking Confluence's highlight opens its comment thread.
        const mark = isComment ? this.commentMark(id) : null;
        if (mark) mark.click();
        else this.openNote(hlId());
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

  // ---- replies in Confluence's comment thread ----------------------------------

  private decorateThread(): void {
    const t = this.pageRef ? findCommentThread(document) : null;
    if (!t) {
      this.strip = null;
      return;
    }
    if (this.strip?.commentId === t.commentId && t.wrapper.contains(this.strip.ui.host)) return;
    this.strip?.ui.host.remove();
    this.strip = { ui: new ThreadStrip(document), commentId: t.commentId };
    t.wrapper.append(this.strip.ui.host);
    this.renderStrip();
  }

  private repliesTo(commentId: string): ReplyDraft[] {
    return this.replies.filter((r) => r.commentId === commentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private renderStrip(): void {
    if (!this.strip) return;
    this.strip.ui.render({
      drafts: this.repliesTo(this.strip.commentId),
      onSaveDraft: (anchor) => void this.saveThreadDraft(anchor),
      onOpen: (r, anchor) => this.openReply(r, anchor),
      onPublish: (r) => void this.publishReplyOne(r.id),
    });
  }

  /** The comment a reply goes to, from the cache or, before it is read, from the thread popup. */
  private commentFor(commentId: string, root: HTMLElement | null): Pick<CommentRecord, 'id' | 'page' | 'quote' | 'mine' | 'authorName'> {
    const c = this.comments.find((x) => x.id === commentId);
    if (c) return c;
    const author = root?.getAttribute('aria-label')?.match(/^Inline comment by (.+)$/)?.[1] ?? null;
    const mark = document.querySelector<HTMLElement>('mark[data-mark-annotation-type="inlineComment"][aria-expanded="true"]');
    return { id: commentId, page: this.pageRef!, quote: mark?.textContent?.trim() ?? '', mine: false, authorName: author };
  }

  /** Saves what is typed in Confluence's reply box as a draft, or opens our editor when it is empty. */
  private async saveThreadDraft(anchor: DOMRect): Promise<void> {
    const t = findCommentThread(document);
    if (!t || !this.pageRef) return;
    const c = this.commentFor(t.commentId, t.root);
    const typed = t.editor ? domToAdf(t.editor) : null;
    if (!typed || isEmptyDoc(typed)) return this.openReply(null, anchor, c);
    await this.store.startSession(c.page.key);
    await this.store.putReply(newReplyDraft(c, typed));
    // Empties and closes Confluence's reply box: the text lives on as the draft, so its
    // "discard this comment?" question is answered for you.
    if (t.cancel) {
      t.cancel.click();
      await confirmDiscardComment(document);
    }
  }

  private openReply(r: ReplyDraft | null, anchor: DOMRect, comment?: Pick<CommentRecord, 'id' | 'page' | 'quote' | 'mine' | 'authorName'>): void {
    const c = comment ?? this.commentFor(r!.commentId, null);
    let saving: Promise<unknown> = Promise.resolve();
    this.overlay.showReply({
      reply: r,
      to: c.mine ? 'your comment' : (c.authorName ?? r?.authorName ?? 'the comment'),
      quote: c.quote || r?.quote || '',
      anchorRect: anchor,
      onSave: (body) => {
        if (r) saving = this.store.updateReply(r.id, { body });
        else saving = this.store.startSession(c.page.key).then(() => this.store.putReply(newReplyDraft(c, body)));
      },
      onState: (state) =>
        void saving.then(async () => {
          if (state === 'draft') await this.store.startSession(c.page.key);
          await this.store.updateReply(r!.id, { state, lastError: null });
        }),
      onPublish: () => void saving.then(() => this.publishReplyOne(r!.id)),
      onDelete: () => void this.store.deleteReply(r!.id),
    });
  }

  /** Badges in the margin next to comments with reply drafts, so they show without opening the thread. */
  private updateBadges(): void {
    const root = findRoot();
    const items: ReplyBadge[] = [];
    if (root && this.pageRef) {
      for (const id of new Set(this.replies.map((r) => r.commentId))) {
        const mark = this.commentMark(id);
        const rect = mark?.getClientRects()[0];
        if (!rect) continue;
        const rs = this.repliesTo(id);
        items.push({ commentId: id, rect, drafts: rs.filter((r) => r.state === 'draft').length, privates: rs.filter((r) => r.state === 'private').length });
      }
    }
    const left = root ? root.getBoundingClientRect().right + 12 : 0;
    this.overlay.showReplyBadges(items, left, (id) => void this.jumpTo(id, true));
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

  // ---- comments -------------------------------------------------------------------

  /** Your Confluence account id, read once per tab. */
  private myId(): Promise<string> {
    this.me ??= this.client.currentUser().then(
      (u) => u.accountId,
      (e) => {
        this.me = null;
        throw e;
      },
    );
    return this.me;
  }

  /** Reads every comment on this page into the cache. */
  private async refreshPageComments(force = false): Promise<string | null> {
    const page = this.pageRef;
    if (!page?.pageId) return null;
    if (!force && Date.now() - (this.commentsCheckedAt.get(page.key) ?? 0) < COMMENTS_TTL_MS) return null;
    this.commentsCheckedAt.set(page.key, Date.now());
    try {
      const me = await this.myId();
      const r = await readPageComments(this.client, page, me, await this.store.commentsForPage(page.key));
      // Replies that exist when a comment is first seen are not news, unless the seen map says otherwise.
      const seen: Record<string, string> = {};
      for (const c of r.discovered) {
        const key = commentKey(c.page.site, c.id);
        if (c.mine && !(await this.store.seenAt(key))) seen[key] = latestReplyAt(c, c.createdAt ?? nowIso());
      }
      await this.store.applySeen(seen);
      await this.store.putComments(r.writes);
      await this.store.removeComments(r.removes);
      return null;
    } catch (e) {
      console.warn('[margin-notes] could not read the comments of this page', (e as Error).message);
      return (e as Error).message;
    }
  }

  /** Re-reads your comments on other pages of this site. */
  private async refreshMyComments(records: CommentRecord[], force = false): Promise<string | null> {
    let error: string | null = null;
    const me = await this.myId().catch((e) => ((error = (e as Error).message), null));
    if (!me) return error;
    for (const c of records) {
      const key = commentKey(c.page.site, c.id);
      if (!force && Date.now() - (this.commentsCheckedAt.get(key) ?? 0) < COMMENTS_TTL_MS) continue;
      this.commentsCheckedAt.set(key, Date.now());
      try {
        const next = await readComment(this.client, c, me);
        if (next) await this.store.putComments([next]);
      } catch (e) {
        error = (e as Error).message;
        console.warn('[margin-notes] could not read comment', c.id, error);
      }
    }
    return error;
  }

  private async myCommentsOnSite(): Promise<CommentRecord[]> {
    return (await this.store.allComments()).filter(
      (c) => c.mine && c.page.site === location.host && c.page.key !== this.pageRef?.key && c.resolution !== 'deleted',
    );
  }

  /** Every so often, your comments on other pages of this site are checked too. */
  private async sweepComments(): Promise<void> {
    if (document.hidden) return;
    const mine = await this.myCommentsOnSite();
    mine.sort((a, b) => (a.checkedAt ?? '').localeCompare(b.checkedAt ?? ''));
    await this.refreshMyComments(mine.slice(0, COMMENT_SWEEP_MAX));
  }

  private async editCommentBody(site: string, id: string, body: AdfDoc): Promise<string | null> {
    if (site !== location.host) return `Open a page on ${site} to edit this comment.`;
    const c = await this.store.getComment(site, id);
    if (!c) return 'Comment not found.';
    try {
      await this.store.putComments([await editComment(this.client, c, body)]);
      return null;
    } catch (e) {
      return `Could not update the comment: ${(e as Error).message}`;
    }
  }

  /** Deletes your comment in Confluence and keeps it as a private note. */
  private async unpublishComment(site: string, id: string): Promise<string | null> {
    if (site !== location.host) return `Open a page on ${site} to unpublish this comment.`;
    const c = await this.store.getComment(site, id);
    if (!c) return 'Comment not found.';
    try {
      await deleteComment(this.client, c);
    } catch (e) {
      return `Could not delete the comment: ${(e as Error).message}`;
    }
    // Where it was published from here (or synced from there), the note still knows its target.
    const from = (await this.store.allNotes(true)).find((n) => isGraduated(n) && n.published!.commentId === id);
    let target: Note['target'];
    let status: Note['anchorStatus'] = 'pending';
    if (from) target = from.target;
    else {
      let index = this.pageRef?.key === c.page.key ? this.index : null;
      let version = this.indexVersion;
      if (!index && c.page.pageId) {
        try {
          const snap = await this.client.getPage(c.page.pageId);
          index = buildIndex(snap.adf);
          version = snap.version;
        } catch {
          // Without the page text the note starts out orphaned.
        }
      }
      const t = targetForQuote(index ?? buildIndex({ type: 'doc', content: [] }), c.quote, version ?? 0);
      target = t.target;
      status = t.status;
    }
    const match = this.pageRef?.key === c.page.key && this.index && target.end > target.start ? computeMatch(this.index, target.start, target.end) : null;
    await this.store.put({
      schemaVersion: SCHEMA_VERSION,
      // A new id: the tombstone's deletion would win over bringing it back.
      id: uuid(),
      page: c.page,
      state: 'private',
      body: c.body,
      target,
      anchorStatus: status,
      currentExact: null,
      publishable: match ? match.ok : true,
      unpublishableReason: match && !match.ok ? match.reason : null,
      published: null,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deleted: false,
    });
    await this.store.removeComments([c]);
    return null;
  }

  // ---- publishing -------------------------------------------------------------

  private dialogItem(n: Note): DialogItem {
    let r = this.results.get(n.id);
    if (!r && this.index && this.indexVersion !== null) {
      // A note created a moment ago may not have been through a refresh yet.
      r = anchor(n.target, this.index, this.indexVersion);
      this.results.set(n.id, r);
    }
    const item = { id: n.id, label: `“${n.target.exact.slice(0, 120)}”`, body: n.body };
    if (!n.publishable) return { ...item, status: 'Cannot publish', tone: 'err', blockedReason: n.unpublishableReason };
    if (!r) return { ...item, status: 'Unchecked', tone: 'warn', blockedReason: null };
    const g = gateFor(n, r);
    if (g.gate === 'blocked') return { ...item, status: r.status, tone: 'err', blockedReason: g.reason };
    if (g.gate === 'confirm') return { ...item, status: 'Text changed', tone: 'warn', blockedReason: null };
    return { ...item, status: r.status, tone: 'ok', blockedReason: null };
  }

  private replyItem(r: ReplyDraft): DialogItem {
    const c = this.comments.find((x) => x.id === r.commentId);
    const who = c ? (c.mine ? 'your comment' : (c.authorName ?? 'a comment')) : (r.authorName ?? 'a comment');
    const item = { id: r.id, label: `Reply to ${who}: “${(c?.quote ?? r.quote).slice(0, 80)}”`, body: r.body };
    if (c?.resolution === 'deleted') return { ...item, status: 'Deleted', tone: 'err', blockedReason: 'The comment no longer exists in Confluence.' };
    if (c?.resolution === 'resolved') return { ...item, status: 'Resolved', tone: 'warn', blockedReason: null };
    return { ...item, status: 'Reply', tone: 'ok', blockedReason: null };
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
      saveReply: async (reply) => {
        await this.store.putReply(reply);
        // Read the thread again so the reply shows up in it.
        if (reply.publishedId) await this.refreshComment(reply.page.site, reply.commentId);
      },
    };
  }

  private async refreshComment(site: string, id: string): Promise<void> {
    const c = await this.store.getComment(site, id);
    if (c) await this.refreshMyComments([c], true);
  }

  async openSubmit(): Promise<void> {
    if (!this.pageRef || this.publishing) return;
    await this.loading;
    const page = this.pageRef;
    const drafts = [...this.drafts()].sort((a, b) => (this.results.get(a.id)?.start ?? a.target.start) - (this.results.get(b.id)?.start ?? b.target.start));
    const replies = this.replyDrafts();
    const session = await this.store.session(page.key);
    const total = drafts.length + replies.length;
    const dialog = this.overlay.showSubmitDialog({
      title: `Submit draft comments (${total})`,
      items: [...drafts.map((n) => this.dialogItem(n)), ...replies.map((r) => this.replyItem(r))],
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
            replies.filter((r) => !this.replyItem(r).blockedReason),
          );
          const ok = res.outcomes.filter((o) => o.ok).length;
          const failed = res.outcomes.filter((o) => !o.ok);
          for (const f of failed) dialog.addRetry(f.noteId, () => void this.retry(f.noteId, dialog));
          let text = `${ok} of ${total} published.`;
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
    const r = await this.store.getReply(noteId);
    if (r) {
      if (!r.deleted) await publishReply(this.client, r, this.hooks(dialog));
      return;
    }
    const n = await this.store.get(noteId);
    if (!n || n.deleted || n.state === 'published') return;
    await publishNote(this.client, n, this.hooks(dialog));
  }

  async publishOne(noteId: string): Promise<void> {
    await this.loading;
    const n = await this.store.get(noteId);
    if (!n || n.deleted || n.state === 'published' || this.publishing) return;
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

  async publishReplyOne(replyId: string): Promise<string | null> {
    await this.loading;
    const r = await this.store.getReply(replyId);
    if (!r || r.deleted || this.publishing) return null;
    if (r.page.site !== location.host) return `Open a page on ${r.page.site} to publish this reply.`;
    const item = this.replyItem(r);
    const dialog = this.overlay.showSubmitDialog({
      title: 'Publish reply',
      items: [item],
      summary: null,
      onSubmit: async () => {
        this.publishing = true;
        dialog.running();
        try {
          const o = await publishReply(this.client, r, this.hooks(dialog));
          dialog.done(o.ok ? 'Published.' : 'Not published. The reply keeps its previous state.');
        } finally {
          this.publishing = false;
        }
      },
    });
    return null;
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
      comments: this.comments.map((c) => ({ id: c.id, mine: c.mine, resolution: c.resolution, quote: c.quote })),
      replies: this.replies.map((r) => ({ id: r.id, commentId: r.commentId, state: r.state })),
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
      case 'jump-to-comment':
        await this.loading;
        return await this.jumpTo(msg.commentId, true);
      case 'open-submit':
        await this.openSubmit();
        return true;
      case 'publish-now':
        await this.publishOne(msg.noteId);
        return true;
      case 'publish-reply':
        return { error: await this.publishReplyOne(msg.replyId) } satisfies ActionResult;
      case 'reattach':
        return { error: await this.reattach(msg.noteId) };
      case 'edit-comment':
        return { error: await this.editCommentBody(msg.site, msg.commentId, msg.body) } satisfies ActionResult;
      case 'unpublish':
        return { error: await this.unpublishComment(msg.site, msg.commentId) } satisfies ActionResult;
      case 'refresh-comments': {
        const here = await this.refreshPageComments(true);
        const elsewhere = await this.refreshMyComments(await this.myCommentsOnSite(), true);
        return { error: here ?? elsewhere } satisfies ActionResult;
      }
      case 'sync-setup':
        return { error: await this.setupSync() } satisfies ActionResult;
      case 'sync-now':
        return { error: await this.syncNow() } satisfies ActionResult;
    }
  }
}
