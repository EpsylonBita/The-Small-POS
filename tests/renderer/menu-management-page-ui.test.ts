import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const menuManagementPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'MenuManagementPage.tsx'),
    'utf8',
  );

test('MenuManagementPage uses yellow selected tabs with strong black text', () => {
  const source = menuManagementPageSource();

  assert.match(source, /useState<'categories' \| 'subcategories' \| 'ingredients' \| 'combos'>\('categories'\)/);
  assert.match(source, /const getTabClass = \(tab: typeof activeTab\)/);
  assert.match(source, /'bg-yellow-500 text-black font-semibold border border-yellow-400'/);
  assert.match(source, /className=\{getTabClass\('categories'\)\}/);
  assert.match(source, /className=\{getTabClass\('subcategories'\)\}/);
  assert.match(source, /className=\{getTabClass\('ingredients'\)\}/);
  assert.match(source, /className=\{getTabClass\('combos'\)\}/);
  assert.doesNotMatch(source, /bg-blue-500\/30 text-blue-200 border border-blue-500\/50/);
  assert.doesNotMatch(source, /bg-blue-500 text-white/);
});

test('MenuManagementPage uses neutral grey controls, white search outline, and yellow grid cards', () => {
  const source = menuManagementPageSource();

  assert.match(source, /bg-zinc-900 text-zinc-200 hover:bg-zinc-800/);
  assert.match(source, /bg-gray-100 text-gray-700 hover:bg-gray-200/);
  assert.match(source, /bg-zinc-900 border-white text-white placeholder-zinc-400/);
  assert.match(source, /bg-gray-100 border-white text-gray-900 placeholder-gray-500/);
  assert.match(source, /focus:outline-none focus:ring-2 focus:ring-white\/70/);
  assert.match(source, /const gridCardClass = `p-4 rounded-xl border/);
  assert.match(source, /bg-yellow-500\/10 border-yellow-500\/45/);
  assert.match(source, /bg-yellow-50 border-yellow-200/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!category\.is_active \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!item\.is_available \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!ingredient\.is_available \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!combo\.is_active \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.doesNotMatch(source, /bg-gray-800\/50 border-gray-700/);
  assert.doesNotMatch(source, /bg-gray-800\/50 text-gray-300 hover:bg-gray-700\/50/);
  assert.doesNotMatch(source, /bg-white border-gray-200/);
  assert.doesNotMatch(source, /bg-slate-800\/70/);
  assert.doesNotMatch(source, /bg-slate-100/);
  assert.doesNotMatch(source, /focus:ring-blue-500/);
});

test('MenuManagementPage places refresh as an icon-only header action like Orders', () => {
  const source = menuManagementPageSource();

  assert.match(source, /const refreshLabel = loading \? 'Refreshing menu' : 'Refresh menu';/);
  assert.match(source, /className="mb-6 flex items-start justify-between gap-4"/);
  assert.match(source, /aria-label=\{refreshLabel\}/);
  assert.match(source, /title=\{refreshLabel\}/);
  assert.match(source, /h-12 w-12 rounded-xl inline-flex items-center justify-center/);
  assert.match(source, /border border-white\/80 bg-white text-black hover:bg-zinc-200/);
  assert.match(source, /border border-black bg-black text-white hover:bg-zinc-800/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /text-yellow-400/);
  assert.doesNotMatch(source, />\s*Refresh\s*<\/button>/);
  assert.doesNotMatch(source, /px-4 py-2 rounded-lg flex items-center gap-2/);
  assert.doesNotMatch(source, /text-blue-500/);
});
