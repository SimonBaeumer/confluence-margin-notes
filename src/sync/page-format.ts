// The sync page body: a short explanation and the notes as JSON in a code
// block macro, in Confluence's storage format.

import { emptySyncDoc, type SyncDoc } from './merge';

export const SYNC_PAGE_TITLE = 'margin-notes sync';

const INTRO =
  '<p>This page is managed by the margin-notes browser extension and holds your private notes. ' +
  'Keep it restricted to yourself and do not edit it by hand.</p>';

/** `]]>` would end the CDATA section and `<` could start markup: JSON lets us escape both. */
function toCdata(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function renderSyncPage(doc: SyncDoc): string {
  return (
    INTRO +
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter>' +
    `<ac:plain-text-body><![CDATA[${toCdata(JSON.stringify(doc))}]]></ac:plain-text-body></ac:structured-macro>`
  );
}

/**
 * Reads the notes back. A page without a data block (just created) is an
 * empty document; anything else that does not parse is an error, so a page
 * damaged by hand is never overwritten with an empty set.
 */
export function parseSyncPage(storage: string, now: string): SyncDoc {
  const m = storage.match(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/);
  if (!m) {
    if (/ac:plain-text-body/.test(storage)) throw new Error('The sync page has a data block that cannot be read.');
    return emptySyncDoc(now);
  }
  let doc: SyncDoc;
  try {
    doc = JSON.parse(m[1]!);
  } catch {
    throw new Error('The data on the sync page is not valid JSON. It was not overwritten.');
  }
  if (doc?.format !== 'margin-notes-sync' || !Array.isArray(doc.notes)) {
    throw new Error('The sync page does not hold margin-notes data. It was not overwritten.');
  }
  return { ...doc, purged: doc.purged ?? {} };
}
