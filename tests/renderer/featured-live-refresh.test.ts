import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

// The founder's requirement: the Featured tab must follow the day's sales as
// they happen, continuously replacing items — not once per 6-hour block.

test('featured ranking refresh throttle is minutes, not hours', () => {
  const source = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'hooks', 'useFeaturedItems.ts'),
    'utf8',
  );

  assert.match(
    source,
    /REFRESH_INTERVAL_MS = 10 \* 60 \* 1000/,
    'event-driven refreshes must be throttled to ~10 minutes so the ranking follows service waves',
  );
  assert.doesNotMatch(
    source,
    /60 \* 60 \* 1000/,
    'an hour-scale throttle would freeze the Featured ranking for whole service periods',
  );
});

test('opening the order menu re-checks the featured ranking', () => {
  const source = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'),
    'utf8',
  );

  assert.match(
    source,
    /refresh:\s*refreshFeaturedItems/,
    'MenuModal must take the refresh handle from useFeaturedItems',
  );
  assert.match(
    source,
    /if \(!isOpen\) return;[\s\S]{0,400}refreshFeaturedItems\(\)/,
    'MenuModal must refresh the featured ranking when the menu opens (staleness-guarded)',
  );
});
