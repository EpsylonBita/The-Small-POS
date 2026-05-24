import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shouldResolveModulesForTerminalSettingsEvent } from '../../src/renderer/contexts/module-context';

const projectRoot = process.cwd();
const moduleContextPath = path.join(projectRoot, 'src', 'renderer', 'contexts', 'module-context.tsx');

test('module context only fully resolves modules for terminal identity setting changes', () => {
  assert.equal(
    shouldResolveModulesForTerminalSettingsEvent({ updated: ['receipt.currency', 'printer.ip'] }),
    false,
  );
  assert.equal(
    shouldResolveModulesForTerminalSettingsEvent({ key: 'terminal.admin_dashboard_url' }),
    true,
  );
  assert.equal(
    shouldResolveModulesForTerminalSettingsEvent({ updated: ['terminal.pos_api_key'] }),
    true,
  );
});

test('module context keeps routine syncs from putting navigation back into loading state', () => {
  const source = readFileSync(moduleContextPath, 'utf8');

  assert.match(source, /resolveModules\(\{ showLoading: false \}\)/);
  assert.match(source, /syncModulesFromAdmin\(\{ reportSyncing: false \}\)/);
  assert.match(source, /Terminal settings updated, syncing modules without navigation reload/);
});
