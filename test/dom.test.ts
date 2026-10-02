// @vitest-environment happy-dom
// DomMapper against real rendered Confluence pages, saved with their ADF.
import { readFileSync } from 'node:fs';
import { buildIndex } from '../src/core/adf-text';
import { DomMapper, findCommentMark, findRoot } from '../src/confluence/dom';

function load(name: string) {
  const { adf, html } = JSON.parse(readFileSync(`test/fixtures/${name}`, "utf8"));
  // Drop embedded frames and images: happy-dom would try to load them.
  const clean = String(html).replace(/<iframe[\s\S]*?<\/iframe>/g, '').replace(/<img[^>]*>/g, '');
  document.body.innerHTML = `<div id="main-content">${clean}</div>`;
  const root = document.querySelector<HTMLElement>('.ak-renderer-document')!;
  const index = buildIndex(adf);
  return { index, mapper: new DomMapper(root, index) };
}

const FIXTURES = ['example-page.json', 'example-rfc.json'];

describe.each(FIXTURES)('DomMapper on %s', (name) => {
  it('maps (almost) every text block to its element', () => {
    const { mapper, index } = load(name);
    expect(index.blocks.length).toBeGreaterThan(5);
    expect(mapper.coverage).toBeGreaterThan(0.95);
  });

  it('round-trips words in every block through DOM ranges', () => {
    const { mapper, index } = load(name);
    let checked = 0;
    for (const b of index.blocks) {
      for (const m of b.text.matchAll(/\S{4,}/g)) {
        const start = b.start + m.index!;
        const end = start + m[0].length;
        const range = mapper.offsetsToRange(start, end);
        expect(range, `${m[0]} in "${b.text.slice(0, 40)}"`).not.toBeNull();
        expect(range!.toString()).toBe(m[0]);
        expect(mapper.rangeToOffsets(range!)).toEqual({ start, end });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('maps a selection spanning two blocks', () => {
    const { mapper, index } = load(name);
    const [a, b] = index.blocks.filter((x) => x.text.length > 10).slice(1, 3);
    const range = mapper.offsetsToRange(a!.end - 5, b!.start + 5)!;
    expect(mapper.rangeToOffsets(range)).toEqual({ start: a!.end - 5, end: b!.start + 5 });
  });
});

describe('findRoot', () => {
  // Layout seen on the live site with an inline comment open and a footer comment below.
  const renderer = (text: string) => `<div class="ak-renderer-document"><p data-renderer-start-pos="1">${text}</p></div>`;
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="main-content">
        <div data-testid="pageContentRendererTestId">
          <div data-testid="renderer-comments-sidebar"><div data-testid="inline-comment-sidebar-wrapper">
            <div data-testid="inline-comment-container">${renderer('comment body')}</div>
          </div></div>
          ${renderer('page <mark data-mark-type="annotation" data-id="ref-1">body</mark>')}
        </div>
      </div>
      <div data-testid="object-comment-wrapper">${renderer('footer comment')}</div>`;
  });

  it('skips comment renderers that come before the page body', () => {
    expect(findRoot()?.textContent).toBe('page body');
  });

  it('finds the highlight of a published comment by its marker ref', () => {
    expect(findCommentMark(findRoot()!, 'ref-1')?.textContent).toBe('body');
    expect(findCommentMark(findRoot()!, 'ref-2')).toBeNull();
  });
});
