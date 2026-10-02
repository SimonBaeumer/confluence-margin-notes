// Background event page: context menu, keyboard command, toolbar badge.
// No state lives here; notes are in storage.local.

import type { ToBackground, ToContent } from '../src/core/messages';

const MENU_ID = 'margin-notes-add';

async function sendToTab(tabId: number | undefined, msg: ToContent): Promise<void> {
  if (tabId === undefined) return;
  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch {
    // No content script on this tab (not a Confluence page).
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
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

  browser.runtime.onMessage.addListener((msg: ToBackground, sender) => {
    if (sender.id !== browser.runtime.id) return;
    if (msg.type === 'badge' && sender.tab?.id !== undefined) {
      const tabId = sender.tab.id;
      void browser.action.setBadgeText({ tabId, text: msg.count > 0 ? String(msg.count) : '' });
      void browser.action.setBadgeBackgroundColor({ tabId, color: '#0c66e4' });
    }
  });
});
