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
