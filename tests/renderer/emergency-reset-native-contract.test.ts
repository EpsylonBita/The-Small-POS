import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('ordinary renderer exposes no emergency reset IPC command or legacy bridge', () => {
  const adapter = fs.readFileSync(path.join(root, 'src/lib/ipc-adapter.ts'), 'utf8');
  const native = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  const settings = fs.readFileSync(
    path.join(root, 'src-tauri/src/commands/settings.rs'),
    'utf8',
  );

  assert.equal(adapter.includes('emergencyReset'), false);
  assert.equal(adapter.includes('settings:emergency-reset'), false);
  assert.equal(native.includes('settings_emergency_reset'), false);
  assert.equal(
    /(?:tauri::command|pub async fn)\s+settings_emergency_reset/.test(settings),
    false,
  );
});

test('renderer confirmation-shaped data has no emergency reset native channel', () => {
  const adapter = fs.readFileSync(path.join(root, 'src/lib/ipc-adapter.ts'), 'utf8');
  for (const untrusted of ['confirmed', 'phrase', 'nonce', 'operationId']) {
    const fakePayload = JSON.stringify({
      [untrusted]: untrusted === 'confirmed' ? true : 'RESET',
    });
    assert.ok(fakePayload.length > 0);
    assert.equal(adapter.includes('settings:emergency-reset'), false);
  }
});
