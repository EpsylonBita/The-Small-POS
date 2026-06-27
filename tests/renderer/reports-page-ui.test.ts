import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'pages', 'ReportsPage.tsx'),
  'utf8',
);

test('ReportsPage uses touch-first palette-safe controls and metric cards', () => {
  assert.match(source, /text-4xl font-bold mb-2/);
  assert.match(source, /border-yellow-400/);
  assert.match(source, /focus:ring-yellow-400/);
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.match(source, /bg-yellow-400 text-black/);
  assert.match(source, /bg-black text-white/);
  assert.match(source, /rounded-2xl/);
  assert.match(source, /h-screen overflow-y-auto scrollbar-hide p-6/);
  assert.match(source, /p-3 rounded-2xl/);
  assert.match(source, /color=\{isDark \? 'bg-yellow-400' : 'bg-black'\}/);
  assert.match(source, /color=\{isDark \? 'bg-zinc-700' : 'bg-zinc-800'\}/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|ring-blue-|from-blue-|to-blue-|shadow-blue/);
  assert.doesNotMatch(source, /bg-purple-|text-purple-|border-purple-|ring-purple-|from-purple-|to-purple|purple-600/);
});

test('ReportsPage keeps only MetricCard title props, not native DOM title tooltips', () => {
  const titleAttrs = source.match(/\btitle=/g) ?? [];
  assert.equal(titleAttrs.length, 4, 'ReportsPage should only keep the four MetricCard visible label props');
  assert.match(source, /<MetricCard[\s\S]*?title=\{t\('reports\.metrics\.totalOrders'\)\}/);
  assert.match(source, /<MetricCard[\s\S]*?title=\{t\('reports\.sales\.totalSales'\)\}/);
  assert.match(source, /<MetricCard[\s\S]*?title=\{t\('reports\.orders\.avgOrderValue'\)\}/);
  assert.match(source, /<MetricCard[\s\S]*?title=\{`\$\{t\('common\.status\.completed'\)\} Rate`\}/);

  const interactiveControls = source.match(/<(?:button|input|select|textarea)\b[\s\S]*?>/g) ?? [];
  for (const control of interactiveControls) {
    assert.doesNotMatch(control, /\btitle=/, 'interactive report controls must not use native title tooltips');
  }
});
