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
