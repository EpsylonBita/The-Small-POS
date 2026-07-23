import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const updaterHookPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'hooks',
  'useAutoUpdater.ts',
);

test('auto updater checks after startup and periodically for long-running terminals', () => {
  const source = readFileSync(updaterHookPath, 'utf8');

  assert.match(source, /const AUTO_UPDATE_STARTUP_DELAY_MS = 5_000;/);
  assert.match(source, /const AUTO_UPDATE_INTERVAL_MS = 4 \* 60 \* 60 \* 1000;/);
  assert.match(source, /if \(!hydrated\) return;/);
  assert.match(source, /const runAutomaticCheck = \(\) => \{/);
  assert.match(source, /void bridge\.updates\.check\(\);/);
  assert.match(
    source,
    /window\.setTimeout\(\s*runAutomaticCheck,\s*AUTO_UPDATE_STARTUP_DELAY_MS,\s*\)/,
  );
  assert.match(
    source,
    /window\.setInterval\(\s*runAutomaticCheck,\s*AUTO_UPDATE_INTERVAL_MS,\s*\)/,
  );
  assert.match(source, /window\.clearTimeout\(startupTimer\);/);
  assert.match(source, /window\.clearInterval\(periodicTimer\);/);
});

test('automatic checks do not interrupt an active or actionable update', () => {
  const source = readFileSync(updaterHookPath, 'utf8');

  assert.match(source, /const latestStateRef = useRef\(state\);/);
  assert.match(source, /latestStateRef\.current = state;/);
  assert.match(source, /const latestState = latestStateRef\.current;/);
  assert.match(
    source,
    /latestState\.checking[\s\S]*latestState\.available[\s\S]*latestState\.downloading[\s\S]*latestState\.ready[\s\S]*latestState\.installPending[\s\S]*latestState\.installingVersion/,
  );
});
