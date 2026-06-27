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

test('ComboChoiceModal uses yellow selection, green add-to-cart, and tap feedback', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /border-green-500\/70 bg-green-600 text-white active:scale-\[0\.98\] active:bg-green-700/);
  assert.match(source, /border-yellow-400\/70 bg-yellow-400\/12/);
  assert.match(source, /border-yellow-500\/70 bg-yellow-50/);
  assert.match(source, /bg-yellow-400\/14/);
  assert.match(source, /border-2 border-yellow-400 border-t-transparent/);
  assert.match(source, /active:scale-\[0\.99\]/);
  assert.match(source, /type="button"/);
});

test('ComboChoiceModal has no legacy hover, blue, or small-radius chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue|blue-500|blue-600|blue-700/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg|bg-gray-750/);
});
