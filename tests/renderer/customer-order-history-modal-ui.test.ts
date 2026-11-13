import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'CustomerOrderHistoryModal.tsx');
const source = readFileSync(modalPath, 'utf8');

test('CustomerOrderHistoryModal is touch-first and on-theme', () => {
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/, 'touch POS modal must not use hover utilities');
  assert.doesNotMatch(
    source,
    /\b(?:bg|text|border|ring|from|to|via|focus:ring)-(?:blue|cyan|sky|indigo|purple|pink)-/,
    'customer history modal must stay out of blue/purple off-theme styling',
  );
  assert.doesNotMatch(source, /rounded-lg/, 'visible modal surfaces should use smooth rounded corners');

  // founder 11/11/2026: neutral frosted context instead of a yellow icon tile.
  assert.match(source, /rounded-2xl liquid-glass-modal-text-muted/);
  assert.match(source, /pos-glass-form-card shrink-0 mx-6 p-3!/);
  assert.match(source, /shrink-0 px-6 pb-5 pt-2/);
  assert.match(source, /border-\(--pos-s-border\) bg-\(--pos-s-surface-2\) text-yellow-800 dark:text-yellow-200 active:bg-\(--pos-s-surface-2\)/);
  assert.match(source, /border-b-2 border-yellow-400/);
});

test('CustomerOrderHistoryModal order rows are accessible press targets, not clickable divs', () => {
  assert.match(source, /<button[\s\S]*?type="button"[\s\S]*?disabled=\{!onViewOrder\}/);
  // founder 11/11/2026: the tap-card class supplies depth and sinks while pressed.
  assert.match(source, /pos-glass-tap-card min-h-touch w-full p-4 text-left focus-visible:outline-2/);
  const glass = readFileSync(path.join(projectRoot, 'src/renderer/styles/glassmorphism.css'), 'utf8');
  assert.match(glass, /\.pos-glass-tap-card:is\(:active, \[data-pressed\]\):not\(:disabled\) \{[\s\S]*?box-shadow: var\(--pos-s-depth-press\);[\s\S]*?translate: 0 1px/);
  assert.match(source, /<ChevronRight className="w-4 h-4 liquid-glass-modal-text-muted" \/>/);
  assert.doesNotMatch(source, /className="p-4 bg-white\/5 rounded-lg border border-white\/10 hover:bg-white\/10 transition-colors cursor-pointer"/);
});

// founder 11/11/2026: status words retain semantic colors without badge washes.
test('CustomerOrderHistoryModal keeps status colors semantic without blue or purple states', () => {
  assert.match(source, /case 'pending': return 'text-yellow-800 dark:text-yellow-300'/);
  assert.match(source, /case 'preparing': return 'text-amber-800 dark:text-amber-200'/);
  assert.match(source, /case 'ready': return 'text-green-800 dark:text-green-200'/);
  assert.match(source, /case 'cancelled': return 'text-red-800 dark:text-red-300'/);
});
