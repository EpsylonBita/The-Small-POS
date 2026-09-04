import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOfflineActionState,
  getOfflinePageBanner,
  isOfflineManagedPage,
} from '../../src/renderer/services/offline-page-capabilities';

test('getOfflinePageBanner only returns banner copy for offline managed pages', () => {
  assert.equal(getOfflinePageBanner('settings', false), null);
  assert.match(
    getOfflinePageBanner('settings', true) || '',
    /Local terminal settings can still be saved offline/,
  );
  assert.equal(getOfflinePageBanner('unknown-page', true), null);
});

test('getOfflineActionState disables only declared remote-only actions', () => {
  assert.deepEqual(getOfflineActionState('settings', 'sync-now', false), {
    disabled: true,
    message: 'Reconnect to run terminal sync.',
  });
  assert.deepEqual(getOfflineActionState('settings', 'printer-test', false), {
    disabled: true,
    message: 'Reconnect to run live printer tests.',
  });
  assert.deepEqual(getOfflineActionState('settings', 'local-save', false), {
    disabled: false,
    message: null,
  });
  assert.deepEqual(getOfflineActionState('unknown-page', 'anything', false), {
    disabled: false,
    message: null,
  });
});

test('offline capability registry resolves aliases and representative page actions', () => {
  assert.equal(isOfflineManagedPage('plugin_integrations'), true);
  assert.deepEqual(getOfflineActionState('plugin_integrations', 'mydata.save', false), {
    disabled: true,
    message: 'Reconnect to save MyData configuration changes.',
  });
  assert.deepEqual(getOfflineActionState('payment_terminals', 'discover', false), {
    disabled: true,
    message: 'Reconnect to discover payment terminals.',
  });
  assert.deepEqual(getOfflineActionState('kiosk', 'toggle', false), {
    disabled: true,
    message: 'Reconnect to enable or disable kiosk ordering.',
  });
  assert.deepEqual(getOfflineActionState('coupons', 'delete', false), {
    disabled: true,
    message: 'Reconnect to delete coupons.',
  });
  assert.deepEqual(getOfflineActionState('settings', 'sync-now', true), {
    disabled: false,
    message: null,
  });
});

test('repair offline policy queues safe work and blocks authoritative or financial actions', () => {
  assert.equal(isOfflineManagedPage('repairs'), true);
  assert.match(
    getOfflinePageBanner('repairs', true) || '',
    /saved on this terminal and synced after reconnect/i,
  );
  assert.deepEqual(getOfflineActionState('repairs', 'create-intake', false), {
    disabled: false,
    message: 'This repair will be saved on this terminal and synced after reconnect.',
  });
  assert.deepEqual(getOfflineActionState('repairs', 'transition-ready', false), {
    disabled: false,
    message: 'Ready status will sync after reconnect. No customer notification has been sent yet.',
  });
  assert.deepEqual(getOfflineActionState('repairs', 'create-estimate', false), {
    disabled: true,
    message: 'Reconnect to create or revise an estimate.',
  });
  assert.deepEqual(getOfflineActionState('repairs', 'collect-payment', false), {
    disabled: true,
    message: 'Reconnect to collect a repair payment.',
  });
  assert.deepEqual(getOfflineActionState('repairs', 'transition-delivered', false), {
    disabled: true,
    message: 'Reconnect to mark a repair as delivered.',
  });
});
