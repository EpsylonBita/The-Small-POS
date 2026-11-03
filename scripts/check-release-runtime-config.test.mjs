import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'pos-tauri/scripts/check-release-runtime-config.mjs',
  '.github/workflows/pos-tauri-auto-release.yml',
  'pos-tauri/config/caller-id-offline-lease-verifier.properties',
  'pos-tauri/src-tauri/build.rs',
  'pos-tauri/src-tauri/tauri.conf.json',
  'pos-tauri/src-tauri/src/lib.rs',
  'pos-tauri/src-tauri/src/main.rs',
  'POSSystemMobile/android/app/build.gradle',
];
const native = 'pos-tauri/src-tauri/src/lib.rs';
function check(edit = () => {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'support-release-guard-'));
  try {
    for (const file of files) {
      const target = path.join(fixture, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    edit(fixture);
    return spawnSync(process.execPath, [path.join(fixture, files[0])], { encoding: 'utf8' });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
function replace(fixture, file, from, to) {
  const target = path.join(fixture, file);
  const before = fs.readFileSync(target, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(before, after);
  fs.writeFileSync(target, after);
}
test('release runtime checks retain all existing workflow and updater checks', () => {
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});
test('release startup must sanitize environment before creating the WebView', () => {
  const result = check(fixture => replace(fixture, native, 'strip_release_webview_debugging_port();', ''));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /before constructing the WebView/u);
});
test('release startup must sanitize Tauri window configuration', () => {
  const result = check(fixture => replace(fixture, native, 'strip_release_webview_config(&mut context);', ''));
  assert.equal(result.status, 1);
});
test('a release profile cannot bypass either sanitizer through an inverted gate', () => {
  for (const [from, to] of [
    ['!cfg!(debug_assertions)', 'cfg!(debug_assertions)'],
    ['strip_webview_environment_for_profile(true);', 'strip_webview_environment_for_profile(false);'],
  ]) {
    const result = check(fixture => replace(fixture, native, from, to));
    assert.equal(result.status, 1);
  }
});
test('code-created additional browser argument sources require a guard', () => {
  const result = check(fixture => fs.writeFileSync(path.join(fixture, 'pos-tauri/src-tauri/src/unsafe_fixture.rs'),
    'builder.additional_browser_args("--remote-debugging-port=9222");'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unguarded code browser arguments/u);
});
test('existing updater security checks still reject unsafe release configuration', () => {
  const result = check(fixture => replace(fixture, 'pos-tauri/src-tauri/tauri.conf.json',
    '"requireSignedVersion": true', '"requireSignedVersion": false'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requireSignedVersion must be true/u);
});
