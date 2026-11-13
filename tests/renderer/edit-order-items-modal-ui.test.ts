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
  // founder 11/11/2026: all three labelled steppers are 44 px frosted controls with kit press depth.
  assert.equal((source.match(/pos-glass-field h-11 w-11 shrink-0 flex items-center justify-center/g) ?? []).length, 3);
  const css = readFileSync(path.join(projectRoot, 'src/renderer/styles/glassmorphism.css'), 'utf8');
  assert.match(css, /button\.pos-glass-field:is\(:active, \[data-pressed\]\):not\(:disabled\)[\s\S]*?box-shadow: var\(--pos-s-depth-press\)/);

});

test('EditOrderItemsModal loading spinner uses the yellow accent', () => {
  assert.match(source, /animate-spin h-8 w-8 text-yellow-400/);
  assert.doesNotMatch(source, /text-blue-500/);
});
