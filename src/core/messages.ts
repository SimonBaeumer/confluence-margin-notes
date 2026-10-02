// Messages between the sidebar, background and content script. Plain JSON only.

import type { AnchorStatus, PageRef } from './model';

export type ToContent =
  | { type: 'add-note' }
  | { type: 'get-page' }
  | { type: 'scroll-to'; noteId: string }
  | { type: 'edit-note'; noteId: string }
  /** Scrolls to a note and opens it: our popover, or Confluence's thread once published. Answers whether it was found. */
  | { type: 'jump-to'; noteId: string }
  | { type: 'open-submit' }
  | { type: 'publish-now'; noteId: string }
  | { type: 'reattach'; noteId: string };

export interface PageInfo {
  page: PageRef | null;
  /** Why notes can't be taken here, e.g. edit mode. */
  unavailable: string | null;
  version: number | null;
  /** Live anchor results of this tab, by note id. */
  anchors: Record<string, { status: AnchorStatus; exact: string }>;
}

export type ToBackground = { type: 'badge'; count: number };

export interface Settings {
  apiEmail: string;
  apiToken: string;
}

export const SETTINGS_KEY = 'settings';

export function pageKeyFor(host: string, pageId: string): string {
  return `confluence:${host}:${pageId}`;
}
