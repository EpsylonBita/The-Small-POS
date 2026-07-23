import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

test('order menu Featured tab ranks the full seven-day window', () => {
  const source = readFileSync(
    path.join(
      projectRoot,
      'src',
      'renderer',
      'components',
      'modals',
      'MenuModal.tsx',
    ),
    'utf8',
  );

  assert.match(
    source,
    /useFeaturedItems\(staff\?\.branchId \|\| null,\s*\{\s*strategy:\s*['"]weekly['"]/s,
    'the order menu must use the weekly ranking directly instead of prioritizing only today',
  );
  assert.doesNotMatch(
    source,
    /strategy:\s*['"]daily_then_weekly['"]/,
    'daily-first ranking can displace the actual most-used items from the week',
  );
});
