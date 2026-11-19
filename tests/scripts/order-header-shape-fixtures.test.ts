import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Included by the default parity runner. A server mapper change must update
// the shared wire fixture consumed by the native ordinary-edit/notice tests.
test('header preflight fixtures agree with the actual till and server line mappers', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-order-header-shape-fixtures.cjs', '--check'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
