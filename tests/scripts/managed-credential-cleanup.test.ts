import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const storagePath = path.resolve(process.cwd(), 'src-tauri/src/storage.rs');
const hooksPath = path.resolve(process.cwd(), 'src-tauri/nsis-hooks.nsh');
const generatedIncludePath = path.resolve(
  process.cwd(),
  'src-tauri/generated/managed-credential-targets.nsh',
);
const generatedHelperPath = path.resolve(
  process.cwd(),
  'src-tauri/generated/delete-managed-credentials.ps1',
);

const storage = fs.readFileSync(storagePath, 'utf8');
const hooks = fs.readFileSync(hooksPath, 'utf8');
const generatedInclude = fs.existsSync(generatedIncludePath)
  ? fs.readFileSync(generatedIncludePath, 'utf8')
  : '';
const generatedHelper = fs.existsSync(generatedHelperPath)
  ? fs.readFileSync(generatedHelperPath, 'utf8')
  : '';
const cargoLock = fs.readFileSync(path.resolve(process.cwd(), 'src-tauri/Cargo.lock'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));

function parseCanonicalManagedKeys(source: string): string[] {
  const scalarConstants = new Map<string, string>();
  const scalarPattern = /(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;/g;
  for (const match of source.matchAll(scalarPattern)) {
    scalarConstants.set(match[1], match[2]);
  }

  const arrayConstants = new Map<string, string[]>();
  const arrayPattern = /(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)\s*:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\]\s*;/g;
  for (const match of source.matchAll(arrayPattern)) {
    arrayConstants.set(
      match[1],
      Array.from(match[2].matchAll(/"([^"]+)"/g), (value) => value[1]),
    );
  }

  const allKeysMatch = source.match(/const\s+ALL_KEYS\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]\s*;/);
  assert.ok(allKeysMatch, 'storage.rs must expose the canonical ALL_KEYS registry');

  const tokens = allKeysMatch[1]
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens.map((token) => {
    const indexed = token.match(/^(\w+)\[(\d+)\]$/);
    if (indexed) {
      const values = arrayConstants.get(indexed[1]);
      assert.ok(values, `ALL_KEYS references unknown array ${indexed[1]}`);
      const value = values[Number(indexed[2])];
      assert.ok(value, `ALL_KEYS references missing ${token}`);
      return value;
    }

    const value = scalarConstants.get(token);
    assert.ok(value, `ALL_KEYS references unknown scalar ${token}`);
    return value;
  });
}

test('NSIS delete-app-data cleanup covers every canonical managed credential', () => {
  const canonicalKeys = parseCanonicalManagedKeys(storage);
  assert.match(cargoLock, /name = "keyring"\s+version = "3\.6\.3"/);
  const expectedTargets = canonicalKeys.map((key) => `${key}.the-small-pos`).sort();
  const macroBody = generatedInclude.match(
    /!macro THE_SMALL_POS_DELETE_MANAGED_CREDENTIALS([\s\S]*?)!macroend/,
  )?.[1] ?? '';
  const execLine = macroBody.split('\n').find((line) => line.includes('nsExec::ExecToLog')) ?? '';
  const actualTargets = Array.from(
    execLine.matchAll(/"([a-z0-9_]+\.the-small-pos)"/g),
    (match) => match[1],
  ).sort();

  for (const required of [
    'repair_queue_aes_key_v1',
    'repair_scope_v1',
    'repair_entitlement_v1',
    'pos_session',
    'callerid_sip_password',
    'callerid_activation_cache_manifest_v1',
    'callerid_activation_cache_a0_v1',
    'callerid_activation_cache_b7_v1',
  ]) {
    assert.equal(canonicalKeys.includes(required), true, `${required} must stay managed by storage.rs`);
  }

  assert.deepEqual(actualTargets, expectedTargets);
  assert.equal(execLine.includes('the-small-pos.pos_session'), false);
  assert.equal(actualTargets.includes('pos_session.the-small-pos'), true);
});

test('managed credential generator fails closed unless Cargo.lock pins keyring 3.6.3', async () => {
  const generator = await import('../../scripts/generate-managed-credential-targets.mjs');
  const keyringBlock = cargoLock.match(/\[\[package\]\]\s*name = "keyring"[\s\S]*?(?=\n\[\[package\]\])/);
  assert.ok(keyringBlock);
  const mutatedLock = cargoLock.replace(
    keyringBlock[0],
    keyringBlock[0].replace('version = "3.6.3"', 'version = "3.6.4"'),
  );
  assert.throws(
    () => generator.assertSupportedKeyringVersion(mutatedLock),
    /unsupported keyring version/i,
  );
});

test('managed credential generator accepts Windows checkout line endings without hiding content drift', async () => {
  const generator = await import('../../scripts/generate-managed-credential-targets.mjs');
  const expected = 'first line\nsecond line\n';

  assert.equal(
    generator.generatedTextMatches('first line\r\nsecond line\r\n', expected),
    true,
  );
  assert.equal(
    generator.generatedTextMatches('first line\r\nchanged line\r\n', expected),
    false,
  );
});

test('managed credential cleanup surfaces real delete failures while missing keys stay idempotent', () => {
  assert.match(generatedHelper, /CredDelete/);
  assert.match(generatedHelper, /errorCode\s+-ne\s+1168/);
  assert.match(generatedHelper, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(generatedHelper, /try\s*\{/);
  assert.match(generatedHelper, /catch\s*\{/);
  assert.doesNotMatch(generatedHelper, /\$_\.Exception|\$target.*WriteLine/);
  assert.match(generatedInclude, /SetErrorLevel|MessageBox/);
  assert.doesNotMatch(generatedInclude, /cmdkey\.exe/);
});

test('NSIS captures the generated helper path outside macros', () => {
  const firstMacro = hooks.indexOf('!macro ');
  const helperDefine = hooks.indexOf('!define MANAGED_CREDENTIAL_DELETE_HELPER');
  assert.ok(helperDefine >= 0 && helperDefine < firstMacro);
  assert.match(hooks, /!define MANAGED_CREDENTIAL_DELETE_HELPER "\$\{__FILEDIR__\}\\generated\\delete-managed-credentials\.ps1"/);

  const macroBody = generatedInclude.match(
    /!macro THE_SMALL_POS_DELETE_MANAGED_CREDENTIALS([\s\S]*?)!macroend/,
  )?.[1] ?? '';
  assert.match(macroBody, /"\$\{MANAGED_CREDENTIAL_DELETE_HELPER\}"/);
  assert.doesNotMatch(macroBody, /\$\{__FILEDIR__\}/);
});

test('named managed credential gate is wired into normal runtime and parity gates', () => {
  assert.match(
    packageJson.scripts['test:managed-credential-cleanup'],
    /check-managed-credential-nsis-smoke\.mjs/,
  );
  assert.match(packageJson.scripts['test:native-runtime'], /test:managed-credential-cleanup/);
  assert.match(
    fs.readFileSync(path.resolve(process.cwd(), 'scripts/run-parity-tests.mjs'), 'utf8'),
    /managed-credential-cleanup\.test\.ts/,
  );
  assert.match(
    fs.readFileSync(path.resolve(process.cwd(), '../.github/workflows/pos-tauri-auto-release.yml'), 'utf8'),
    /npm run test:managed-credential-cleanup[\s\S]*name: Build NSIS bundle/,
  );
});

test('managed credential deletion remains inside delete-app-data and non-update guards', () => {
  const postUninstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTUNINSTALL'));
  const deleteAppDataGuard = postUninstall.indexOf('${If} $DeleteAppDataCheckboxState = 1');
  const nonUpdateGuard = postUninstall.indexOf('${AndIf} $UpdateMode <> 1', deleteAppDataGuard);
  const cleanupCall = postUninstall.indexOf(
    '!insertmacro THE_SMALL_POS_DELETE_MANAGED_CREDENTIALS',
    nonUpdateGuard,
  );
  const guardEnd = postUninstall.indexOf('${EndIf}', nonUpdateGuard);

  assert.ok(deleteAppDataGuard >= 0);
  assert.ok(nonUpdateGuard > deleteAppDataGuard);
  assert.ok(cleanupCall > nonUpdateGuard);
  assert.ok(guardEnd > cleanupCall);
});
