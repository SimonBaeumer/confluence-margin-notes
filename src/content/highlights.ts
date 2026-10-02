// Highlights through the CSS Custom Highlight API: no DOM mutation, so
// Confluence's React tree is never touched and re-renders can't break it.

const NAMES = {
  private: 'margin-notes-private',
  draft: 'margin-notes-draft',
  published: 'margin-notes-published',
  attention: 'margin-notes-attention',
  focus: 'margin-notes-focus',
} as const;

export type HighlightKind = keyof typeof NAMES;

const STYLE = `
::highlight(${NAMES.private}) { background-color: rgb(255 214 0 / 0.38); }
::highlight(${NAMES.draft}) { background-color: rgb(40 120 255 / 0.22); text-decoration: underline 2px rgb(40 120 255 / 0.85); text-underline-offset: 3px; }
::highlight(${NAMES.published}) { text-decoration: underline 2px rgb(34 160 107 / 0.85); text-underline-offset: 3px; }
::highlight(${NAMES.attention}) { background-color: rgb(255 120 0 / 0.25); text-decoration: underline wavy rgb(220 90 0); }
::highlight(${NAMES.focus}) { background-color: rgb(255 140 0 / 0.55); }
`;

export interface Painted {
  noteId: string;
  kind: HighlightKind;
  ranges: Range[];
}

export class Highlighter {
  private painted: Painted[] = [];
  private focusTimer: number | undefined;

  constructor(private readonly doc: Document) {
    if (!doc.getElementById('margin-notes-highlight-style')) {
      const style = doc.createElement('style');
      style.id = 'margin-notes-highlight-style';
      style.textContent = STYLE;
      doc.head.append(style);
    }
  }

  static supported(): boolean {
    return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
  }

  paint(items: Painted[]): void {
    this.painted = items;
    const groups: Record<HighlightKind, Range[]> = { private: [], draft: [], published: [], attention: [], focus: [] };
    for (const p of items) groups[p.kind].push(...p.ranges);
    for (const kind of ['published', 'private', 'draft', 'attention'] as const) {
      const h = new Highlight();
      // Highlight.add is not chainable in Firefox.
      for (const r of groups[kind]) h.add(r);
      h.priority = kind === 'attention' ? 2 : kind === 'draft' ? 1 : 0;
      CSS.highlights.set(NAMES[kind], h);
    }
  }

  flash(noteId: string): void {
    const p = this.painted.find((x) => x.noteId === noteId);
    if (!p) return;
    const h = new Highlight();
    for (const r of p.ranges) h.add(r);
    h.priority = 5;
    CSS.highlights.set(NAMES.focus, h);
    clearTimeout(this.focusTimer);
    this.focusTimer = window.setTimeout(() => CSS.highlights.delete(NAMES.focus), 1600);
  }

  /** Which note is under the point? Manual hit testing works on every Firefox version. */
  noteAt(x: number, y: number): string | null {
    for (let i = this.painted.length - 1; i >= 0; i--) {
      const p = this.painted[i]!;
      for (const r of p.ranges) {
        for (const rect of Array.from(r.getClientRects())) {
          if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return p.noteId;
        }
      }
    }
    return null;
  }

  rangesFor(noteId: string): Range[] {
    return this.painted.find((p) => p.noteId === noteId)?.ranges ?? [];
  }

  clear(): void {
    this.painted = [];
    for (const n of Object.values(NAMES)) CSS.highlights.delete(n);
  }
}
