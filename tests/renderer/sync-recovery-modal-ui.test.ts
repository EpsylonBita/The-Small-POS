import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file: string) => readFileSync('src/renderer/components/' + file, 'utf8');

test('Till health uses a single neutral scrolling glass window without a footer', () => {
  const window = read('recovery/TillHealthWindow.tsx');
  const css = read('recovery/till-health.css');
  assert.match(window, /liquid-glass-modal-shell till-health-window/);
  assert.equal((window.match(/liquid-glass-modal-close/g) ?? []).length, 1);
  assert.match(css, /\.till-health-body\s*\{[^}]*overflow: auto/);
  assert.doesNotMatch(window, /<footer|hover:/);
  const elements = ['till-health-headline', 'props.cards.map', 'till-health-now', 'till-health-help', 'till-health-support-toggle'];
  const positions = elements.map(element => window.indexOf(element));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
});

test('Till health keeps scoped observation, order navigation and one persisted history entry per attempt', () => {
  const indicator = read('SyncStatusIndicator.tsx');
  const actions = read('recovery/useTillHealthActions.tsx');
  assert.match(indicator, /readId !== healthReadId\.current/);
  assert.match(indicator, /setHealthAvailability\(systemLoaded\.current \? 'stale' : 'unavailable'\)/);
  assert.match(indicator, /OPEN_TILL_HEALTH, open/);
  assert.match(actions, /const attemptId = /);
  assert.match(actions, /recordActionLog\(entry\)/);
  assert.match(actions, /if \(verifiedChange && routeTarget\)/);
});
