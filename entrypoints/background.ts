// Background event page: context menu, keyboard command, toolbar badge and
// purging old deleted notes. No state lives here; notes are in storage.local.

import type { ToBackground, ToContent } from '../src/core/messages';
import { NoteStore } from '../src/core/store';
import { purgeLocal } from '../src/sync/service';

declare const __E2E__: boolean;

const MENU_ID = 'margin-notes-add';

async function sendToTab(tabId: number | undefined, msg: ToContent): Promise<void> {
  if (tabId === undefined) return;
  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch {
    // No content script on this tab (not a Confluence page).
  }
}

async function purge(): Promise<void> {
  try {
    const n = await purgeLocal(browser.storage.local, new NoteStore(browser.storage.local));
    if (n) console.info(`[margin-notes] purged ${n} deleted note${n === 1 ? '' : 's'}`);
  } catch (e) {
    console.warn('[margin-notes] purge failed', e);
  }
}

export default defineBackground(() => {
  browser.runtime.onStartup.addListener(() => void purge());
  browser.runtime.onInstalled.addListener(() => {
    void purge();
    browser.contextMenus.create({
      id: MENU_ID,
      title: 'Add margin note',
      contexts: ['selection'],
      documentUrlPatterns: ['https://*.atlassian.net/wiki/*'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) void sendToTab(tab?.id, { type: 'add-note' });
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'add-note') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    void sendToTab(tab?.id, { type: 'add-note' });
  });

  browser.action.onClicked.addListener(() => {
    // Firefox only allows opening the sidebar from a user action handler.
    void (browser as any).sidebarAction?.toggle?.();
  });

  browser.runtime.onMessage.addListener((msg: ToBackground | { type: 'e2e-open-sidebar' }, sender) => {
    if (sender.id !== browser.runtime.id) return;
    if (__E2E__ && msg.type === 'e2e-open-sidebar' && sender.tab?.id !== undefined) {
      void browser.tabs.create({ url: browser.runtime.getURL('/sidepanel.html') + '?tab=' + sender.tab.id });
      return;
    }
    if (msg.type === 'badge' && sender.tab?.id !== undefined) {
      const tabId = sender.tab.id;
      void browser.action.setBadgeText({ tabId, text: msg.count > 0 ? String(msg.count) : '' });
      void browser.action.setBadgeBackgroundColor({ tabId, color: '#0c66e4' });
    }
  });
});
