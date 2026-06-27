import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modalSource = () =>
  readFileSync(
    path.join(
      process.cwd(),
      'src',
      'renderer',
      'components',
      'modals',
      'EditSettlementDeltaModal.tsx',
    ),
    'utf8',
  );

test('EditSettlementDeltaModal cannot be dismissed by backdrop or Escape', () => {
  const source = modalSource();

  assert.match(source, /closeOnBackdrop=\{false\}/);
  assert.match(source, /closeOnEscape=\{false\}/);
});

test('EditSettlementDeltaModal uses touch-first rounded settlement controls', () => {
  const source = modalSource();

  assert.match(source, /rounded-2xl border p-5 text-center/);
  assert.match(source, /rounded-2xl border px-4 py-5/);
  assert.match(source, /rounded-2xl border border-white\/10 bg-white\/5/);
  assert.match(source, /active:border-emerald-400\/50 active:bg-emerald-500\/15/);
  assert.match(source, /active:border-orange-400\/50 active:bg-orange-500\/15/);
  assert.match(source, /onConfirm\(method\)/);
  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});
