// Mapping between the rendered page (DOM) and the ADF text model.
//
// Every rendered block carries data-renderer-start-pos, its ProseMirror
// position. That pairs DOM blocks with index blocks. Inside a block the DOM
// text differs from the ADF text (mentions, smart links, emoji and dates are
// rendered as text but count as nothing), so offsets are mapped through a
// character diff of the two strings.

import DiffMatchPatch from 'diff-match-patch';
import type { PageTextIndex, TextBlock } from '../core/adf-text';

export const ROOT_SELECTOR = '.ak-renderer-document';

/**
 * Comment bodies use the same renderer. An open inline comment renders inside
 * #main-content before the page body, footer comments render after it.
 */
const COMMENT_SELECTOR =
  '[data-testid="renderer-comments-sidebar"], [data-testid^="inline-comment"], [data-testid="object-comment-wrapper"], [data-testid^="footer-comment"]';

/** The renderer of the page body, never one of a comment or a nested renderer. */
export function findRoot(doc: Document = document): HTMLElement | null {
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>(ROOT_SELECTOR)).filter(
    (el) => !el.closest(COMMENT_SELECTOR) && !el.parentElement?.closest(ROOT_SELECTOR),
  );
  return candidates.find((el) => el.closest('#main-content')) ?? candidates[0] ?? null;
}

/** Confluence's own highlight of a published inline comment. */
export function findCommentMark(root: HTMLElement, markerRef: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`mark[data-mark-type="annotation"][data-id="${CSS.escape(markerRef)}"]`);
}

/** Confluence's open inline comment thread (the popup next to the page text). */
export interface CommentThreadUi {
  root: HTMLElement;
  /** The top-level comment of the thread. */
  commentId: string;
  /** Where the replies and the reply box are; our strip goes at its end. */
  wrapper: HTMLElement;
  /** Confluence's reply editor, while it is open. */
  editor: HTMLElement | null;
  cancel: HTMLElement | null;
}

export function findCommentThread(doc: Document): CommentThreadUi | null {
  const root = doc.querySelector<HTMLElement>('[data-testid="renderer-comments-sidebar"]');
  if (!root) return null;
  // The first comment in the thread is the top-level one, the replies follow it.
  const commentId = root.querySelector<HTMLElement>('[data-testid="inline-comment-container"] [data-comment-id]')?.dataset.commentId;
  const wrapper = root.querySelector<HTMLElement>('[data-testid="inline-comment-sidebar-wrapper"]');
  if (!commentId || !wrapper) return null;
  const box = root.querySelector<HTMLElement>('[data-testid="inline-comment-new-reply-container"]');
  return {
    root,
    commentId,
    wrapper,
    editor: box?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null,
    cancel: box?.querySelector<HTMLElement>('[data-testid="editor-cancel-inline-comment-action"]') ?? null,
  };
}

/**
 * Confirms Confluence's "Do you want to discard this comment?" question, which
 * cancelling a reply with text asks. Waits for it up to `ms`; resolves whether it was answered.
 */
export async function confirmDiscardComment(doc: Document, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = doc.querySelector<HTMLElement>('[data-testid="modal-dialog-comment-warning"] [data-testid="comment-warning-ok-button"]');
    if (ok) {
      ok.click();
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export interface PageMeta {
  host: string;
  pageId: string;
  version: number;
  title: string;
  spaceKey: string | null;
}

function meta(doc: Document, name: string): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || null;
}

export function readPageMeta(doc: Document = document, loc: Location = location): PageMeta | null {
  const fromUrl = loc.pathname.match(/\/pages\/(\d+)/)?.[1] ?? null;
  const pageId = meta(doc, 'ajs-page-id') ?? fromUrl;
  if (!pageId) return null;
  // The meta tag may lag behind after SPA navigation; trust the URL when they differ.
  if (fromUrl && fromUrl !== pageId) return null;
  if (/\/pages\/edit-v2\//.test(loc.pathname) || /resumedraft/.test(loc.pathname)) return null;
  const title =
    doc.querySelector('[data-testid="title-text"]')?.textContent?.trim() ||
    meta(doc, 'ajs-page-title') ||
    doc.title.replace(/ - .*$/, '');
  return {
    host: loc.host,
    pageId,
    version: Number(meta(doc, 'ajs-page-version') ?? NaN),
    title,
    spaceKey: meta(doc, 'ajs-space-key'),
  };
}

/** Elements inside a block whose text is never part of the ADF text. */
const CHROME_SELECTOR = 'button, [aria-hidden="true"], [contenteditable="false"] svg, .heading-anchor-wrapper, style, script';

interface DomBlock {
  el: HTMLElement;
  block: TextBlock;
  nodes: Text[];
  /** Cumulative start offset of each text node in domText. */
  starts: number[];
  domText: string;
  /** diffs adf -> dom, and dom -> adf */
  a2d: [number, string][];
  d2a: [number, string][];
}

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0.2;

function collectText(el: HTMLElement): { nodes: Text[]; starts: number[]; text: string } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = n.parentElement;
      if (parent && parent !== el && parent.closest(CHROME_SELECTOR) && el.contains(parent.closest(CHROME_SELECTOR))) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }
  return { nodes, starts, text };
}

/** Maps a position in text1 of `diffs` to text2, the way diff_xIndex does but biased to the right inside insertions. */
function mapIndex(diffs: [number, string][], loc: number, preferEnd: boolean): number {
  if (!preferEnd) return dmp.diff_xIndex(diffs as never, loc);
  // For end positions, an insertion right before loc belongs before it.
  let c1 = 0;
  let c2 = 0;
  for (const [op, text] of diffs) {
    if (op !== 1) {
      if (c1 + text.length >= loc && op === 0) return c2 + (loc - c1);
      if (c1 + text.length > loc && op === -1) return c2;
      c1 += text.length;
    }
    if (op !== -1) c2 += text.length;
  }
  return c2;
}

export class DomMapper {
  private blocks: DomBlock[] = [];
  private byEl = new Map<Element, DomBlock>();

  constructor(
    readonly root: HTMLElement,
    readonly index: PageTextIndex,
  ) {
    this.build();
  }

  /** Share of index blocks that found their element; low values mean the DOM and ADF disagree. */
  get coverage(): number {
    return this.index.blocks.length ? this.blocks.length / this.index.blocks.length : 1;
  }

  private build(): void {
    const els = Array.from(this.root.querySelectorAll<HTMLElement>('[data-renderer-start-pos]'));
    const byPos = new Map<number, HTMLElement[]>();
    for (const el of els) {
      const pos = Number(el.dataset.rendererStartPos);
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos)!.push(el);
    }
    // The renderer may report the position before or after the opening token;
    // pick whichever convention matches more blocks.
    const score = (delta: number) => this.index.blocks.filter((b) => byPos.has(b.pmPos + delta)).length;
    const delta = [0, 1].sort((a, b) => score(b) - score(a))[0]!;
    for (const block of this.index.blocks) {
      const candidates = byPos.get(block.pmPos + delta) ?? [];
      // Prefer the innermost element (a wrapper and its block may share a position).
      let el = candidates.sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))[0];
      if (!el && block.localId) {
        // Code blocks carry no position, only their localId.
        const byId = this.root.querySelector<HTMLElement>(`[data-local-id="${CSS.escape(block.localId)}"]`);
        el = byId?.querySelector<HTMLElement>('[data-testid="renderer-code-block"]') ?? byId ?? undefined;
      }
      if (!el) continue;
      const { nodes, starts, text } = collectText(el);
      const a2d = dmp.diff_main(block.text, text) as [number, string][];
      const d2a = a2d.map(([op, t]) => [-op, t] as [number, string]);
      const db: DomBlock = { el, block, nodes, starts, domText: text, a2d, d2a };
      this.blocks.push(db);
      this.byEl.set(el, db);
    }
  }

  private domBlockFor(node: Node): DomBlock | null {
    let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
    while (el && el !== this.root.parentElement) {
      const db = this.byEl.get(el);
      if (db) return db;
      el = el.parentElement;
    }
    return null;
  }

  /** Converts a DOM boundary point to an offset in the block's DOM text. */
  private domOffset(db: DomBlock, container: Node, offset: number): number {
    if (container.nodeType === 3) {
      const i = db.nodes.indexOf(container as Text);
      if (i >= 0) return db.starts[i]! + Math.min(offset, (container as Text).length);
    }
    // Element container (or a rejected text node): count text before the boundary.
    const probe = container.ownerDocument!.createRange();
    probe.setStart(db.el, 0);
    try {
      probe.setEnd(container, offset);
    } catch {
      return 0;
    }
    let count = 0;
    for (let i = 0; i < db.nodes.length; i++) {
      const n = db.nodes[i]!;
      if (probe.comparePoint(n, n.length) <= 0) count = db.starts[i]! + n.length;
      else if (probe.comparePoint(n, 0) <= 0) count = db.starts[i]! + (probe.endContainer === n ? probe.endOffset : 0);
    }
    return count;
  }

  /** Page text offsets for a DOM range, or null if it is outside the mapped blocks. */
  rangeToOffsets(range: Range): { start: number; end: number } | null {
    let startDb = this.domBlockFor(range.startContainer);
    let endDb = this.domBlockFor(range.endContainer);
    // Triple-click selections end at offset 0 of the next block: pull the end back.
    if (startDb && endDb && endDb !== startDb && this.domOffset(endDb, range.endContainer, range.endOffset) === 0) {
      const i = this.blocks.indexOf(endDb);
      if (i > 0) {
        endDb = this.blocks[i - 1]!;
        const start = startDb.block.start + mapIndex(startDb.d2a, this.domOffset(startDb, range.startContainer, range.startOffset), false);
        return { start, end: endDb.block.end };
      }
    }
    if (!startDb || !endDb) {
      // Boundaries in unmapped areas (macros, chrome): give up rather than guess.
      return null;
    }
    const ds = this.domOffset(startDb, range.startContainer, range.startOffset);
    const de = this.domOffset(endDb, range.endContainer, range.endOffset);
    const start = startDb.block.start + mapIndex(startDb.d2a, ds, false);
    const end = endDb.block.start + mapIndex(endDb.d2a, de, true);
    if (end <= start) return null;
    return { start, end };
  }

  private point(offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
    const db =
      this.blocks.find((b) => (preferEnd ? offset > b.block.start && offset <= b.block.end : offset >= b.block.start && offset < b.block.end)) ??
      this.blocks.find((b) => offset >= b.block.start && offset <= b.block.end);
    if (!db || db.nodes.length === 0) return null;
    const d = mapIndex(db.a2d, offset - db.block.start, preferEnd);
    for (let i = db.nodes.length - 1; i >= 0; i--) {
      const s = db.starts[i]!;
      if (d > s || (d === s && !preferEnd) || i === 0) {
        return { node: db.nodes[i]!, offset: Math.min(Math.max(0, d - s), db.nodes[i]!.length) };
      }
    }
    return null;
  }

  /** DOM range for page text offsets [start, end), or null when unmapped. */
  offsetsToRange(start: number, end: number): Range | null {
    const s = this.point(start, false);
    const e = this.point(end, true);
    if (!s || !e) return null;
    const r = this.root.ownerDocument.createRange();
    try {
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
    } catch {
      return null;
    }
    return r.collapsed ? null : r;
  }

  /** Splits a cross-block range into per-block ranges (highlights look nicer and stay valid). */
  offsetsToRanges(start: number, end: number): Range[] {
    const out: Range[] = [];
    for (const db of this.blocks) {
      const s = Math.max(start, db.block.start);
      const e = Math.min(end, db.block.end);
      if (e > s) {
        const r = this.offsetsToRange(s, e);
        if (r) out.push(r);
      }
    }
    return out;
  }

  /** The DOM text of the block containing `offset`, for debugging. */
  debugBlock(offset: number): { adf: string; dom: string } | null {
    const db = this.blocks.find((b) => offset >= b.block.start && offset <= b.block.end);
    return db ? { adf: db.block.text, dom: db.domText } : null;
  }
}
