// The test files the desktop parity runner (scripts/run-parity-tests.mjs) runs:
// every tests/**/*.test.{ts,tsx} file except those another script owns.
//
// Shared by the runner and by tests/scripts/test-runner-coverage.test.ts. Tests
// import it through the esbuild bundle, so it never relies on import.meta.url:
// callers pass the tests root.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Test files run by another script, keyed by their path relative to tests/
 * (POSIX separators). The parity runner skips them; the coverage guard checks
 * that each one exists and that its owner really runs it.
 */
export const OWNED_BY_OTHER_SCRIPTS = Object.freeze({
  'support/support-layer.test.tsx': Object.freeze({
    npmScript: 'test:support-layer',
    scriptFile: 'scripts/run-support-tests.mjs',
  }),
});

const TEST_FILE = /\.test\.tsx?$/;

/** Every test file under testsRoot, relative with POSIX separators, sorted by code unit. */
export function listTestFiles(testsRoot) {
  const files = [];
  const walk = (relativeDir) => {
    const entries = fs.readdirSync(path.join(testsRoot, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(relativePath);
    }
  };
  walk('');
  return files.sort();
}

/** The parity runner's entry points: every test file minus those another script owns. */
export function listParityTestFiles(testsRoot) {
  return listTestFiles(testsRoot).filter((file) => !Object.hasOwn(OWNED_BY_OTHER_SCRIPTS, file));
}
