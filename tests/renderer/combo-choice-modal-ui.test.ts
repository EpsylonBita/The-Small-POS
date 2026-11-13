import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'ComboChoiceModal.tsx');

test('ComboChoiceModal keeps the glass shell, hidden scrollbars, and combo confirmation flow', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /import \{ LiquidGlassModal \} from '\.\.\/ui\/pos-glass-components'/);
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /contentClassName="max-h-\[60vh\] overflow-y-auto p-4 scrollbar-hide"/);
  assert.match(source, /const chosenItems: ChosenComboItem\[\] = comboItems\.map/);
  assert.match(source, /onConfirm\(combo, chosenItems\)/);
  assert.match(source, /handleSelectItem\(index, item, menuItem\)/);
});

// founder 11/11/2026: frost/depth replaces the former flat selected surfaces.
test('ComboChoiceModal uses frosted choices, yellow selection, solid add-to-cart, and tap depth', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /border-\(--pos-s-yellow\) bg-\(--pos-s-yellow\) text-black active:scale-\[0\.98\] active:bg-yellow-500/);
  // Wave ΣΤ8b: a chosen dropdown is an fg line, not yellow.
  assert.match(source, /bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\) border-\(--pos-s-sel-bg\)/); // founder 31/10: selection = the yellow kit sel
  assert.doesNotMatch(source, /'border-\(--pos-s-yellow\) bg-\(--pos-s-surface-2\)'/);
  assert.match(source, /pos-glass-form-card p-3!/);
  assert.match(source, /border-2 border-yellow-400 border-t-transparent/);
  assert.match(source, /pos-glass-field min-h-touch flex w-full/);
  assert.match(source, /pos-glass-tap-card liquid-glass-modal-text/);
  const css = readFileSync(path.join(projectRoot, 'src/renderer/styles/glassmorphism.css'), 'utf8');
  assert.match(css, /\.pos-glass-tap-card:is\(:active, \[data-pressed\]\):not\(:disabled\)[\s\S]*?translate: 0 1px/);
  assert.match(source, /type="button"/);
});

test('ComboChoiceModal has no legacy hover, blue, or small-radius chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue|blue-500|blue-600|blue-700/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg|bg-gray-750/);
});
