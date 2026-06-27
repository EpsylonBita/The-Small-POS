import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditOrderItemsModal.tsx');
const source = readFileSync(modalPath, 'utf8');

test('EditOrderItemsModal is touch-first and on-theme', () => {
  assert.doesNotMatch(source, /^\uFEFF/, 'source must not contain a UTF-8 BOM');
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/, 'item edit modal must not rely on hover utilities');
  assert.doesNotMatch(
    source,
    /\b(?:bg|text|border|ring|from|to|via|focus:ring)-(?:blue|cyan|sky|indigo|purple|pink)-/,
    'item edit modal must not use off-theme blue/purple/cyan styling',
  );
  assert.doesNotMatch(source, /Ã|Â|â|�/, 'modal source must not contain mojibake');
});

test('EditOrderItemsModal quantity and remove controls are labelled tap targets', () => {
  assert.match(source, /aria-label=\{t\('common\.decrease', 'Decrease'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.increase', 'Increase'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.remove', 'Remove'\)\}/);
  assert.match(source, /active:bg-red-200\/50 dark:active:bg-red-900\/50 transition-transform duration-150 active:scale-95/);
  assert.match(source, /active:bg-green-200\/50 dark:active:bg-green-900\/50 transition-transform duration-150 active:scale-95/);
  assert.match(source, /active:bg-red-500\/20 liquid-glass-modal-text active:text-red-600 transition-transform duration-150 active:scale-95/);
});

test('EditOrderItemsModal loading spinner uses the yellow accent', () => {
  assert.match(source, /animate-spin h-8 w-8 text-yellow-400/);
  assert.doesNotMatch(source, /text-blue-500/);
});
