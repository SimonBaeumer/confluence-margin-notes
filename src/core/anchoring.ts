// Re-finding a note's text after the page changed.
//
// The cascade (see appendix-explain-reanchoring.md) goes from the most precise
// clue to the least precise one, and every step re-verifies the quote:
//
//   1. same page version: stored block + offsets
//   2. block localId: exact, then fuzzy search inside that block
//   3. version diff: map the old offsets through a diff of old -> new page text
//   4. whole page quote search, scored like Hypothesis (quote 50, prefix 20,
//      suffix 20, position 2), with a minimum score and an ambiguity check
//   5. orphaned
//
// The quote scoring is adapted from hypothesis/client match-quote.ts (BSD-2).

import search from 'approx-string-match';
import DiffMatchPatch from 'diff-match-patch';
import { blockAt, blockByLocalId, type PageTextIndex } from './adf-text';
import type { AnchorStatus, Target } from './model';

export const CONTEXT_LENGTH = 64;
/** Below this the best candidate is not trusted. */
export const MIN_SCORE = 0.7;
/** Quotes shorter than this only match exactly. */
export const SHORT_QUOTE = 8;
/** Candidates whose scores differ less than this are indistinguishable. */
const AMBIGUITY_MARGIN = 0.02;

export interface AnchorResult {
  status: Exclude<AnchorStatus, 'pending'>;
  start: number;
  end: number;
  /** The text the note now sits on (equals target.exact unless changed). */
  exact: string;
  /** How the note was found, for debugging and tests. */
  via: 'version' | 'block' | 'block-fuzzy' | 'diff' | 'quote' | 'quote-fuzzy' | 'none';
  /** For ambiguous results: the competing page text offsets. */
  candidates?: number[];
}

/** Builds a fresh target for page text range [start, end). */
export function describe(index: PageTextIndex, start: number, end: number, pageVersion: number): Target {
  const startBlock = blockAt(index, start, false);
  const endBlock = blockAt(index, end, true);
  const exact = index.text.slice(start, end);
  return {
    pageVersion,
    startBlockLocalId: startBlock?.localId ?? null,
    endBlockLocalId: endBlock?.localId ?? null,
    startBlockOffset: startBlock ? start - startBlock.start : 0,
    endBlockOffset: endBlock ? end - endBlock.start : 0,
    start,
    end,
    exact,
    prefix: index.text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: index.text.slice(end, end + CONTEXT_LENGTH),
    originalExact: exact,
    originalVersion: pageVersion,
  };
}

/** Moves a target onto the current page after a successful anchor. */
export function rebase(target: Target, index: PageTextIndex, result: AnchorResult, pageVersion: number): Target {
  const fresh = describe(index, result.start, result.end, pageVersion);
  return { ...fresh, originalExact: target.originalExact, originalVersion: target.originalVersion };
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matches = search(a, b, b.length);
  if (matches.length === 0) return 0;
  return Math.max(0, 1 - Math.min(...matches.map((m) => m.errors)) / b.length);
}

interface Candidate {
  start: number;
  end: number;
  quoteScore: number;
  score: number;
}

function scoreCandidates(
  text: string,
  target: Pick<Target, 'exact' | 'prefix' | 'suffix'>,
  hint: number,
  spans: { start: number; end: number; errors: number }[],
): Candidate[] {
  const quoteWeight = 50;
  const prefixWeight = 20;
  const suffixWeight = 20;
  const posWeight = 2;
  const out: Candidate[] = [];
  for (const s of spans) {
    const quoteScore = 1 - s.errors / Math.max(1, target.exact.length);
    const prefixScore = target.prefix
      ? similarity(text.slice(Math.max(0, s.start - target.prefix.length), s.start), target.prefix)
      : 1;
    const suffixScore = target.suffix ? similarity(text.slice(s.end, s.end + target.suffix.length), target.suffix) : 1;
    const posScore = text.length ? 1 - Math.abs(s.start - hint) / text.length : 1;
    const raw = quoteWeight * quoteScore + prefixWeight * prefixScore + suffixWeight * suffixScore + posWeight * posScore;
    out.push({ start: s.start, end: s.end, quoteScore, score: raw / (quoteWeight + prefixWeight + suffixWeight + posWeight) });
  }
  return out.sort((a, b) => b.score - a.score);
}

function exactSpans(text: string, quote: string): { start: number; end: number; errors: number }[] {
  const out: { start: number; end: number; errors: number }[] = [];
  if (!quote) return out;
  let i = text.indexOf(quote);
  while (i !== -1) {
    out.push({ start: i, end: i + quote.length, errors: 0 });
    i = text.indexOf(quote, i + 1);
  }
  return out;
}

function fuzzySpans(text: string, quote: string): { start: number; end: number; errors: number }[] {
  if (quote.length < SHORT_QUOTE) return [];
  const maxErrors = Math.min(256, Math.floor(quote.length / 2));
  return search(text, quote, maxErrors);
}

function rangeOf(index: PageTextIndex, target: Target): { start: number; end: number } | null {
  const sb = blockByLocalId(index, target.startBlockLocalId);
  const eb = blockByLocalId(index, target.endBlockLocalId);
  if (sb && eb) return { start: sb.start + target.startBlockOffset, end: eb.start + target.endBlockOffset };
  if (!target.startBlockLocalId && !target.endBlockLocalId) return { start: target.start, end: target.end };
  return null;
}

function step1SameVersion(index: PageTextIndex, target: Target, version: number): AnchorResult | null {
  if (version !== target.pageVersion) return null;
  const r = rangeOf(index, target);
  if (r && index.text.slice(r.start, r.end) === target.exact) {
    return { status: 'anchored', ...r, exact: target.exact, via: 'version' };
  }
  return null;
}

function step2Block(index: PageTextIndex, target: Target): AnchorResult | null {
  if (!target.startBlockLocalId || target.startBlockLocalId !== target.endBlockLocalId) return null;
  const block = blockByLocalId(index, target.startBlockLocalId);
  if (!block) return null;
  const exact = exactSpans(block.text, target.exact);
  if (exact.length > 0) {
    const best = scoreCandidates(block.text, target, target.startBlockOffset, exact)[0]!;
    const start = block.start + best.start;
    const end = block.start + best.end;
    const same = best.start === target.startBlockOffset && start === target.start;
    return { status: same ? 'anchored' : 'moved', start, end, exact: target.exact, via: 'block' };
  }
  const fuzzy = scoreCandidates(block.text, target, target.startBlockOffset, fuzzySpans(block.text, target.exact));
  const best = fuzzy[0];
  if (best && best.quoteScore >= MIN_SCORE) {
    const start = block.start + best.start;
    const end = block.start + best.end;
    return { status: 'changed', start, end, exact: index.text.slice(start, end), via: 'block-fuzzy' };
  }
  return null;
}

function step3Diff(index: PageTextIndex, target: Target, oldIndex: PageTextIndex | undefined): AnchorResult | null {
  if (!oldIndex) return null;
  // Only meaningful if the old index really contains the quote at the stored offsets.
  if (oldIndex.text.slice(target.start, target.end) !== target.exact) return null;
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1;
  const diffs = dmp.diff_main(oldIndex.text, index.text);
  const start = dmp.diff_xIndex(diffs, target.start);
  const end = dmp.diff_xIndex(diffs, target.end);
  if (end <= start) return null;
  const now = index.text.slice(start, end);
  if (now === target.exact) return { status: 'moved', start, end, exact: now, via: 'diff' };
  if (similarity(now, target.exact) >= MIN_SCORE && similarity(target.exact, now) >= MIN_SCORE) {
    return { status: 'changed', start, end, exact: now, via: 'diff' };
  }
  return null;
}

function step4Quote(index: PageTextIndex, target: Target): AnchorResult | null {
  const exact = exactSpans(index.text, target.exact);
  const spans = exact.length > 0 ? exact : fuzzySpans(index.text, target.exact);
  const ranked = scoreCandidates(index.text, target, target.start, spans);
  const best = ranked[0];
  if (!best || best.score < MIN_SCORE || best.quoteScore < MIN_SCORE) return null;
  const rivals = ranked.filter((c) => best.score - c.score < AMBIGUITY_MARGIN);
  const now = index.text.slice(best.start, best.end);
  if (rivals.length > 1) {
    return {
      status: 'ambiguous',
      start: best.start,
      end: best.end,
      exact: now,
      via: exact.length ? 'quote' : 'quote-fuzzy',
      candidates: rivals.map((c) => c.start),
    };
  }
  if (now === target.exact) return { status: 'moved', start: best.start, end: best.end, exact: now, via: 'quote' };
  return { status: 'changed', start: best.start, end: best.end, exact: now, via: 'quote-fuzzy' };
}

/**
 * Re-anchors a target on the current page text.
 * `oldIndex` is the page text at `target.pageVersion`, when it can be fetched.
 */
export function anchor(
  target: Target,
  index: PageTextIndex,
  version: number,
  oldIndex?: PageTextIndex,
): AnchorResult {
  return (
    step1SameVersion(index, target, version) ??
    step2Block(index, target) ??
    step3Diff(index, target, oldIndex) ??
    step4Quote(index, target) ?? { status: 'orphaned', start: -1, end: -1, exact: '', via: 'none' }
  );
}
