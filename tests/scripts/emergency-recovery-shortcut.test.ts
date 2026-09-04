import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const hooks = fs.readFileSync(
  path.resolve(process.cwd(), 'src-tauri/nsis-hooks.nsh'),
  'utf8',
);
const tauriConfig = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
) as { bundle?: { targets?: string[] } };

test('default Windows bundle target is the supported NSIS recovery package only', () => {
  assert.deepEqual(tauriConfig.bundle?.targets, ['nsis']);
});

test('NSIS installs one exact quoted emergency recovery shortcut idempotently', () => {
  assert.equal(
    hooks.includes(
      '!define EMERGENCY_RECOVERY_SHORTCUT "$SMPROGRAMS\\The Small POS - Emergency Recovery.lnk"',
    ),
    true,
  );
  const deleteShortcut = 'Delete "${EMERGENCY_RECOVERY_SHORTCUT}"';
  const createShortcut =
    'CreateShortCut "${EMERGENCY_RECOVERY_SHORTCUT}" "$INSTDIR\\${MAINBINARYNAME}.exe" "--emergency-recovery"';
  assert.ok(hooks.indexOf(deleteShortcut) >= 0);
  assert.ok(hooks.indexOf(createShortcut) > hooks.indexOf(deleteShortcut));
  assert.equal(hooks.match(/CreateShortCut .*--emergency-recovery/g)?.length, 1);
});

test('NSIS removes the installer-owned recovery shortcut on uninstall', () => {
  const postUninstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTUNINSTALL'));
  assert.equal(
    postUninstall.includes('Delete "${EMERGENCY_RECOVERY_SHORTCUT}"'),
    true,
  );
});
