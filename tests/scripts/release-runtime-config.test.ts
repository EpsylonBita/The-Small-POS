import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// check-release-runtime-config.mjs reads fixed paths relative to itself, so each
// case runs a copy of the script inside a copy of the files it reads and edits
// only the copies.
const projectRoot = process.cwd();
const repositoryRoot = path.resolve(projectRoot, '..');
const checkerFiles = [
  'pos-tauri/scripts/check-release-runtime-config.mjs',
  '.github/workflows/pos-tauri-auto-release.yml',
  'pos-tauri/config/caller-id-offline-lease-verifier.properties',
  'pos-tauri/src-tauri/build.rs',
  'pos-tauri/src-tauri/tauri.conf.json',
  'POSSystemMobile/android/app/build.gradle',
];
const workflowFile = '.github/workflows/pos-tauri-auto-release.yml';
const tauriConfigFile = 'pos-tauri/src-tauri/tauri.conf.json';

function runChecker(edit: (root: string) => void = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pos-release-runtime-config-'));
  try {
    for (const file of checkerFiles) {
      const target = path.join(root, ...file.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(repositoryRoot, ...file.split('/')), target);
    }
    edit(root);
    return spawnSync(
      process.execPath,
      [path.join(root, 'pos-tauri', 'scripts', 'check-release-runtime-config.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function editFile(root: string, file: string, change: (text: string) => string) {
  const filePath = path.join(root, ...file.split('/'));
  const before = readFileSync(filePath, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `the edit must change ${file}`);
  writeFileSync(filePath, after, 'utf8');
}

function editUpdaterConfig(root: string, change: (updater: Record<string, unknown>) => void) {
  editFile(root, tauriConfigFile, (text) => {
    const config = JSON.parse(text);
    change(config.plugins.updater);
    return `${JSON.stringify(config, null, 2)}\n`;
  });
}

function assertRefused(result: ReturnType<typeof spawnSync>, reason: string) {
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(String(result.stderr).includes(reason), `expected "${reason}" in:\n${result.stderr}`);
}

test('the release workflow and tauri.conf.json pass the release runtime contract', () => {
  const result = runChecker();
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(String(result.stdout), /POS release runtime config contract passed/);
});

test('refuses a build that accepts updates signed without a version', () => {
  const reason = 'plugins.updater.requireSignedVersion must be true';
  assertRefused(runChecker((root) => editUpdaterConfig(root, (updater) => {
    delete updater.requireSignedVersion;
  })), reason);
  assertRefused(runChecker((root) => editUpdaterConfig(root, (updater) => {
    updater.requireSignedVersion = false;
  })), reason);
});

test('refuses a build that lets the updater install an older release', () => {
  assertRefused(
    runChecker((root) => editUpdaterConfig(root, (updater) => {
      updater.allowDowngrades = true;
    })),
    'plugins.updater.allowDowngrades must stay off',
  );
});

test('refuses an updater signature that does not bind the release version', () => {
  assertRefused(
    runChecker((root) => editFile(root, workflowFile, (text) =>
      text.replace(/ --app-version "\$env:RELEASE_VERSION"/, ''))),
    'every updater signature must bind the release version with --app-version',
  );
});

test('refuses a latest.json that announces another version than the one signed', () => {
  // The changelog step passes the same --version earlier in the workflow, so only
  // the manifest step's copy is changed.
  const manifestStep = '      - name: Generate latest.json updater manifest';
  assertRefused(
    runChecker((root) => editFile(root, workflowFile, (text) => {
      const start = text.indexOf(manifestStep);
      assert.ok(start >= 0, 'the workflow must have the manifest step');
      return text.slice(0, start) + text.slice(start).replace(
        '--version "${{ steps.version.outputs.version }}"',
        '--version "${{ env.OTHER_VERSION }}"',
      );
    })),
    'latest.json must announce the same release version the signature records',
  );
});
