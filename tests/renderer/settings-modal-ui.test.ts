import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'ConnectionSettingsModal.tsx',
);

const source = readFileSync(modalPath, 'utf8');

test('ConnectionSettingsModal uses a responsive settings workbench shell', () => {
  assert.match(source, /data-settings-workbench/);
  assert.match(source, /settings-workbench flex min-h-0 flex-1 flex-col gap-4 overflow-hidden/);
  assert.match(source, /md:grid-cols-\[minmax\(220px,248px\)_minmax\(0,1fr\)\]/);
  assert.match(source, /w-56 shrink-0/);
  assert.match(source, /md:w-full md:shrink/);
  assert.match(source, /line-clamp-2 text-sm font-semibold leading-tight/);
  assert.match(source, /contentClassName="!overflow-hidden !p-4 sm:!p-5"/);
  assert.match(source, /scrollbar-hide/);
});

test('ConnectionSettingsModal exposes navigable settings sections', () => {
  for (const section of [
    'admin',
    'connection',
    'terminal',
    'security',
    'database',
    'hardware',
    'printing',
    'payments',
    'about',
  ]) {
    assert.match(source, new RegExp(`id: '${section}'`));
    assert.match(source, new RegExp(`settings-section-${section}`));
  }

  assert.match(source, /handleSettingsSectionSelect/);
  assert.match(source, /setShowConnectionSettings\(true\)/);
  assert.match(source, /setShowTerminalPreferences\(true\)/);
  assert.match(source, /setShowPinSettings\(true\)/);
  assert.match(source, /setShowSecuritySettings\(true\)/);
  assert.match(source, /setShowDatabaseSettings\(true\)/);
  assert.match(source, /setShowPeripheralsSettings\(true\)/);
});

test('ConnectionSettingsModal keeps critical hardware and admin integrations wired', () => {
  assert.match(source, /PaymentTerminalsSection/);
  assert.match(source, /PrinterSettingsModal/);
  assert.match(source, /PrintQueuePanel/);
  assert.match(source, /CashRegisterSection/);
  assert.match(source, /CallerIdSection/);
  assert.match(source, /handleManualPolicySync/);
  assert.match(source, /handleSaveConnection/);
});
