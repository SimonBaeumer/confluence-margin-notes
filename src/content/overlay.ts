// In-page UI, rendered into a closed shadow root attached outside Confluence's
// React tree: the "Add note" button, the note popover, the draft comments
// banner and the submit dialog.

import type { Note, NoteState } from '../core/model';
import { adfToFragment } from '../core/rich-text';
import { createEditor, EDITOR_CSS, type Editor } from '../ui/editor';

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.mn {
  --mn-bg: #ffffff; --mn-fg: #172b4d; --mn-muted: #626f86; --mn-border: #dcdfe4; --mn-hover: #f1f2f4;
  --mn-input-bg: #fff; --mn-code-bg: #f1f2f4; --mn-link: #0c66e4; --mn-primary: #0c66e4; --mn-primary-fg: #fff;
  --mn-private: #f5cd47; --mn-draft: #579dff; --mn-danger: #c9372c; --mn-ok: #22a06b; --mn-warn: #e56910;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--mn-fg);
}
@media (prefers-color-scheme: dark) {
  .mn { --mn-bg: #22272b; --mn-fg: #dee4ea; --mn-muted: #9fadbc; --mn-border: #3b444c; --mn-hover: #2c333a;
    --mn-input-bg: #1d2125; --mn-code-bg: #2c333a; --mn-link: #579dff; --mn-primary: #579dff; --mn-primary-fg: #1d2125; }
}
.card { position: fixed; z-index: 2147483000; background: var(--mn-bg); border: 1px solid var(--mn-border);
  border-radius: 10px; box-shadow: 0 8px 28px rgb(0 0 0 / 0.22); }
.add-btn { position: fixed; z-index: 2147483000; all: unset; }
.add-btn button { cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 16px;
  background: var(--mn-bg); color: var(--mn-fg); border: 1px solid var(--mn-border); box-shadow: 0 3px 10px rgb(0 0 0 / 0.18);
  font: 600 13px system-ui, sans-serif; }
.add-btn button:hover { background: var(--mn-hover); }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
.dot.private { background: var(--mn-private); } .dot.draft { background: var(--mn-draft); } .dot.published { background: var(--mn-ok); }
.popover { width: 380px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.quote { font-size: 12.5px; color: var(--mn-muted); border-left: 3px solid var(--mn-border); padding: 2px 0 2px 8px;
  max-height: 3.9em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.hint { font-size: 12px; color: var(--mn-muted); }
.hint.warn { color: var(--mn-warn); } .hint.err { color: var(--mn-danger); }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.row.end { justify-content: flex-end; }
.spacer { flex: 1; }
button.b { cursor: pointer; border: 1px solid var(--mn-border); background: var(--mn-bg); color: var(--mn-fg);
  padding: 5px 10px; border-radius: 6px; font: 500 13px system-ui, sans-serif; display: inline-flex; gap: 6px; align-items: center; }
button.b:hover:not(:disabled) { background: var(--mn-hover); }
button.b.primary { background: var(--mn-primary); color: var(--mn-primary-fg); border-color: var(--mn-primary); }
button.b.danger { color: var(--mn-danger); }
button.b:disabled { opacity: 0.45; cursor: not-allowed; }
.head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.state { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--mn-muted); }
.body { font-size: 14px; } .body p { margin: 0 0 6px; } .body code { font: 12.5px ui-monospace, Menlo, monospace; background: var(--mn-code-bg); padding: 0 3px; border-radius: 3px; }
.body a { color: var(--mn-link); }
.banner { right: 20px; bottom: 20px; padding: 8px 10px 8px 14px; display: flex; align-items: center; gap: 10px; border-radius: 22px; }
.banner strong { font-weight: 600; }
.backdrop { position: fixed; inset: 0; z-index: 2147483001; background: rgb(9 30 66 / 0.45); display: flex; align-items: center; justify-content: center; }
.dialog { position: relative; width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column; }
.dialog h2 { margin: 0; font-size: 17px; padding: 16px 18px 6px; }
.dialog .content { overflow: auto; padding: 6px 18px; display: flex; flex-direction: column; gap: 8px; }
.dialog .foot { padding: 12px 18px 16px; }
.item { border: 1px solid var(--mn-border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.item .top { display: flex; gap: 8px; align-items: center; }
.item .q { font-size: 12.5px; color: var(--mn-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--mn-border); white-space: nowrap; }
.chip.ok { color: var(--mn-ok); border-color: var(--mn-ok); } .chip.warn { color: var(--mn-warn); border-color: var(--mn-warn); }
.chip.err { color: var(--mn-danger); border-color: var(--mn-danger); }
.item .b-preview { font-size: 13px; max-height: 3.2em; overflow: hidden; }
.item .b-preview p { margin: 0; }
textarea { width: 100%; min-height: 70px; resize: vertical; border: 1px solid var(--mn-border); border-radius: 6px; padding: 6px 8px;
  background: var(--mn-input-bg); color: var(--mn-fg); font: 14px/1.4 system-ui, sans-serif; }
label.lbl { font-size: 12.5px; font-weight: 600; }
.status-line { font-size: 12px; }
${EDITOR_CSS}
`;

export type CreateAction = 'private' | 'draft' | 'publish';

export interface PopoverCreate {
  mode: 'create';
  quote: string;
  publishable: boolean;
  unpublishableReason: string | null;
  anchorRect: DOMRect;
  onSave(action: CreateAction, body: ReturnType<Editor['getDoc']>): void;
}

export interface PopoverEdit {
  mode: 'edit';
  note: Note;
  anchorRect: DOMRect;
  statusText: string | null;
  onSave(body: ReturnType<Editor['getDoc']>): void;
  onState(state: Exclude<NoteState, 'published'>): void;
  onPublish(): void;
  onDelete(): void;
}

export interface DialogItem {
  note: Note;
  status: string;
  tone: 'ok' | 'warn' | 'err';
  blockedReason: string | null;
}

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style' || k === 'role' || k.includes('-')) el.setAttribute(k, String(v));
    else (el as any)[k] = v;
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export class Overlay {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly wrap: HTMLElement;
  private addBtn: HTMLElement | null = null;
  private popover: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;

  constructor(private readonly doc: Document) {
    this.host = doc.createElement('margin-notes-ui');
    this.host.style.cssText = 'position: static; display: contents;';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS_TEXT;
    this.wrap = h(doc, 'div', { class: 'mn' });
    this.shadow.append(style, this.wrap);
    doc.documentElement.append(this.host);
    // Keep clicks inside our UI from reaching the page (and from clearing our state).
    for (const t of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'keypress']) {
      this.host.addEventListener(t, (e) => e.stopPropagation());
    }
  }

  /** Whether an event target belongs to our UI. */
  owns(target: EventTarget | null): boolean {
    return target === this.host;
  }

  get popoverOpen(): boolean {
    return !!this.popover;
  }

  get dialogOpen(): boolean {
    return !!this.dialog;
  }

  showAddButton(rect: DOMRect, onClick: () => void): void {
    this.hideAddButton();
    const top = Math.min(window.innerHeight - 40, rect.bottom + 8);
    const left = Math.min(window.innerWidth - 130, Math.max(8, rect.right - 60));
    const btn = h(
      this.doc,
      'button',
      { title: 'Add a private note or draft comment (Alt+Shift+M)', onclick: onClick },
      h(this.doc, 'span', { class: 'dot private' }),
      'Add note',
    );
    this.addBtn = h(this.doc, 'div', { class: 'add-btn', style: `position: fixed; top: ${top}px; left: ${left}px; z-index: 2147483000;` }, btn);
    this.wrap.append(this.addBtn);
  }

  hideAddButton(): void {
    this.addBtn?.remove();
    this.addBtn = null;
  }

  private place(el: HTMLElement, rect: DOMRect): void {
    const width = 380;
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left));
    el.style.left = `${left}px`;
    el.style.visibility = 'hidden';
    this.wrap.append(el);
    const height = el.getBoundingClientRect().height;
    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 10);
    el.style.top = `${top}px`;
    el.style.visibility = '';
  }

  showCreate(p: PopoverCreate): void {
    this.closePopover();
    this.hideAddButton();
    const editor = createEditor(this.doc, null);
    const d = this.doc;
    const publishTitle = p.publishable ? '' : (p.unpublishableReason ?? 'Cannot be published');
    const pop = h(
      d,
      'div',
      { class: 'card popover', role: 'dialog', 'aria-label': 'New note' },
      h(d, 'div', { class: 'quote' }, truncate(p.quote, 240)),
      editor.el,
      !p.publishable ? h(d, 'div', { class: 'hint warn' }, `Private only: ${p.unpublishableReason}`) : null,
      h(
        d,
        'div',
        { class: 'row' },
        h(d, 'button', { class: 'b', onclick: () => this.closePopover() }, 'Cancel'),
        h(d, 'span', { class: 'spacer' }),
        h(d, 'button', { class: 'b', title: 'Only for you, never published', onclick: () => save('private') }, h(d, 'span', { class: 'dot private' }), 'Keep private'),
        h(
          d,
          'button',
          { class: 'b primary', disabled: !p.publishable, title: publishTitle || 'Collect it with your other draft comments and submit them together', onclick: () => save('draft') },
          'Add draft comment',
        ),
      ),
      h(
        d,
        'div',
        { class: 'row end' },
        h(d, 'button', { class: 'b', disabled: !p.publishable, title: publishTitle || 'Post it as an inline comment right away', onclick: () => save('publish') }, 'Publish now'),
      ),
      h(d, 'div', { class: 'hint' }, 'Ctrl+Enter keeps it private. Nothing is published until you choose to.'),
    );
    const save = (action: CreateAction) => {
      if (editor.isEmpty()) {
        editor.focus();
        return;
      }
      p.onSave(action, editor.getDoc());
      this.closePopover();
    };
    editor.onSubmit(() => save('private'));
    pop.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.closePopover();
    });
    this.place(pop, p.anchorRect);
    this.popover = pop;
    editor.focus();
  }

  showEdit(p: PopoverEdit): void {
    this.closePopover();
    this.hideAddButton();
    const d = this.doc;
    const n = p.note;
    const editable = n.state !== 'published';
    const editor = editable ? createEditor(d, n.body) : null;
    const stateLabel = n.state === 'private' ? 'Private note' : n.state === 'draft' ? 'Draft comment' : 'Published comment';
    const pop = h(
      d,
      'div',
      { class: 'card popover', role: 'dialog', 'aria-label': stateLabel },
      h(d, 'div', { class: 'head' }, h(d, 'span', { class: `dot ${n.state}` }), stateLabel, h(d, 'span', { class: 'spacer' }), h(d, 'span', { class: 'state' }, n.anchorStatus)),
      h(d, 'div', { class: 'quote' }, truncate(n.target.exact, 240)),
      p.statusText ? h(d, 'div', { class: 'hint warn' }, p.statusText) : null,
      n.lastError ? h(d, 'div', { class: 'hint err' }, n.lastError) : null,
      editor ? editor.el : h(d, 'div', { class: 'body' }, adfToFragment(n.body, d)),
      editable
        ? h(
            d,
            'div',
            { class: 'row' },
            h(d, 'button', { class: 'b danger', onclick: () => (confirm('Delete this note?') ? (p.onDelete(), this.closePopover()) : null) }, 'Delete'),
            h(d, 'span', { class: 'spacer' }),
            n.state === 'private'
              ? h(d, 'button', { class: 'b', disabled: !n.publishable, title: n.unpublishableReason ?? '', onclick: () => (saveBody(), p.onState('draft'), this.closePopover()) }, 'Make draft comment')
              : h(d, 'button', { class: 'b', onclick: () => (saveBody(), p.onState('private'), this.closePopover()) }, 'Make private'),
            h(d, 'button', { class: 'b', disabled: !n.publishable, title: n.unpublishableReason ?? '', onclick: () => (saveBody(), p.onPublish(), this.closePopover()) }, 'Publish now'),
            h(d, 'button', { class: 'b primary', onclick: () => (saveBody(), this.closePopover()) }, 'Save'),
          )
        : h(
            d,
            'div',
            { class: 'row end' },
            n.published?.webUrl ? h(d, 'a', { class: 'b', href: n.published.webUrl, target: '_blank' }, 'Open comment') : null,
            h(d, 'button', { class: 'b', onclick: () => this.closePopover() }, 'Close'),
          ),
    );
    const saveBody = () => {
      if (editor && !editor.isEmpty()) p.onSave(editor.getDoc());
    };
    editor?.onSubmit(() => (saveBody(), this.closePopover()));
    pop.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.closePopover();
    });
    this.place(pop, p.anchorRect);
    this.popover = pop;
  }

  closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  showBanner(pending: number, onSubmit: () => void, onDiscard: () => void): void {
    this.banner?.remove();
    this.banner = null;
    if (pending <= 0) return;
    const d = this.doc;
    this.banner = h(
      d,
      'div',
      { class: 'card banner', role: 'status' },
      h(d, 'span', { class: 'dot draft' }),
      h(d, 'span', {}, 'Draft comments: ', h(d, 'strong', {}, String(pending)), ' pending'),
      h(d, 'button', { class: 'b', title: 'Turn all draft comments back into private notes', onclick: onDiscard }, 'Discard'),
      h(d, 'button', { class: 'b primary', onclick: onSubmit }, `Submit ${pending}`),
    );
    this.wrap.append(this.banner);
  }

  closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  /**
   * The submit dialog. Returns a controller the publish run uses to report
   * progress and to ask for confirmations.
   */
  showSubmitDialog(opts: {
    title: string;
    items: DialogItem[];
    summary: string | null;
    onSummaryChange?(s: string): void;
    onSubmit(): void;
  }): SubmitDialog {
    this.closeDialog();
    const d = this.doc;
    const rows = new Map<string, { status: HTMLElement; line: HTMLElement; root: HTMLElement }>();
    const content = h(d, 'div', { class: 'content' });
    for (const it of opts.items) {
      const status = h(d, 'span', { class: `chip ${it.tone}` }, it.status);
      const line = h(d, 'div', { class: `status-line hint ${it.blockedReason ? 'err' : ''}` }, it.blockedReason ?? '');
      const root = h(
        d,
        'div',
        { class: 'item' },
        h(d, 'div', { class: 'top' }, h(d, 'span', { class: 'q' }, `“${truncate(it.note.target.exact, 120)}”`), status),
        h(d, 'div', { class: 'b-preview body' }, adfToFragment(it.note.body, d)),
        line,
      );
      rows.set(it.note.id, { status, line, root });
      content.append(root);
    }
    let summaryEl: HTMLTextAreaElement | null = null;
    if (opts.summary !== null) {
      summaryEl = h(d, 'textarea', {
        placeholder: 'Optional. Posted as a page comment after the inline comments.',
        value: opts.summary,
        oninput: () => opts.onSummaryChange?.(summaryEl!.value),
      });
      for (const t of ['keydown', 'keyup', 'keypress']) summaryEl.addEventListener(t, (e) => e.stopPropagation());
      content.append(h(d, 'label', { class: 'lbl' }, 'Summary comment'), summaryEl);
    }
    const submitBtn = h(d, 'button', { class: 'b primary', onclick: () => opts.onSubmit() }, opts.items.length > 1 ? `Submit ${opts.items.length} comments` : 'Publish');
    if (opts.items.every((i) => i.blockedReason) && !(opts.summary !== null)) submitBtn.disabled = true;
    const closeBtn = h(d, 'button', { class: 'b', onclick: () => this.closeDialog() }, 'Cancel');
    const foot = h(d, 'div', { class: 'row end foot' }, h(d, 'span', { class: 'hint spacer' }, 'Each comment is checked against the latest page right before it is posted.'), closeBtn, submitBtn);
    const dialog = h(d, 'div', { class: 'card dialog', role: 'dialog', 'aria-modal': 'true' }, h(d, 'h2', {}, opts.title), content, foot);
    const backdrop = h(d, 'div', { class: 'backdrop' }, dialog);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && !running) this.closeDialog();
    });
    backdrop.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape' && !running) this.closeDialog();
    });
    let running = false;
    this.wrap.append(backdrop);
    this.dialog = backdrop;

    return {
      summary: () => summaryEl?.value ?? '',
      running: () => {
        running = true;
        submitBtn.disabled = true;
        closeBtn.disabled = true;
        if (summaryEl) summaryEl.disabled = true;
      },
      done: (text: string) => {
        running = false;
        closeBtn.disabled = false;
        closeBtn.textContent = 'Close';
        submitBtn.remove();
        foot.querySelector('.hint')!.textContent = text;
      },
      setStatus: (noteId, label, tone, detail) => {
        const r = rows.get(noteId);
        if (!r) return;
        r.status.className = `chip ${tone}`;
        r.status.textContent = label;
        r.line.className = `status-line hint ${tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : ''}`;
        r.line.textContent = detail ?? '';
      },
      addRetry: (noteId, onRetry) => {
        const r = rows.get(noteId);
        if (!r) return;
        r.line.append(' ', h(d, 'button', { class: 'b', onclick: onRetry }, 'Retry'));
      },
      confirm: (noteId, was, now) =>
        new Promise<boolean>((resolve) => {
          const r = rows.get(noteId);
          if (!r) return resolve(false);
          const box = h(
            d,
            'div',
            { class: 'row' },
            h(d, 'span', { class: 'hint warn', style: 'flex: 1' }, `The text changed. Was: “${truncate(was, 80)}”. Now: “${truncate(now, 80)}”. Publish on the new text?`),
            h(d, 'button', { class: 'b', onclick: () => (box.remove(), resolve(false)) }, 'Skip'),
            h(d, 'button', { class: 'b primary', onclick: () => (box.remove(), resolve(true)) }, 'Publish here'),
          );
          r.root.append(box);
          box.scrollIntoView({ block: 'nearest' });
        }),
    };
  }

  destroy(): void {
    this.host.remove();
  }
}

export interface SubmitDialog {
  summary(): string;
  running(): void;
  done(text: string): void;
  setStatus(noteId: string, label: string, tone: 'ok' | 'warn' | 'err', detail?: string): void;
  addRetry(noteId: string, onRetry: () => void): void;
  confirm(noteId: string, was: string, now: string): Promise<boolean>;
}
