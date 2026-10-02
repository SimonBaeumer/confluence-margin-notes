// @vitest-environment happy-dom
import { adfToFragment, adfToHtml, adfToPlain, domToAdf, plainToAdf } from '../src/core/rich-text';

function fromHtml(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return domToAdf(div);
}

describe('domToAdf', () => {
  it('converts paragraphs, breaks and marks', () => {
    const doc = fromHtml('<div>Hello <b>bold</b> and <i>it</i></div><div>line<br>two</div>');
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'bold', marks: [{ type: 'strong' }] }, { type: 'text', text: ' and ' }, { type: 'text', text: 'it', marks: [{ type: 'em' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'line' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
    ]);
  });

  it('treats top-level text and br like Firefox contenteditable output', () => {
    const doc = fromHtml('first<br>second');
    expect(doc.content).toHaveLength(1);
    expect(adfToPlain(doc)).toBe('first\nsecond');
  });

  it('keeps safe links, drops javascript: links and auto-links bare URLs', () => {
    const doc = fromHtml('<a href="https://x.test/a">ok</a> <a href="javascript:alert(1)">bad</a> see https://gitlab.com/foo/bar.');
    const marks = doc.content[0]!.content!.map((n) => n.marks?.[0]?.attrs?.href ?? null);
    expect(marks).toContain('https://x.test/a');
    expect(marks).toContain('https://gitlab.com/foo/bar');
    expect(JSON.stringify(doc)).not.toContain('javascript');
  });

  it('converts lists', () => {
    const doc = fromHtml('<ul><li>a</li><li>b</li></ul>');
    expect(doc.content[0]).toMatchObject({ type: 'bulletList', content: [{ type: 'listItem' }, { type: 'listItem' }] });
  });

  it('drops unknown markup but keeps its text', () => {
    const doc = fromHtml('<span style="color:red">x<script>evil()</script></span><img src=x onerror=alert(1)>');
    expect(adfToPlain(doc)).toBe('xevil()');
    expect(JSON.stringify(doc)).not.toContain('onerror');
  });
});

describe('adfToHtml / adfToFragment', () => {
  it('escapes text and round-trips', () => {
    const doc = fromHtml('<p>a &lt;b&gt; <code>x</code> <a href="https://x.test">l</a></p>');
    const html = adfToHtml(doc);
    expect(html).toContain('&lt;b&gt;');
    const div = document.createElement('div');
    div.append(adfToFragment(doc, document));
    expect(div.innerHTML).toBe(html);
    expect(domToAdf(div)).toEqual(doc);
  });
});

describe('plainToAdf', () => {
  it('splits paragraphs on blank lines', () => {
    const doc = plainToAdf('Overall good.\nTwo nits.\n\nApprove after fixes.');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]!.content![1]).toEqual({ type: 'hardBreak' });
  });
});
