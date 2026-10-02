// Publishing notes as Confluence inline comments.
//
// Each note goes through a strict gate right before its POST:
//   fetch the current page -> re-anchor against it -> only anchored/moved
//   publish directly, changed needs a confirmation, ambiguous/orphaned are
//   blocked -> compute textSelection/count/index from the same snapshot -> POST.
// Notes run one at a time because every comment changes the page body.

import { buildIndex, computeMatch, type PageTextIndex } from '../core/adf-text';
import { anchor, rebase, type AnchorResult } from '../core/anchoring';
import type { AdfDoc, Note } from '../core/model';
import { nowIso } from '../core/model';
import { adfToPlain } from '../core/rich-text';
import { ConfluenceError, type ConfluenceClient, type PageSnapshot } from './client';

export type PublishOutcome =
  | { noteId: string; ok: true; commentId: string; webUrl: string | null }
  | { noteId: string; ok: false; skipped: boolean; error: string };

export interface PublishHooks {
  /** Asked for notes whose text changed since capture. Return false to skip. */
  confirmChanged(note: Note, was: string, now: string): Promise<boolean>;
  progress(noteId: string, phase: 'checking' | 'posting' | 'done' | 'failed', detail?: string): void;
  /** Persists a note update. */
  save(note: Note): Promise<void>;
}

/** Old page versions never change, so their indexes can be cached for the session. */
const versionCache = new Map<string, PageTextIndex>();

export async function indexForVersion(client: ConfluenceClient, pageId: string, version: number): Promise<PageTextIndex | undefined> {
  const key = `${pageId}@${version}`;
  if (versionCache.has(key)) return versionCache.get(key);
  try {
    const snap = await client.getPage(pageId, version);
    const idx = buildIndex(snap.adf);
    versionCache.set(key, idx);
    return idx;
  } catch {
    return undefined;
  }
}

export interface GateResult {
  result: AnchorResult;
  /** The status the publish gate acts on (changed also covers text edited since capture). */
  gate: 'ok' | 'confirm' | 'blocked';
  reason: string | null;
}

export function gateFor(note: Note, result: AnchorResult): GateResult {
  if (result.status === 'orphaned') return { result, gate: 'blocked', reason: 'The text is gone. Re-attach the note to a new selection first.' };
  if (result.status === 'ambiguous') {
    return { result, gate: 'blocked', reason: 'The text now appears in several places that cannot be told apart. Re-attach the note first.' };
  }
  if (result.status === 'changed' || result.exact !== note.target.originalExact) {
    return { result, gate: 'confirm', reason: null };
  }
  return { result, gate: 'ok', reason: null };
}

async function anchorFresh(client: ConfluenceClient, note: Note, snap: PageSnapshot) {
  const idx = buildIndex(snap.adf);
  const old = snap.version !== note.target.pageVersion ? await indexForVersion(client, snap.pageId, note.target.pageVersion) : undefined;
  return { idx, result: anchor(note.target, idx, snap.version, old) };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** After an uncertain failure: did the comment get created anyway? */
async function findDuplicate(client: ConfluenceClient, pageId: string, selection: string, body: AdfDoc, since: number) {
  try {
    const want = normalize(adfToPlain(body));
    const list = await client.listInlineComments(pageId);
    return (
      list.find(
        (c) =>
          c.inlineOriginalSelection === selection &&
          normalize(c.bodyText) === want &&
          (!c.createdAt || Date.parse(c.createdAt) >= since - 60_000),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export async function publishNote(client: ConfluenceClient, note: Note, hooks: PublishHooks): Promise<PublishOutcome> {
  const pageId = note.page.pageId;
  if (!pageId) return { noteId: note.id, ok: false, skipped: true, error: 'Only Confluence notes can be published.' };
  const fail = async (error: string, skipped = false): Promise<PublishOutcome> => {
    hooks.progress(note.id, 'failed', error);
    await hooks.save({ ...note, lastError: error });
    return { noteId: note.id, ok: false, skipped, error };
  };

  let confirmed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    hooks.progress(note.id, 'checking');
    let snap: PageSnapshot;
    try {
      snap = await client.getPage(pageId);
    } catch (e) {
      return fail(`Could not load the page: ${(e as Error).message}`);
    }
    const { idx, result } = await anchorFresh(client, note, snap);
    const gate = gateFor(note, result);
    if (gate.gate === 'blocked') {
      await hooks.save({ ...note, anchorStatus: result.status, lastError: gate.reason });
      return fail(gate.reason!, true);
    }
    if (gate.gate === 'confirm' && !confirmed) {
      confirmed = await hooks.confirmChanged(note, note.target.originalExact, result.exact);
      if (!confirmed) return fail('Skipped: the text changed and publishing was not confirmed.', true);
    }
    const match = computeMatch(idx, result.start, result.end);
    if (!match.ok) return fail(match.reason, true);

    hooks.progress(note.id, 'posting');
    const startedAt = Date.now();
    try {
      const created = await client.createInlineComment(pageId, note.body, {
        textSelection: match.textSelection,
        textSelectionMatchCount: match.matchCount,
        textSelectionMatchIndex: match.matchIndex,
      });
      const target = rebase(note.target, idx, result, snap.version);
      const warn =
        created.inlineOriginalSelection && created.inlineOriginalSelection !== match.textSelection
          ? `Confluence anchored the comment on "${created.inlineOriginalSelection}".`
          : null;
      await hooks.save({
        ...note,
        state: 'published',
        target,
        anchorStatus: 'anchored',
        published: {
          commentId: created.id,
          inlineMarkerRef: created.inlineMarkerRef,
          webUrl: created.webUrl,
          publishedAt: nowIso(),
        },
        lastError: warn,
      });
      hooks.progress(note.id, 'done');
      return { noteId: note.id, ok: true, commentId: created.id, webUrl: created.webUrl };
    } catch (e) {
      const err = e as Error;
      if (err instanceof ConfluenceError && err.status === 400 && attempt === 0) {
        // Most likely the page changed between our fetch and the POST: try once more.
        continue;
      }
      if (!(err instanceof ConfluenceError) || err.status >= 500) {
        const dup = await findDuplicate(client, pageId, match.textSelection, note.body, startedAt);
        if (dup) {
          await hooks.save({
            ...note,
            state: 'published',
            anchorStatus: 'anchored',
            published: { commentId: dup.id, inlineMarkerRef: dup.inlineMarkerRef, webUrl: dup.webUrl, publishedAt: nowIso() },
            lastError: null,
          });
          hooks.progress(note.id, 'done');
          return { noteId: note.id, ok: true, commentId: dup.id, webUrl: dup.webUrl };
        }
      }
      return fail(err.message);
    }
  }
  return fail('Confluence rejected the comment twice.');
}

export interface SubmitResult {
  outcomes: PublishOutcome[];
  summary: { ok: true; commentId: string } | { ok: false; error: string } | null;
}

/** Submits all draft comments of a page in document order, then the optional summary. */
export async function submitDrafts(
  client: ConfluenceClient,
  pageId: string,
  drafts: Note[],
  summary: AdfDoc | null,
  hooks: PublishHooks,
): Promise<SubmitResult> {
  const ordered = [...drafts].sort((a, b) => a.target.start - b.target.start);
  const outcomes: PublishOutcome[] = [];
  for (const n of ordered) outcomes.push(await publishNote(client, n, hooks));
  let summaryResult: SubmitResult['summary'] = null;
  if (summary && summary.content.length) {
    try {
      const c = await client.createFooterComment(pageId, summary);
      summaryResult = { ok: true, commentId: c.id };
    } catch (e) {
      summaryResult = { ok: false, error: (e as Error).message };
    }
  }
  return { outcomes, summary: summaryResult };
}
