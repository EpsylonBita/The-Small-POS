import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 175 + 178 (touch-first, live QA): the visible collapsed SyncStatusIndicator controls (heart/
// status button, offline retry button, capacity-warning badge) used native DOM `title` tooltips and
// hover-only styles -- cleaned in round 175. Round 178 then cleaned the detail-modal controls too, so
// the POS-wide touchscreen-first rule now holds across the whole file (aria-label + `active:` press
// feedback). The collapsed-block tests below stay block-scoped; the final test asserts no native
// title or hover utility remains anywhere in the component.

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'SyncStatusIndicator.tsx'),
  'utf8',
);

// The collapsed render: from the heart-icon comment to the point where the detail modal is invoked
// via renderDetailModal(). This deliberately excludes the modal body (defined elsewhere).
function collapsedRenderBlock(): string {
  const start = source.indexOf('{/* Heart Icon Status Indicator */}');
  assert.notEqual(start, -1, 'collapsed render heart-icon marker should exist');
  const end = source.indexOf('{showDetailPanel && renderDetailModal()}', start);
  assert.notEqual(end, -1, 'collapsed render should end at the renderDetailModal() invocation');
  return source.slice(start, end);
}

test('SyncStatusIndicator collapsed controls have no native title and no hover utilities', () => {
  const block = collapsedRenderBlock();

  assert.doesNotMatch(block, /\btitle=/, 'collapsed controls must not use native title tooltips');
  assert.doesNotMatch(block, /hover:/, 'collapsed controls must not use hover utilities');
  assert.doesNotMatch(block, /group-hover:/);
});

test('SyncStatusIndicator collapsed controls expose accessible labels with active press feedback', () => {
  const block = collapsedRenderBlock();

  // Heart/status button: accessible name from getStatusText(); click-to-open preserved; active press.
  assert.match(block, /aria-label=\{getStatusText\(\)\}/);
  assert.match(block, /onClick=\{\(\) => setShowDetailPanel\(!showDetailPanel\)\}/);
  assert.match(block, /active:bg-slate-100\/80 dark:active:bg-white\/10/);

  // Offline retry button: aria-label, disabled/spin/click behavior preserved, active press.
  assert.match(block, /aria-label=\{t\('sync\.actions\.retry', \{ defaultValue: 'Retry sync' \}\)\}/);
  assert.match(block, /onClick=\{handleForceSync\}/);
  assert.match(block, /disabled=\{syncStatus\.syncInProgress\}/);
  assert.match(block, /active:bg-red-500\/20/);

  // Capacity-warning badge: aria-label, click-to-open preserved, warning color + active press kept.
  assert.match(block, /aria-label=\{t\('sync\.capacity\.title', \{ defaultValue: 'Sync backlog growing' \}\)\}/);
  assert.match(block, /onClick=\{\(\) => setShowDetailPanel\(true\)\}/);
  assert.match(block, /text-orange-600 transition-colors active:bg-orange-500\/15 dark:text-orange-300/);
});

// Round 178 (touch-first): the detail-modal controls have now been cleaned too (Round 175 had
// scoped only the collapsed controls). The WHOLE file must now be free of native title tooltips and
// hover utilities, while every detail-modal handler and the semantic colors stay intact.
test('SyncStatusIndicator has no native title or hover utilities anywhere, detail handlers intact', () => {
  // No native browser tooltip and no hover utilities anywhere in the component.
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);

  // The financial refresh button now uses aria-label (not title) and keeps its icon.
  assert.match(source, /aria-label=\{t\('sync\.actions\.refresh', \{ defaultValue: 'Refresh' \}\)\}/);
  assert.match(source, /<RefreshCw className="h-4 w-4" \/>/);

  // Detail-modal control handlers are unchanged (UI-only pass, no logic touched).
  assert.match(source, /onClick=\{handleOpenRecovery\}/);
  assert.match(source, /onClick=\{handleRetryBlockedOrder\}/);
  assert.match(source, /onClick=\{\(\) => setShowFinancialPanel\(true\)\}/);
  assert.match(source, /onClick=\{handleRemoveInvalidOrders\}/);
  assert.match(source, /onClick=\{handleExport\}/);
  assert.match(source, /onClick=\{handleOpenExportDir\}/);

  // The nonsemantic blue retry button now uses the app primary yellow/black treatment.
  assert.match(source, /bg-yellow-400 px-4 py-2\.5 text-sm font-semibold text-black transition-all active:bg-yellow-500/);
  // Semantic destructive (red) and success (emerald) colors are preserved with active feedback.
  assert.match(source, /bg-red-600 px-4 py-2\.5 text-sm font-semibold text-white transition-colors active:bg-red-700/);
  assert.match(source, /active:bg-emerald-100/);
});
