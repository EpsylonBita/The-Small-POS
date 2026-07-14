import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'pages', 'OnboardingPage.tsx'),
  'utf8',
);

test('OnboardingPage uses touch-first yellow setup styling without mojibake', () => {
  assert.match(source, /text-yellow-300/);
  assert.match(source, /border-yellow-400 bg-yellow-400\/15 text-yellow-200/);
  assert.match(source, /focus-visible:ring-yellow-400/);
  assert.match(source, /focus:ring-yellow-400/);
  assert.match(source, /bg-yellow-400 text-black font-semibold/);
  assert.match(source, /rounded-3xl/);
  assert.match(source, /rounded-2xl/);
  assert.match(source, /defaultValue: 'Fran\\u00e7ais'/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|ring-blue-|focus:ring-blue/);
  assert.doesNotMatch(source, /FranÃ|Â|â|ð|�/);
});

test('OnboardingPage scroll container stays reachable when content overflows the viewport', () => {
  // Regression: after a factory reset the setup card + RecoveryPanel are taller
  // than short POS windows. The root used `justify-center` with no scroll, so the
  // header + first language options were clipped ABOVE the top edge and could not
  // be scrolled into view. The root must be a real scroll container.
  const rootMatch = source.match(/className="[^"]*flex h-full min-h-0 flex-col items-center[^"]*"/);
  assert.ok(rootMatch, 'expected the onboarding root container className to be present');
  const rootClass = rootMatch![0];

  // The root must scroll vertically...
  assert.match(rootClass, /overflow-y-auto/);
  // ...and must NOT use flex `justify-center` on the scroll container, because that
  // "unsafe" alignment clips overflow above the scroll origin and makes it unreachable.
  assert.doesNotMatch(rootClass, /justify-center/);
  // ...and must carry a deliberate scrollbar treatment so the native WebView2/Win95
  // rail (chunky track + arrow buttons) never shows on the onboarding shell.
  assert.match(rootClass, /modern-scrollbar|scrollbar-hide/);

  // Vertical centering (when content fits) is preserved with auto block-margins,
  // which collapse to 0 on overflow instead of pushing content out of reach.
  assert.match(source, /my-auto/);
});
