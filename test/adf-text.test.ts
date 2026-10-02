import { readFileSync } from 'node:fs';
import { buildIndex, computeMatch, matchOffsets } from '../src/core/adf-text';
import type { AdfNode } from '../src/core/model';

const p = (localId: string, ...content: AdfNode[]): AdfNode => ({ type: 'paragraph', attrs: { localId }, content });
const t = (text: string, marks?: AdfNode['marks']): AdfNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });

describe('buildIndex', () => {
  it('joins text blocks without separators and drops inline atoms', () => {
    const idx = buildIndex(
      doc(
        { type: 'heading', attrs: { level: 1, localId: 'h1' }, content: [t('Overview')] },
        p('p1', t('Ping '), { type: 'mention', attrs: { id: 'x', text: '@Jane' } }, t(' about the '), {
          type: 'status',
          attrs: { text: 'BLOCKED' },
        }, t(' item')),
      ),
    );
    expect(idx.text).toBe('OverviewPing  about the  item');
    expect(idx.annotText).toBe(idx.text);
    expect(idx.blocks.map((b) => b.localId)).toEqual(['h1', 'p1']);
  });

  it('descends into lists and tables in document order', () => {
    const idx = buildIndex(
      doc(
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [p('l1', t('one'))] }, { type: 'listItem', content: [p('l2', t('two'))] }],
        },
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('c1', t('cell'))] }] }],
        },
      ),
    );
    expect(idx.text).toBe('onetwocell');
  });

  it('keeps code blocks out of the annotatable text and skips extensions', () => {
    const idx = buildIndex(
      doc(
        p('a', t('before')),
        { type: 'codeBlock', attrs: { localId: 'cb' }, content: [t('code text')] },
        { type: 'extension', attrs: { extensionKey: 'toc' } },
        p('b', t('after')),
      ),
    );
    expect(idx.text).toBe('beforecode textafter');
    expect(idx.annotText).toBe('beforeafter');
    expect(idx.blocks[1]).toMatchObject({ annotatable: false, annotStart: null });
    expect(idx.blocks[2]!.annotStart).toBe('before'.length);
  });

  it('computes ProseMirror positions like the renderer', () => {
    // <p>ab</p> occupies 0..4, <ul><li><p>c</p></li></ul> starts at 4.
    const idx = buildIndex(
      doc(p('a', t('ab')), { type: 'bulletList', content: [{ type: 'listItem', content: [p('b', t('c'))] }] }),
    );
    expect(idx.blocks.map((b) => b.pmPos)).toEqual([0, 6]);
  });
});

describe('computeMatch', () => {
  const idx = buildIndex(
    doc(
      p('a', t('We deploy every Tuesday.')),
      p('b', t('Rollback is manual. We deploy every Tuesday unless frozen.')),
      { type: 'codeBlock', content: [t('We deploy every Tuesday')] },
    ),
  );

  it('finds the occurrence index over annotatable text', () => {
    const start = idx.text.indexOf('We deploy', 10);
    const r = computeMatch(idx, start, start + 'We deploy every Tuesday'.length);
    expect(r).toEqual({ ok: true, textSelection: 'We deploy every Tuesday', matchCount: 2, matchIndex: 1 });
  });

  it('rejects selections in code blocks', () => {
    const start = idx.text.lastIndexOf('We deploy');
    const r = computeMatch(idx, start, start + 9);
    expect(r.ok).toBe(false);
  });

  it('allows selections spanning two paragraphs with no separator', () => {
    const start = idx.text.indexOf('Tuesday.');
    const end = idx.text.indexOf('Rollback') + 'Rollback'.length;
    const r = computeMatch(idx, start, end);
    expect(r).toMatchObject({ ok: true, textSelection: 'Tuesday.Rollback', matchCount: 1, matchIndex: 0 });
  });

  it('counts non-overlapping matches like String.match', () => {
    expect(matchOffsets('aaa', 'aa')).toEqual([0]);
    expect(matchOffsets('abab ab', 'ab')).toEqual([0, 2, 5]);
  });
});

describe('real page fixture', () => {
  const adf = JSON.parse(readFileSync(new URL('./fixtures/sandbox-page.adf.json', import.meta.url), 'utf8'));
  const idx = buildIndex(adf);

  it('indexes every text block with a localId', () => {
    expect(idx.blocks.length).toBeGreaterThan(200);
    expect(idx.blocks.filter((b) => b.localId).length / idx.blocks.length).toBeGreaterThan(0.95);
  });

  it('excludes the two code blocks from the annotatable text', () => {
    expect(idx.blocks.filter((b) => !b.annotatable)).toHaveLength(2);
    expect(idx.annotText.length).toBeLessThan(idx.text.length);
  });

  it('starts with the inline-card paragraph without the card text', () => {
    expect(idx.text.startsWith('This RFC is the revision of  . This RFC addresses')).toBe(true);
  });
});
