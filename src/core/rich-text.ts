// Note bodies are stored as a small ADF subset, so publishing needs no
// conversion: paragraphs, hard breaks, bullet/ordered lists, and the marks
// strong, em, code and link. The editor is a contenteditable; this module
// turns its DOM into ADF (dropping anything else) and ADF back into HTML.

import type { AdfDoc, AdfNode } from './model';

type Mark = NonNullable<AdfNode['marks']>[number];

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

function safeHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://invalid.example');
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** Splits bare URLs in unlinked text into link-marked text nodes. */
function autolink(text: string, marks: Mark[]): AdfNode[] {
  if (marks.some((m) => m.type === 'link' || m.type === 'code')) return [textNode(text, marks)];
  const out: AdfNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(textNode(text.slice(last, i), marks));
    out.push(textNode(m[0], [...marks, { type: 'link', attrs: { href: m[0] } }]));
    last = i + m[0].length;
  }
  if (last < text.length) out.push(textNode(text.slice(last), marks));
  return out;
}

function textNode(text: string, marks: Mark[]): AdfNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
}

/** Merges adjacent text nodes with equal marks and trims trailing hard breaks. */
function normalizeInline(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && !n.text) continue;
    if (prev && prev.type === 'text' && n.type === 'text' && sameMarks(prev.marks, n.marks)) {
      prev.text = (prev.text ?? '') + n.text;
    } else out.push(n);
  }
  while (out.length && out[out.length - 1]!.type === 'hardBreak') out.pop();
  while (out.length && out[0]!.type === 'hardBreak') out.shift();
  return out;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);

export function domToAdf(root: Node): AdfDoc {
  const blocks: AdfNode[] = [];
  let inline: AdfNode[] = [];

  const flush = (into: AdfNode[]) => {
    const content = normalizeInline(inline);
    inline = [];
    if (content.length) into.push({ type: 'paragraph', content });
  };

  const walkInline = (node: Node, marks: Mark[], into: AdfNode[]) => {
    if (node.nodeType === 3) {
      inline.push(...autolink((node.textContent ?? '').replace(/ /g, ' '), marks));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === 'BR') {
      inline.push({ type: 'hardBreak' });
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      flush(into);
      const items: AdfNode[] = [];
      for (const li of Array.from(el.children)) {
        if (li.tagName !== 'LI') continue;
        const itemBlocks: AdfNode[] = [];
        for (const c of Array.from(li.childNodes)) walkInline(c, marks, itemBlocks);
        flush(itemBlocks);
        if (itemBlocks.length) items.push({ type: 'listItem', content: itemBlocks });
      }
      if (items.length) into.push({ type: tag === 'UL' ? 'bulletList' : 'orderedList', content: items });
      return;
    }
    let next = marks;
    if (tag === 'B' || tag === 'STRONG') next = addMark(marks, { type: 'strong' });
    else if (tag === 'I' || tag === 'EM') next = addMark(marks, { type: 'em' });
    else if (tag === 'CODE') next = addMark(marks, { type: 'code' });
    else if (tag === 'A') {
      const href = safeHref(el.getAttribute('href'));
      if (href) next = addMark(marks, { type: 'link', attrs: { href } });
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush(into);
    for (const c of Array.from(el.childNodes)) walkInline(c, next, into);
    if (isBlock) flush(into);
  };

  for (const c of Array.from(root.childNodes)) walkInline(c, [], blocks);
  flush(blocks);
  return { type: 'doc', version: 1, content: blocks };
}

function addMark(marks: Mark[], mark: Mark): Mark[] {
  if (marks.some((m) => m.type === mark.type)) return marks;
  // Inline code can't combine with other marks in ADF except link.
  if (mark.type === 'code') return [...marks.filter((m) => m.type === 'link'), mark];
  if (marks.some((m) => m.type === 'code') && mark.type !== 'link') return marks;
  return [...marks, mark];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineToHtml(n: AdfNode): string {
  if (n.type === 'hardBreak') return '<br>';
  if (n.type !== 'text') return '';
  let html = escapeHtml(n.text ?? '');
  for (const m of n.marks ?? []) {
    if (m.type === 'strong') html = `<strong>${html}</strong>`;
    else if (m.type === 'em') html = `<em>${html}</em>`;
    else if (m.type === 'code') html = `<code>${html}</code>`;
    else if (m.type === 'link') {
      const href = safeHref(String(m.attrs?.href ?? ''));
      if (href) html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
    }
  }
  return html;
}

function blockToHtml(n: AdfNode): string {
  const inner = (n.content ?? []).map((c) => (c.type === 'text' || c.type === 'hardBreak' ? inlineToHtml(c) : blockToHtml(c))).join('');
  switch (n.type) {
    case 'paragraph':
      return `<p>${inner}</p>`;
    case 'bulletList':
      return `<ul>${inner}</ul>`;
    case 'orderedList':
      return `<ol>${inner}</ol>`;
    case 'listItem':
      return `<li>${inner}</li>`;
    default:
      return inner;
  }
}

/** HTML for display and for loading into the editor. Output is escaped and link-sanitized. */
export function adfToHtml(doc: AdfDoc): string {
  return doc.content.map(blockToHtml).join('');
}

/** Same output as adfToHtml, built as DOM nodes (no innerHTML). */
export function adfToFragment(doc: AdfDoc, d: Document): DocumentFragment {
  const frag = d.createDocumentFragment();
  const inline = (n: AdfNode): Node | null => {
    if (n.type === 'hardBreak') return d.createElement('br');
    if (n.type !== 'text') return null;
    let node: Node = d.createTextNode(n.text ?? '');
    for (const m of n.marks ?? []) {
      let wrap: HTMLElement | null = null;
      if (m.type === 'strong') wrap = d.createElement('strong');
      else if (m.type === 'em') wrap = d.createElement('em');
      else if (m.type === 'code') wrap = d.createElement('code');
      else if (m.type === 'link') {
        const href = safeHref(String(m.attrs?.href ?? ''));
        if (href) {
          const a = d.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          wrap = a;
        }
      }
      if (wrap) {
        wrap.append(node);
        node = wrap;
      }
    }
    return node;
  };
  const TAGS: Record<string, string> = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li' };
  const block = (n: AdfNode, into: Node) => {
    const tag = TAGS[n.type];
    const el = tag ? d.createElement(tag) : into;
    for (const c of n.content ?? []) {
      if (c.type === 'text' || c.type === 'hardBreak') {
        const x = inline(c);
        if (x) el.appendChild(x);
      } else block(c, el);
    }
    if (tag) into.appendChild(el);
  };
  for (const n of doc.content) block(n, frag);
  return frag;
}

export function adfToPlain(doc: AdfNode): string {
  const parts: string[] = [];
  const walk = (n: AdfNode) => {
    if (n.type === 'text') parts.push(n.text ?? '');
    else if (n.type === 'hardBreak') parts.push('\n');
    for (const c of n.content ?? []) walk(c);
    if (n.type === 'paragraph') parts.push('\n');
  };
  walk(doc);
  return parts.join('').trim();
}

export function isEmptyDoc(doc: AdfDoc): boolean {
  return adfToPlain(doc).trim() === '';
}

/** Body for the review summary footer comment, from plain text. */
export function plainToAdf(text: string): AdfDoc {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const content: AdfNode[] = [];
      p.split('\n').forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        content.push(...autolink(line, []));
      });
      return { type: 'paragraph', content: normalizeInline(content) };
    });
  return { type: 'doc', version: 1, content: paras };
}
