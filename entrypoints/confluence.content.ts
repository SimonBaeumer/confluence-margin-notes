declare const __E2E__: boolean;

import { App } from '../src/content/app';

export default defineContentScript({
  matches: ['https://*.atlassian.net/wiki/*'],
  runAt: 'document_idle',
  main() {
    const app = new App();
    app.start();
    if (__E2E__) {
      // Lets e2e tests open the sidebar page in a tab, pinned to this tab.
      // Tests trigger it with: document.dispatchEvent(new Event('mn-e2e-open-sidebar'))
      document.addEventListener('mn-e2e-debug', () => {
        document.documentElement.dataset.mnDebug = JSON.stringify(app.debug());
      });
      document.addEventListener('mn-e2e-open-sidebar', () => void browser.runtime.sendMessage({ type: 'e2e-open-sidebar' }));
    }
  },
});
