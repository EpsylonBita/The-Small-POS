import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'DeliveryPage.tsx'),
  'utf8',
);

test('DeliveryPage refresh uses amber glass and no native title tooltip', () => {
  assert.match(source, /onClick=\{handleRefresh\}/);
  assert.match(source, /disabled=\{isRefreshing\}/);
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.doesNotMatch(source, /\btitle=/);
  assert.match(source, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(source, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
});

test('DeliveryPage is touch-first with smooth rounded controls', () => {
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /bg-purple|text-purple|border-purple|ring-purple/);
  assert.match(source, /flex items-center gap-1\.5 px-2\.5 py-1 rounded-2xl text-xs font-medium/);
  assert.match(source, /px-2 py-0\.5 rounded-full text-xs font-medium/);
  assert.match(source, /flex items-center gap-2 mb-3 px-3 py-2 rounded-2xl/);
  assert.match(source, /p-2 rounded-2xl inline-flex items-center justify-center transition-transform/);
  assert.match(source, /flex-1 px-3 py-2 rounded-2xl text-sm font-medium transition-transform active:scale-\[0\.98\]/);
});

test('DeliveryPage driver assignment modal keeps accessible close and hidden scrollbars', () => {
  assert.match(source, /<DriverAssignmentModal\s+isOpen=\{showAssignModal\}/);
  assert.match(source, /delivery=\{selectedDelivery\}/);
  assert.match(source, /aria-label=\{t\('common\.close', 'Close'\)\}/);
  assert.match(source, /className="flex-1 overflow-y-auto scrollbar-hide p-4"/);
  assert.match(source, /onClick=\{onClose\}/);
  assert.match(source, /onClick=\{handleAssign\}/);
});
