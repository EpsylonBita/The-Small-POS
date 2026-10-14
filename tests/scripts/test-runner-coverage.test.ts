import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OWNED_BY_OTHER_SCRIPTS, listParityTestFiles } from '../../scripts/parity-test-files.mjs';

// A test file no runner picks up is silent cover. The desktop has two TypeScript runners:
// - vitest (`npm run test:unit`) only includes src/**/__tests__/**/*.test.{ts,tsx}
//   (vitest.config.ts); ConflictResolver.test.ts sat next to its service and never ran
//   until 14/10/2026;
// - the parity runner (`npm test`, scripts/run-parity-tests.mjs) runs every
//   tests/**/*.test.{ts,tsx} file except those another script owns
//   (scripts/parity-test-files.mjs); its old hand-kept list had left 45 files unrun.

const projectRoot = process.cwd();
const testsRoot = path.join(projectRoot, 'tests');

// Deliberately not the runner's own walk: Node's recursive readdir cross-checks it.
const walkTestFiles = (root: string): string[] =>
  fs.readdirSync(root, { encoding: 'utf8', recursive: true })
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((file) => /\.test\.tsx?$/.test(file) && fs.statSync(path.join(root, file)).isFile())
    .sort();

test('every src test file lies under a __tests__ directory, the only place vitest looks', () => {
  const vitestConfig = fs.readFileSync(path.join(projectRoot, 'vitest.config.ts'), 'utf8');
  assert.match(
    vitestConfig,
    /include: \['src\/\*\*\/__tests__\/\*\*\/\*\.test\.\{ts,tsx\}'\]/,
    'this guard assumes vitest includes only src/**/__tests__/**/*.test.{ts,tsx}',
  );

  const srcTests = walkTestFiles(path.join(projectRoot, 'src'));
  assert.ok(srcTests.length > 0, 'expected vitest test files under src/');
  const outsideTestsDirs = srcTests
    .filter((file) => !file.split('/').slice(0, -1).includes('__tests__'))
    .map((file) => `src/${file}`);
  assert.deepEqual(outsideTestsDirs, [], 'vitest never runs these files: move each under a __tests__ directory');
});

test('every tests/ file runs in the parity runner or in the one script that owns it', () => {
  const runner = fs.readFileSync(path.join(projectRoot, 'scripts', 'run-parity-tests.mjs'), 'utf8');
  assert.match(runner, /listParityTestFiles\(testsRoot\)/, 'the parity runner must discover its entry points');

  const parityFiles = listParityTestFiles(testsRoot);
  const ownedFiles = Object.keys(OWNED_BY_OTHER_SCRIPTS);
  assert.ok(parityFiles.includes('scripts/test-runner-coverage.test.ts'), 'this guard must run in the parity suite');
  assert.deepEqual(parityFiles.filter((file) => ownedFiles.includes(file)), [], 'an owned file must not run twice');
  assert.deepEqual([...parityFiles, ...ownedFiles].sort(), walkTestFiles(testsRoot));
});

test('each test file another script owns exists and is named by that script', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const owners = Object.entries(OWNED_BY_OTHER_SCRIPTS);
  assert.ok(owners.length > 0);

  for (const [file, owner] of owners) {
    assert.ok(fs.existsSync(path.join(testsRoot, ...file.split('/'))), `tests/${file} must exist`);

    const command = packageJson.scripts?.[owner.npmScript];
    assert.equal(typeof command, 'string', `package.json must define "${owner.npmScript}" for tests/${file}`);

    const fileName = path.posix.basename(file);
    if (command.includes(fileName)) continue;
    assert.ok(
      command.includes(owner.scriptFile),
      `"${owner.npmScript}" must name tests/${file} or run ${owner.scriptFile}`,
    );
    const scriptPath = path.join(projectRoot, ...owner.scriptFile.split('/'));
    assert.ok(fs.existsSync(scriptPath), `${owner.scriptFile} must exist`);
    assert.ok(
      fs.readFileSync(scriptPath, 'utf8').includes(fileName),
      `${owner.scriptFile} must name ${fileName}`,
    );
  }
});
