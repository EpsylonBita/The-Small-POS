import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liquidGlassModalTone } from '../../src/renderer/styles/designSystem';

const read = (path: string) => readFileSync(`src/renderer/${path}`, 'utf8');
const view = read('components/recovery/TillHealthWindow.tsx');
const styles = read('components/recovery/till-health.css');
const glass = read('styles/glassmorphism.css');

test('shared Health state and section tones use light and dark kit values', () => {
  for (const tone of ['neutral', 'success', 'warning', 'danger'] as const) {
    const classes = liquidGlassModalTone(tone);
    for (const prefix of ['bg', 'text', 'border']) {
      const neutralToken = new RegExp('(?:^|\\s)' + prefix + '-\\(--pos-s-');
      const light = new RegExp('(?:^|\\s)' + prefix + '-[^\\s]+');
      const dark = new RegExp('(?:^|\\s)dark:' + prefix + '-[^\\s]+');
      assert.ok(neutralToken.test(classes) || light.test(classes) && dark.test(classes));
    }
  }
});

test('Till health uses the shared frost and scrim, with opaque neutral interior cards', () => {
  assert.match(view, /liquid-glass-modal-shell till-health-window/);
  assert.match(view, /liquid-glass-modal-backdrop/);
  assert.doesNotMatch(view, /liquid-glass-modal-shell[^"]*bg-/);
  assert.match(styles, /color: var\(--pos-s-fg\)/);
  assert.match(styles, /\.till-health-card,\s*\.till-health-now,\s*\.till-health-help,\s*\.till-health-support\s*\{[^}]*background: var\(--pos-s-surface\)/);
  assert.match(glass, /\.dark \.liquid-glass-modal-shell\s*\{/);
});

test('Till health keeps raised buttons and the shared close control readable in both themes', () => {
  assert.match(view, /till-health-button pos-raised/);
  assert.match(view, /liquid-glass-modal-close/);
  assert.match(glass, /\.pos-raised\s*\{[^}]*background-color: var\(--pos-s-raised\)/);
  assert.match(glass, /\.pos-raised--yellow\s*\{[^}]*background-color: var\(--pos-s-yellow\); color: var\(--pos-s-yellow-fg\)/);
  assert.match(glass, /--pos-s-yellow:\s*#facc15;/);
  assert.match(glass, /--pos-s-yellow-fg:\s*#18181b;/);
});

test('Till health applies semantic colours to status words and the headline', () => {
  assert.match(view, /<h3 data-health-tone=\{tillHealthTone\(props\.state\)\}/);
  assert.match(view, /<strong data-health-tone=\{tone\}/);
  assert.match(view, /<Icon aria-hidden="true"/);
  for (const [tone, colors] of Object.entries({ok: ['#15803d','#4ade80'], warn: ['#b45309','#fbbf24'], bad: ['#b91c1c','#f87171']})) {
    assert.ok(styles.includes(`[data-health-tone='${tone}'] { color: var(--pos-s-${tone})`));
    for (const color of colors) assert.ok(glass.includes(`--pos-s-${tone}: ${color};`));
  }
  assert.match(view, /card\.family === 'wrongMoney' \|\| card\.family === 'courierMoney'/);
});

test('Till health has no state-coloured surface or hover utilities', () => {
  assert.doesNotMatch(view, /dark:(?:bg|text)-|hover:|uppercase tracking/);
  assert.doesNotMatch(styles, /background[^;]*(?:--pos-s-(?:warn|bad|ok)|#fda4af|#be123c)/);
  assert.match(styles, /\.till-health-row\s*\{[^}]*flex-wrap: wrap/);
});
