import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'ui', 'ConfirmDialog.tsx'),
  'utf8',
);

test('ConfirmDialog keeps shared confirmation modals on the yellow glass palette in both themes and touch-first', () => {
  assert.doesNotMatch(source, /hover:/);
  // Yellow is the app's primary/attention hue (designSystem liquidGlassModalButton('primary'));
  // red and emerald stay semantic. Cool and off-palette hues stay out.
  assert.doesNotMatch(source, /cyan-|blue-|purple-|orange-|sky-|indigo-|violet-|fuchsia-|pink-/);
  assert.doesNotMatch(source, /focus:ring-cyan/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /rounded-md/);

  // 03/08/2026: info/warning moved from dark-only amber to yellow with a light and a dark
  // shade, and the tinted icon bubble went away (ConfirmDialog.theme.test.tsx pins the
  // rendered states). Each variant colours its icon and its checkbox in both themes.
  for (const variant of ['info', 'warning']) {
    assert.match(
      source,
      new RegExp(
        `${variant}: \\{[^}]*color: 'text-yellow-700 dark:text-yellow-300'[^}]*`
          + `checkboxColor: 'text-yellow-600 focus:ring-yellow-500/70 dark:text-yellow-400'`,
      ),
      `${variant} must use the theme-aware yellow icon and checkbox`,
    );
  }
  assert.match(
    source,
    /error: \{[^}]*color: 'text-red-600 dark:text-red-400'[^}]*checkboxColor: 'text-red-600 focus:ring-red-500\/70 dark:text-red-400'/,
  );
  assert.match(
    source,
    /success: \{[^}]*color: 'text-emerald-700 dark:text-emerald-400'[^}]*checkboxColor: 'text-emerald-600 focus:ring-emerald-500\/70 dark:text-emerald-400'/,
  );
  assert.doesNotMatch(source, /bgIcon/);

  // Touch-first confirmation checkbox row: tall, smooth radius, press feedback; the box itself
  // is readable on the light and the dark glass.
  assert.match(source, /min-h-\[52px\][^"]*rounded-2xl[^"]*active:scale-\[0\.99\]/);
  assert.match(
    source,
    /'h-5 w-5 rounded-xl border-slate-400 bg-white focus:ring-2 focus:ring-offset-0 dark:border-white\/30 dark:bg-black\/40'/,
  );
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /ariaLabel=\{title\}/);
});
