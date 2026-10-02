// The ADF text model.
//
// Confluence counts inline comment matches (textSelectionMatchCount/Index)
// over the page's ADF, not over the rendered DOM text. The rules, ported from
// getIndexMatch in @atlaskit/renderer (actions/matches-utils.js):
//
// - walk the document in order and take the textContent of every text block
//   whose content allows the annotation mark (paragraph, heading, task and
//   decision items, captions),
// - join those texts with no separator,
// - inline atoms (mention, emoji, status, date, inlineCard, hardBreak)
//   contribute nothing,
// - code blocks and extensions (macros) contribute nothing,
// - count matches with a non-overlapping, case-sensitive exact search.
//
// We additionally index code blocks so private notes can live there, but keep
// them out of the "annotatable" text that the publish path counts against.

import type { AdfNode } from './model';

/** Text blocks whose inline content allows the annotation mark. */
const ANNOTATABLE_TEXT_BLOCKS = new Set([
  'paragraph',
  'heading',
  'taskItem',
  'blockTaskItem',
  'decisionItem',
  'caption',
]);

/** Text blocks that are indexed for private notes only. */
const PRIVATE_ONLY_TEXT_BLOCKS = new Set(['codeBlock']);

/** ProseMirror leaf nodes in the ADF schema (size 1, no content). */
const LEAF_NODES = new Set([
  'hardBreak',
  'mention',
  'emoji',
  'status',
  'date',
  'inlineCard',
  'blockCard',
  'embedCard',
  'media',
  'mediaInline',
  'extension',
  'inlineExtension',
  'rule',
  'placeholder',
  'unsupportedInline',
  'unsupportedBlock',
  'confluenceUnsupportedInline',
  'confluenceUnsupportedBlock',
  'confluenceJiraIssue',
  'image',
]);

export interface TextBlock {
  localId: string | null;
  type: string;
  /** ProseMirror position right before the block's opening token. */
  pmPos: number;
  text: string;
  /** Offsets in the full page text. */
  start: number;
  end: number;
  /** Offset in the annotatable text, or null for private-only blocks. */
  annotStart: number | null;
  annotatable: boolean;
}

export interface PageTextIndex {
  /** All indexed block texts joined (used for anchoring). */
  text: string;
  /** Annotatable block texts joined (what Confluence counts against). */
  annotText: string;
  blocks: TextBlock[];
}

function nodeSize(node: AdfNode): number {
  if (node.type === 'text') return node.text?.length ?? 0;
  if (LEAF_NODES.has(node.type)) return 1;
  let size = 2;
  for (const child of node.content ?? []) size += nodeSize(child);
  return size;
}

function textContent(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  let out = '';
  for (const child of node.content ?? []) out += textContent(child);
  return out;
}

export function buildIndex(doc: AdfNode): PageTextIndex {
  const blocks: TextBlock[] = [];
  let text = '';
  let annotText = '';

  const walk = (node: AdfNode, pos: number): void => {
    const annotatable = ANNOTATABLE_TEXT_BLOCKS.has(node.type);
    if (annotatable || PRIVATE_ONLY_TEXT_BLOCKS.has(node.type)) {
      const t = textContent(node);
      const localId = typeof node.attrs?.localId === 'string' ? node.attrs.localId : null;
      blocks.push({
        localId,
        type: node.type,
        pmPos: pos,
        text: t,
        start: text.length,
        end: text.length + t.length,
        annotStart: annotatable ? annotText.length : null,
        annotatable,
      });
      text += t;
      if (annotatable) annotText += t;
      return;
    }
    if (node.type === 'text' || LEAF_NODES.has(node.type)) return;
    let childPos = pos + 1;
    for (const child of node.content ?? []) {
      walk(child, childPos);
      childPos += nodeSize(child);
    }
  };

  // The doc node has no opening token of its own: its content starts at 0.
  let pos = 0;
  for (const child of doc.content ?? []) {
    walk(child, pos);
    pos += nodeSize(child);
  }
  return { text, annotText, blocks };
}

/** The block containing page text offset `offset` (end offsets belong to the earlier block). */
export function blockAt(index: PageTextIndex, offset: number, preferEnd = false): TextBlock | null {
  for (const b of index.blocks) {
    if (offset > b.start && offset < b.end) return b;
    if (offset === b.start && !preferEnd) return b;
    if (offset === b.end && preferEnd) return b;
  }
  // Empty blocks or an offset at the very end.
  for (const b of index.blocks) if (offset >= b.start && offset <= b.end) return b;
  return null;
}

export function blockByLocalId(index: PageTextIndex, localId: string | null): TextBlock | null {
  if (!localId) return null;
  return index.blocks.find((b) => b.localId === localId) ?? null;
}

/** Non-overlapping exact match start offsets, like String.prototype.match(/x/g). */
export function matchOffsets(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

export type MatchResult =
  | { ok: true; textSelection: string; matchCount: number; matchIndex: number }
  | { ok: false; reason: string };

/**
 * Computes the inlineCommentProperties for the page text range [start, end).
 * Fails when the range touches a block Confluence can't anchor comments to, or
 * when the occurrence can't be expressed as an index (overlapping matches).
 */
export function computeMatch(index: PageTextIndex, start: number, end: number): MatchResult {
  if (end <= start) return { ok: false, reason: 'The selection is empty.' };
  const touched = index.blocks.filter((b) => b.end > start && b.start < end);
  if (touched.length === 0) return { ok: false, reason: 'The selection is outside the page text.' };
  if (touched.some((b) => !b.annotatable)) {
    return { ok: false, reason: 'Confluence cannot attach comments to text inside code blocks.' };
  }
  const first = touched[0]!;
  const annotStart = first.annotStart! + (start - first.start);
  const textSelection = index.text.slice(start, end);
  if (!textSelection.trim()) return { ok: false, reason: 'The selection contains only whitespace.' };
  const matches = matchOffsets(index.annotText, textSelection);
  const matchIndex = matches.indexOf(annotStart);
  if (matchIndex === -1) {
    return { ok: false, reason: 'This occurrence overlaps another one and cannot be addressed by Confluence.' };
  }
  return { ok: true, textSelection, matchCount: matches.length, matchIndex };
}
