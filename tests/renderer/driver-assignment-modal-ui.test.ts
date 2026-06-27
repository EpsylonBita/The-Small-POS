import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'DriverAssignmentModal.tsx');

test('DriverAssignmentModal keeps assignment behavior with on-palette loading state', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /closeOnBackdrop=\{false\}/);
  assert.match(source, /bridge\.drivers\.getActive\(effectiveBranchId \|\| ''\)/);
  assert.match(source, /onDriverAssign\(driver\)/);
  assert.match(source, /toast\.success\(t\('modals\.driverAssignment\.assignedTo'/);
  assert.match(source, /toast\.error\(t\('modals\.driverAssignment\.notAvailable'/);
  assert.match(source, /border-b-2 border-yellow-400/);
  assert.match(source, /type="button"/);
});

test('DriverAssignmentModal has no legacy hover or blue loading chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue|blue-500|blue-600|blue-700/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});
