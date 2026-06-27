import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const driveThruPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'pages',
  'verticals',
  'fast-food',
  'DriveThruView.tsx',
);

const source = readFileSync(driveThruPath, 'utf8');

test('DriveThruView uses touch-first controls with on-palette chrome', () => {
  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /purple|cyan|sky|indigo|violet|pink/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /text-\$\{config\.color\}-500/);
  assert.doesNotMatch(source, /←|→|â/);

  assert.match(source, /iconClass: 'text-amber-500'/);
  assert.match(source, /const panelSurface = isDark/);
  assert.match(source, /const secondaryButtonSurface = isDark/);
  assert.match(source, /const primaryButtonSurface = isDark/);
  assert.match(source, /className=\{`rounded-2xl p-3 transition-transform active:scale-95 \$\{secondaryButtonSurface\}`\}/);
  assert.match(source, /className=\{`flex flex-1 items-center justify-center gap-1 rounded-2xl py-1\.5 text-xs font-semibold transition-transform active:scale-95 \$\{primaryButtonSurface\}`\}/);
  assert.match(source, /scrollbar-hide/);
  assert.match(source, /aria-label=\{t\('common\.actions\.refresh', 'Refresh'\)\}/);
  assert.match(source, /aria-label=\{\s*soundEnabled/);
  assert.match(source, /<ChevronLeft className="h-3\.5 w-3\.5" \/>/);
  assert.match(source, /<ChevronRight className="h-3\.5 w-3\.5" \/>/);
});

test('DriveThruView keeps user-facing labels translation-ready', () => {
  assert.match(source, /t\('driveThru\.activeOrders', 'Active Orders'\)/);
  assert.match(source, /t\('driveThru\.avgWaitTime', 'Avg Wait Time'\)/);
  assert.match(source, /t\('driveThru\.activeLanes', 'Active Lanes'\)/);
  assert.match(source, /t\(`driveThru\.stage\.\$\{stage\}`, config\.label\)/);
  assert.match(source, /t\('common\.customer', 'Customer'\)/);
  assert.match(source, /t\('common\.item', 'item'\)/);
  assert.match(source, /t\('common\.items', 'items'\)/);
  assert.match(source, /t\('driveThru\.ordersServedToday'/);
  assert.match(source, /t\('driveThru\.emptyHint', 'Orders will appear here when customers arrive'\)/);
});
