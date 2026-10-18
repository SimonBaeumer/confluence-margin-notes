// Messages between the sidebar, background and content script. Plain JSON only.

import type { AdfDoc, AnchorStatus, PageRef } from './model';

export type ToContent =
  | { type: 'add-note' }
  | { type: 'get-page' }
  | { type: 'scroll-to'; noteId: string }
  | { type: 'edit-note'; noteId: string }
  /** Scrolls to a note and opens our popover. Answers whether it was found. */
  | { type: 'jump-to'; noteId: string }
  /** Scrolls to a comment on this page and opens its thread. Answers whether it was found. */
  | { type: 'jump-to-comment'; commentId: string }
  | { type: 'open-submit' }
  | { type: 'publish-now'; noteId: string }
  /** Opens the publish dialog for a reply draft on this site. */
  | { type: 'publish-reply'; replyId: string }
  | { type: 'reattach'; noteId: string }
  /** Replaces the text of your comment in Confluence. Answers { error }. */
  | { type: 'edit-comment'; site: string; commentId: string; body: AdfDoc }
  /** Deletes your comment in Confluence and keeps it as a private note. Answers { error }. */
  | { type: 'unpublish'; site: string; commentId: string }
  /** Re-reads the comments on this page and your comments on this site. Answers { error }. */
  | { type: 'refresh-comments' }
  /** Sets up sync on this tab's site. Answers { error }. */
  | { type: 'sync-setup' }
  /** Answers { error }. */
  | { type: 'sync-now' };

/** Answer to the actions above: null on success. */
export interface ActionResult {
  error: string | null;
}

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
