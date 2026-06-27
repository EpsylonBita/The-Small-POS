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

test('ProductCatalogModal category/product controls use yellow and active tap feedback', () => {
  assert.match(source, /overflow-x-auto scrollbar-hide pb-2/);
  assert.match(source, /bg-yellow-400 text-black/);
  assert.match(source, /bg-white\/10 text-white active:bg-white\/20/);
  assert.match(source, /transition-transform duration-150 active:scale-\[0\.98\]/);
  assert.match(source, /p-4 rounded-2xl bg-white\/10 text-left transition-transform duration-150 active:scale-\[0\.99\] active:bg-white\/20/);
  assert.match(source, /<Package className="w-8 h-8 text-yellow-300" \/>/);
});

test('ProductCatalogModal cart and checkout controls are touch-first with semantic colors', () => {
  assert.match(source, /aria-label=\{t\('common\.remove', 'Remove'\)\}/);
  assert.match(source, /text-red-400 active:text-red-300 ml-2 transition-transform duration-150 active:scale-95/);
  assert.match(source, /bg-white\/10 active:bg-white\/20 flex items-center justify-center transition-transform duration-150 active:scale-95/);
  assert.match(source, /rounded-full bg-emerald-500\/10 px-2 py-1 text-sm font-medium text-emerald-300/);
  assert.match(source, /focus:ring-2 focus:ring-yellow-400/);
  assert.match(source, /bg-green-600 active:bg-green-700 disabled:bg-gray-600/);
  assert.doesNotMatch(source, /focus:ring-blue-500|hover:bg-green-700/);
});
