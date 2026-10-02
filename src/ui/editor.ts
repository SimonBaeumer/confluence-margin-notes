// A small contenteditable editor with bold, italic, inline code, links and
// lists. Its DOM is converted to ADF on read, so whatever the browser puts in
// there is sanitized by domToAdf.

import type { AdfDoc } from '../core/model';
import { adfToFragment, domToAdf, isEmptyDoc } from '../core/rich-text';

export interface Editor {
  el: HTMLElement;
  getDoc(): AdfDoc;
  isEmpty(): boolean;
  focus(): void;
  onSubmit(cb: () => void): void;
  onChange(cb: () => void): void;
}

export const EDITOR_CSS = `
.mn-editor { border: 1px solid var(--mn-border); border-radius: 6px; background: var(--mn-input-bg); }
.mn-toolbar { display: flex; gap: 2px; padding: 3px; border-bottom: 1px solid var(--mn-border); }
.mn-toolbar button { all: unset; cursor: pointer; min-width: 24px; height: 22px; padding: 0 4px; border-radius: 4px;
  text-align: center; font: 600 12px/22px system-ui, sans-serif; color: var(--mn-fg); }
.mn-toolbar button:hover { background: var(--mn-hover); }
.mn-toolbar .mn-sep { width: 1px; background: var(--mn-border); margin: 2px 3px; }
.mn-input { min-height: 64px; max-height: 260px; overflow: auto; padding: 6px 8px; outline: none;
  font: 14px/1.45 system-ui, sans-serif; color: var(--mn-fg); white-space: pre-wrap; word-break: break-word; }
.mn-input:empty::before { content: attr(data-placeholder); color: var(--mn-muted); }
.mn-input p { margin: 0 0 6px; }
.mn-input ul, .mn-input ol { margin: 0 0 6px; padding-left: 20px; }
.mn-input code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--mn-code-bg); padding: 0 3px; border-radius: 3px; }
.mn-input a { color: var(--mn-link); }
`;

function wrapSelectionInCode(doc: Document): void {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const code = doc.createElement('code');
  code.textContent = range.toString();
  range.deleteContents();
  range.insertNode(code);
  sel.removeAllRanges();
  const after = doc.createRange();
  after.setStartAfter(code);
  sel.addRange(after);
}

export function createEditor(doc: Document, initial: AdfDoc | null, placeholder = 'Write a note…'): Editor {
  const el = doc.createElement('div');
  el.className = 'mn-editor';
  const toolbar = doc.createElement('div');
  toolbar.className = 'mn-toolbar';
  const input = doc.createElement('div');
  input.className = 'mn-input';
  input.contentEditable = 'true';
  input.spellcheck = true;
  input.dataset.placeholder = placeholder;
  input.setAttribute('role', 'textbox');
  input.setAttribute('aria-multiline', 'true');
  if (initial) input.append(adfToFragment(initial, doc));

  let submit: (() => void) | null = null;
  let change: (() => void) | null = null;

  const exec = (cmd: string, value?: string) => {
    input.focus();
    doc.execCommand(cmd, false, value);
    change?.();
  };
  const link = () => {
    const url = prompt('Link URL', 'https://');
    if (url && /^(https?:|mailto:)/.test(url)) exec('createLink', url);
  };
  const buttons: [string, string, () => void][] = [
    ['B', 'Bold (Ctrl+B)', () => exec('bold')],
    ['I', 'Italic (Ctrl+I)', () => exec('italic')],
    ['</>', 'Inline code (Ctrl+E)', () => (wrapSelectionInCode(doc), change?.())],
    ['🔗', 'Link (Ctrl+K)', link],
    ['|', '', () => {}],
    ['•', 'Bulleted list', () => exec('insertUnorderedList')],
    ['1.', 'Numbered list', () => exec('insertOrderedList')],
  ];
  for (const [label, title, fn] of buttons) {
    if (label === '|') {
      const sep = doc.createElement('span');
      sep.className = 'mn-sep';
      toolbar.append(sep);
      continue;
    }
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (label === 'I') b.style.fontStyle = 'italic';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', fn);
    toolbar.append(b);
  }

  input.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      submit?.();
    } else if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      wrapSelectionInCode(doc);
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      link();
    }
    // Keep Confluence's global shortcuts (e.g. "e" to edit, "?" for help) away from our input.
    e.stopPropagation();
  });
  for (const t of ['keyup', 'keypress', 'input']) input.addEventListener(t, (e) => e.stopPropagation());
  input.addEventListener('input', () => change?.());
  // Paste as plain text: rich paste from other pages would bring in lots of markup.
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    e.preventDefault();
    doc.execCommand('insertText', false, text);
  });

  el.append(toolbar, input);
  return {
    el,
    getDoc: () => domToAdf(input),
    isEmpty: () => isEmptyDoc(domToAdf(input)),
    focus: () => {
      input.focus();
      const sel = doc.getSelection();
      if (sel) {
        const r = doc.createRange();
        r.selectNodeContents(input);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    },
    onSubmit: (cb) => (submit = cb),
    onChange: (cb) => (change = cb),
  };
}
