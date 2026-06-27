import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(
    process.cwd(),
    'src',
    'renderer',
    'components',
    'recovery',
    'SyncRecoveryModal.tsx',
  ),
  'utf8',
);

test('SyncRecoveryModal shell is amber/neutral, touch-first, and hides native scrollbars', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(source, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-lg/);

  assert.match(source, /liquid-glass-modal-shell/);
  assert.match(source, /overflow-y-auto scrollbar-hide/);
  assert.match(source, /border-amber-200\/90 bg-amber-50\/90/);
  assert.match(source, /dark:border-amber-400\/30 dark:bg-amber-500\/10/);
  assert.match(source, /border-4 border-amber-500\/30 border-t-amber-500/);
  assert.match(source, /min-h-\[44px\][\s\S]*active:scale-\[0\.98\]/);
  assert.match(source, /min-h-\[44px\] min-w-\[44px\] rounded-2xl/);
});

test('SyncRecoveryModal keeps recovery loading, navigation, and panel wiring unchanged', () => {
  assert.match(source, /void loadRecoveryState\(\)/);
  assert.match(source, /disabled=\{loading\}/);
  assert.match(source, /onClick=\{handleOpenSnapshots\}/);
  assert.match(source, /onClick=\{onClose\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.close'/);
  assert.match(source, /<RecoveryCenterPanel/);
  assert.match(source, /issues=\{issueResult\.issues\}/);
  assert.match(source, /recentActions=\{recentActions\}/);
  assert.match(source, /terminalContext=\{systemHealth\?\.terminalContext \?\? null\}/);
  assert.match(source, /onRefresh=\{loadRecoveryState\}/);
  assert.match(source, /onNavigate=\{onClose\}/);
  assert.match(source, /setRecentActions\(\(current\) => \[entry, \.\.\.current\]\.slice\(0, 8\)\)/);
});
