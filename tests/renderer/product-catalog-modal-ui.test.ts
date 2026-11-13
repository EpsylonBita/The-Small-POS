import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'ProductCatalogModal.tsx');
const source = readFileSync(modalPath, 'utf8');

test('ProductCatalogModal is touch-first and on-theme', () => {
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/, 'retail catalog modal must not rely on hover utilities');
  assert.doesNotMatch(
    source,
    /\b(?:bg|text|border|ring|from|to|via|focus:ring)-(?:blue|cyan|sky|indigo|purple|pink)-/,
    'retail catalog modal must not use off-theme blue/purple/cyan styling',
  );
  assert.doesNotMatch(source, /rounded-md|rounded-lg|rounded-xl/, 'visible retail catalog modal surfaces should use smoother radii');
});

// founder 11/11/2026: frosted controls and tap depth replace the old white washes/scale feedback.
test('ProductCatalogModal category/product controls use kit selection and glass tap depth', () => {
  assert.match(source, /<div className="pos-scroll-row mb-4 gap-2">/);
  assert.equal((source.match(/'bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\) border border-\(--pos-s-sel-bg\)'/g) || []).length, 2);
  assert.equal((source.match(/'pos-glass-field liquid-glass-modal-text'/g) || []).length, 2);
  assert.doesNotMatch(source, /bg-yellow-400 text-black/);
  assert.match(source, /className="pos-glass-tap-card min-h-touch p-4 rounded-2xl border-\(--pos-s-border\)! text-left liquid-glass-modal-text"/);
  assert.match(source, /<Package className="w-8 h-8 liquid-glass-modal-text-muted" \/>/);
  assert.match(source, /<p className="text-sm liquid-glass-modal-text-muted truncate">\{product\.sku\}<\/p>/);
  assert.match(source, /onClick=\{\(\) => addToCart\(product\)\}/);
  assert.match(source, /onClick=\{\(\) => setCategoryFilter\('all'\)\}/);
  assert.match(source, /onClick=\{\(\) => setCategoryFilter\(cat\.id\)\}/);
});

test('ProductCatalogModal cart and checkout controls are touch-first with semantic colors', () => {
  assert.match(source, /aria-label=\{t\('common\.remove', 'Remove'\)\}/);
  assert.match(source, /min-h-touch min-w-touch flex items-center justify-center text-red-400 active:text-red-300 ml-2 transition-transform duration-150 active:scale-95/);
  assert.equal((source.match(/pos-glass-field h-11 w-11 shrink-0 rounded-full flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-40/g) || []).length, 2);
  assert.match(source, /onClick=\{\(\) => updateCartQuantity\(item\.lineId, -1\)\}/);
  assert.match(source, /onClick=\{\(\) => updateCartQuantity\(item\.lineId, 1\)\}/);
  assert.equal((source.match(/disabled=\{item\.is_offer_reward\}/g) || []).length, 2);
  assert.match(source, /rounded-full bg-\(--pos-s-surface-2\) px-2 py-1 text-sm font-medium text-emerald-800 dark:text-emerald-200/);
  assert.match(source, /focus:ring-2 focus:ring-yellow-400/);
  assert.match(source, /bg-\(--pos-s-yellow\) active:bg-yellow-500 disabled:bg-gray-600/);
  assert.match(source, /<div className="mt-3 rounded-2xl bg-\(--pos-s-surface\) p-3">[\s\S]*?onClick=\{\(\) => void handleCheckout\(\)\}/);
  assert.doesNotMatch(source, /focus:ring-blue-500|hover:bg-green-700/);
});

test('ProductCatalogModal glass fields and conditional reveals preserve busy-cart performance', () => {
  assert.equal((source.match(/liquid-glass-modal-input pos-glass-field min-h-touch/g) || []).length, 5);
  assert.match(source, /pos-glass-form-card w-80 flex min-h-0 flex-col p-4!/);
  assert.match(source, /<div key=\{item\.lineId\} className="pos-glass-form-card p-3! shadow-\(--pos-s-depth-card\)">/);
  assert.match(source, /pos-glass-tap-card min-h-touch rounded-2xl p-3 text-left liquid-glass-modal-text disabled:opacity-40/);
  assert.match(source, /\[&>\.liquid-glass-modal-header\]:border-b-0!/);
  assert.match(source, /<AnimatePresence initial=\{false\}>/);
  assert.match(source, /const reduceMotion = useReducedMotion\(\)/);
  assert.match(source, /initial: reduceMotion \? false as const : \{ opacity: 0, height: 0, y: 12, overflow: 'hidden' \}/);
  assert.match(source, /animate: \{ opacity: 1, height: 'auto', y: 0, overflow: 'visible' \}/);
  assert.match(source, /duration: reduceMotion \? 0 : 0\.24, ease: \[0\.2, 0\.8, 0\.2, 1\]/);
  assert.doesNotMatch(source, /backdrop-filter|backdrop-blur-|<motion\.div[^>]*key=\{item\.lineId\}|mode="wait"/);
  assert.doesNotMatch(source, /bg-white\/|text-white|border-t /);
  // The existing real warning keeps its warning token and state copy.
  assert.match(source, /border-\(--pos-s-warn\) bg-\(--pos-s-warn-bg\)/);
  assert.match(source, /t\('menu\.cart\.deliveryZoneNotCheckedNotice'\)/);
});
