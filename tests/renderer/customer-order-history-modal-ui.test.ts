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

  assert.match(source, /bg-yellow-400 text-black/);
  assert.match(source, /border-\(--pos-s-border\) bg-\(--pos-s-surface-2\) text-yellow-800 dark:text-yellow-200 active:bg-\(--pos-s-surface-2\)/);
  assert.match(source, /border-b-2 border-yellow-400/);
});

test('CustomerOrderHistoryModal order rows are accessible press targets, not clickable divs', () => {
  assert.match(source, /<button[\s\S]*?type="button"[\s\S]*?disabled=\{!onViewOrder\}/);
  assert.match(source, /transition-transform duration-150 active:scale-\[0\.99\] active:bg-white\/10/);
  assert.match(source, /<ChevronRight className="w-4 h-4 liquid-glass-modal-text-muted" \/>/);
  assert.doesNotMatch(source, /className="p-4 bg-white\/5 rounded-lg border border-white\/10 hover:bg-white\/10 transition-colors cursor-pointer"/);
});

test('CustomerOrderHistoryModal keeps status colors semantic without blue or purple states', () => {
  assert.match(source, /case 'pending': return 'bg-\(--pos-s-surface-2\) text-yellow-800 dark:text-yellow-300 border-\(--pos-s-border\)'/);
  assert.match(source, /case 'preparing': return 'bg-\(--pos-s-surface-2\) text-amber-800 dark:text-amber-200 border-\(--pos-s-border\)'/);
  assert.match(source, /case 'ready': return 'bg-\(--pos-s-surface-2\) text-green-800 dark:text-green-200 border-\(--pos-s-border\)'/);
  assert.match(source, /case 'cancelled': return 'bg-\(--pos-s-surface-2\) text-red-800 dark:text-red-300 border-\(--pos-s-border\)'/);
});
