import { App } from '../src/content/app';

export default defineContentScript({
  matches: ['https://*.atlassian.net/wiki/*'],
  runAt: 'document_idle',
  main() {
    new App().start();
  },
});
