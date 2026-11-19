import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync('src/renderer/components/' + file, 'utf8');
const indicator = read('SyncStatusIndicator.tsx');
const window = read('recovery/TillHealthWindow.tsx');
const support = read('recovery/TillHealthSupport.tsx');
const style = read('recovery/till-health.css');

function collapsedRenderBlock() {
  const start = indicator.indexOf('className={' + String.fromCharCode(96) + 'till-health-launcher');
  const end = indicator.indexOf('{showDetailPanel && <TillHealthWindow', start);
  assert.ok(start >= 0 && end > start, 'the launcher and capacity warning precede the shared window');
  return indicator.slice(start, end);
}

test('Till health collapsed controls use no native title or hover utility', () => {
  assert.doesNotMatch(collapsedRenderBlock(), /\btitle=|hover:|group-hover:/);
});

test('The rail controls have accessible names, touch feedback and one state source', () => {
  const collapsed = collapsedRenderBlock();
  assert.match(collapsed, /aria-label=.*tillHealth\.title.*tillHealth\.states/);
  assert.match(collapsed, /aria-haspopup="dialog"/);
  assert.match(collapsed, /if \(showDetailPanel\) closeHealth\(\); else \{[\s\S]*?setShowDetailPanel\(true\)/);
  assert.match(indicator, /onHealthState\?\.\(state\)/);
  assert.match(window, /data-health-tone=\{tillHealthTone\(props\.state\)\}/);
  assert.match(style, /button\.till-health-launcher:active/);
  assert.match(collapsed, /aria-label=\{t\('tillHealth\.capacity'\)\}/);
  assert.match(collapsed, /active:bg-\(--pos-s-surface-2\)/);
});

test('Till health moves technical controls behind support and preserves their handlers', () => {
  assert.doesNotMatch(indicator + window, /\btitle=|hover:|group-hover:/);
  assert.match(indicator, /onClick=\{\(\) => void handleForceSync\(\)\} disabled=\{syncStatus\.syncInProgress\}/);
  assert.match(indicator, /onClick=\{\(\) => setShowFinancialPanel\(true\)\}/);
  assert.match(window, /onClick=\{props\.onRefresh\}/);
  assert.match(support, /onClick=\{\(\) => onOpenCopy\(/);
  assert.match(support, /onClick=\{\(\) => onIssueAction\(issue, action\)\}/);
  assert.match(indicator, /support=\{<TillHealthSupport/);
  assert.match(window, /supportOpen && props\.support/);
  assert.match(window, /primary \? 'pos-raised--yellow'/);
  assert.doesNotMatch(indicator, /handleRetryBlockedOrder|handleRemoveInvalidOrders|bridge\.sync\.removeInvalidOrders/);
});
