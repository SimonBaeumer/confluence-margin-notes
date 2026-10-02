import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  manifestVersion: 3,
  vite: () => ({ define: { __E2E__: JSON.stringify(process.env.MN_E2E === '1') } }),
  manifest: {
    name: 'margin-notes',
    description: 'Private notes anchored to Confluence text, publishable as inline comments in one batch.',
    permissions: ['storage', 'unlimitedStorage', 'contextMenus', 'tabs'],
    host_permissions: ['https://*.atlassian.net/*'],
    browser_specific_settings: {
      gecko: {
        id: 'margin-notes@s-baeumer.de',
        strict_min_version: '150.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
    action: { default_title: 'margin-notes' },
    commands: {
      'add-note': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Add a note to the current selection',
      },
      _execute_sidebar_action: {
        suggested_key: { default: 'Alt+Shift+N' },
        description: 'Open the margin-notes sidebar',
      },
    },
  },
});
