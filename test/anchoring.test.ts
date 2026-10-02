import { buildIndex } from '../src/core/adf-text';
import { anchor, describe as describeTarget } from '../src/core/anchoring';
import type { AdfNode } from '../src/core/model';

const p = (localId: string, text: string): AdfNode => ({
  type: 'paragraph',
  attrs: { localId },
  content: text ? [{ type: 'text', text }] : [],
});
const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });

const v1 = doc(
  p('intro', 'The scheduler ranks ShipmentRecord candidates by weight.'),
  p('cut', 'A short interruption during the rollout is expected. Plan for it.'),
  p('tail', 'Each ShipmentRecord is scored again after the rollout.'),
);
const idx1 = buildIndex(v1);

function targetFor(quote: string, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = idx1.text.indexOf(quote, start + 1);
  return describeTarget(idx1, start, start + quote.length, 1);
}

describe('anchor', () => {
  it('is anchored on the same version', () => {
    const t = targetFor('short interruption');
    expect(anchor(t, idx1, 1)).toMatchObject({ status: 'anchored', via: 'version' });
  });

  it('is anchored via the block when text was inserted in another block', () => {
    const t = targetFor('short interruption');
    const idx2 = buildIndex(doc(p('new', 'Inserted paragraph first.'), ...v1.content!));
    const r = anchor(t, idx2, 2);
    expect(r).toMatchObject({ status: 'moved', via: 'block', exact: 'short interruption' });
    expect(idx2.text.slice(r.start, r.end)).toBe('short interruption');
  });

  it('is changed when the quote was edited inside its block', () => {
    const t = targetFor('A short interruption during the rollout is expected.');
    const idx2 = buildIndex(
      doc(v1.content![0]!, p('cut', 'A brief interruption during the rollout is expected. Plan for it.'), v1.content![2]!),
    );
    const r = anchor(t, idx2, 2);
    expect(r.status).toBe('changed');
    expect(r.exact).toContain('brief interruption during the rollout');
  });

  it('keeps the right occurrence of a repeated term', () => {
    const t = targetFor('ShipmentRecord', 1);
    // The block was re-created (new localId) and moved to the top.
    const idx2 = buildIndex(
      doc(p('tail2', 'Each ShipmentRecord is scored again after the rollout.'), v1.content![0]!, v1.content![1]!),
    );
    const r = anchor(t, idx2, 2);
    expect(r.status).toBe('moved');
    expect(idx2.text.slice(r.start - 5, r.end)).toBe('Each ShipmentRecord');
  });

  it('uses the version diff when the block id changed', () => {
    const t = targetFor('scored again');
    const idx2 = buildIndex(doc(v1.content![0]!, v1.content![1]!, p('tail2', 'Each ShipmentRecord is scored again after the rollout.')));
    const r = anchor(t, idx2, 2, idx1);
    expect(r).toMatchObject({ status: 'moved', via: 'diff' });
  });

  it('is ambiguous when identical sentences cannot be told apart', () => {
    const same = 'Identical sentence in two table cells here.';
    const base = doc(p('a', same), p('b', same));
    const ib = buildIndex(base);
    const t = describeTarget(ib, 0, same.length, 1);
    // Both blocks re-created, context identical apart from position.
    const idx2 = buildIndex(doc(p('x', same), p('y', same)));
    const r = anchor({ ...t, prefix: '', suffix: '' }, idx2, 2);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
  });

  it('is orphaned when the text is gone', () => {
    const t = targetFor('A short interruption during the rollout is expected.');
    const idx2 = buildIndex(doc(p('intro', 'Completely different content now, nothing in common at all.')));
    expect(anchor(t, idx2, 2).status).toBe('orphaned');
  });

  it('never fuzzy-matches short quotes', () => {
    const idx0 = buildIndex(doc(p('a', 'the cat sat')));
    const t = describeTarget(idx0, 4, 7, 1);
    const idx2 = buildIndex(doc(p('b', 'the car sat')));
    expect(anchor(t, idx2, 2).status).toBe('orphaned');
  });
});
