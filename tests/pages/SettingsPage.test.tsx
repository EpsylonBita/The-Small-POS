import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '../../src/renderer/contexts/theme-context';
import { resetBridge, setBridge } from '../../src/lib';
import SettingsPage from '../../src/renderer/pages/SettingsPage';

function setNavigatorOnline(online: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      ...(globalThis.navigator || {}),
      onLine: online,
    },
    configurable: true,
  });
}

function installSettingsBridgeMock() {
  setBridge({
    terminalConfig: {
      getFullConfig: async () => ({
        terminal_id: 'terminal-1',
        branch_id: 'branch-1',
        organization_id: 'org-1',
      }),
      syncFromAdmin: async () => ({ success: true }),
      getSetting: async () => '',
    },
    settings: {
      getLocal: async () => ({ ip: '192.168.1.10', port: '9100', type: 'thermal' }),
      updateLocal: async () => ({ success: true }),
    },
    printer: {
      testDraft: async () => ({ success: true }),
    },
  } as any);
}

function renderSettingsPage(online: boolean) {
  setNavigatorOnline(online);
  installSettingsBridgeMock();
  return renderToStaticMarkup(
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>,
  );
}

test('SettingsPage renders the parity configuration sections', () => {
  const html = renderSettingsPage(true);

  assert.match(html, /Settings/);
  assert.match(html, /Terminal Configuration/);
  assert.match(html, /Sync Settings/);
  assert.match(html, /Feature Flags/);
  assert.match(html, /Hardware \/ Printer/);
  assert.match(html, /Sync Now/);
  assert.match(html, /Test Connection/);
  resetBridge();
});

test('SettingsPage renders offline banner and disables remote actions while keeping local save enabled', () => {
  const html = renderSettingsPage(false);

  assert.match(
    html,
    /Local terminal settings can still be saved offline\. Remote sync, admin refresh, and live device tests require an online connection\./,
  );
  assert.match(html, /Reconnect to run terminal sync\./);
  assert.match(html, /Reconnect to run live printer tests\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Sync Now<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Test Connection<\/button>/);
  assert.match(html, /<button class="[^"]*">[\s\S]*?Save<\/button>/);

  resetBridge();
});

test('SettingsPage enables sync controls online and removes offline-only messaging', () => {
  const html = renderSettingsPage(true);

  assert.doesNotMatch(
    html,
    /Local terminal settings can still be saved offline\. Remote sync, admin refresh, and live device tests require an online connection\./,
  );
  assert.doesNotMatch(html, /Reconnect to run terminal sync\./);
  assert.doesNotMatch(html, /Reconnect to run live printer tests\./);
  assert.match(html, /<button class="[^"]*">[\s\S]*?Sync Now<\/button>/);

  resetBridge();
});
