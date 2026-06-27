import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const orderSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
  'utf8',
);
const tablesSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TablesDashboard.tsx'),
  'utf8',
);
const floorPlanSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableFloorPlanView.tsx'),
  'utf8',
);

// Matches a useEffect whose body resets tableGridScrollRef.current.scrollTop to 0,
// capturing its dependency array so we can assert what re-triggers the reset.
const scrollResetEffect =
  /useEffect\(\(\)\s*=>\s*\{\s*const scrollTarget = tableGridScrollRef\.current;[\s\S]*?scrollTarget\.scrollTop = 0;[\s\S]*?\},\s*\[([^\]]*)\]\)/;

test('OrderDashboard resets the table-grid scroll region when the table filters/view change', () => {
  // The cleaning/status filter kept the previous scrollTop, clipping a single
  // filtered card under the fixed status/floor controls. A scroll-reset effect
  // keyed on the filter/view inputs fixes that.
  const match = orderSource.match(scrollResetEffect);
  assert.ok(match, 'OrderDashboard must reset tableGridScrollRef.current.scrollTop to 0 in a useEffect');

  const deps = match[1];
  for (const dep of ['tableStatusFilter', 'effectiveTableFloorFilter', 'tableViewMode']) {
    assert.ok(
      new RegExp(`\\b${dep}\\b`).test(deps),
      `the scroll-reset effect must depend on ${dep} (deps were: ${deps.trim()})`,
    );
  }
});

test('OrderDashboard does not reset scroll on every visible-card change (avoids fighting live updates)', () => {
  const match = orderSource.match(scrollResetEffect);
  assert.ok(match, 'scroll-reset effect not found');
  // Keying on the filtered card set would yank the scroll position whenever a
  // realtime table update arrives; the reset must be filter/view driven only.
  assert.doesNotMatch(match[1], /visibleTableCards|floorScopedTables/);
});

test('TablesDashboard resets the table-grid scroll region when the status/floor/view change', () => {
  const match = tablesSource.match(scrollResetEffect);
  assert.ok(match, 'TablesDashboard must reset tableGridScrollRef.current.scrollTop to 0 in a useEffect');

  const deps = match[1];
  for (const dep of ['filter', 'floorFilter', 'tableViewMode']) {
    assert.ok(
      new RegExp(`\\b${dep}\\b`).test(deps),
      `the scroll-reset effect must depend on ${dep} (deps were: ${deps.trim()})`,
    );
  }
});

test('the table-grid scroll containers and wheel handlers are still wired (no portal/scroll regression)', () => {
  // Sanity: the scroll ref must remain attached to the scroll container and the
  // wheel handler preserved, so the reset operates on the real overflow region.
  for (const source of [orderSource, tablesSource]) {
    assert.match(source, /ref=\{tableGridScrollRef\}/);
    assert.match(source, /onWheel=\{handleTableGridWheel\}/);
  }
});

test('TableFloorPlanView normalizes the layout so high-positioned tables start in view', () => {
  // The 2D floor plan opened blank when tables were positioned far from the origin
  // because bounds were sized from max X/Y only. It now uses the normalized layout
  // helper that translates the cluster to the padding origin.
  assert.match(floorPlanSource, /import \{[\s\S]*getTableFloorPlanLayout[\s\S]*\} from '\.\.\/\.\.\/utils\/tableFloorPlan';/);
  assert.match(floorPlanSource, /const layout = useMemo\(\(\) => getTableFloorPlanLayout\(tables\), \[tables\]\)/);
  assert.match(floorPlanSource, /const bounds = layout\.bounds/);
  assert.match(floorPlanSource, /layout\.nodes\.map\(/);
  // The pre-normalization bounds-only helper is no longer used here.
  assert.doesNotMatch(floorPlanSource, /getTableFloorPlanBounds\(/);
  assert.doesNotMatch(floorPlanSource, /resolveTableFloorPlanNode\(/);
});

test('TableFloorPlanView resets its own inner scroll when the visible table set changes', () => {
  // Belt-and-suspenders alongside normalization: the inner overflow-auto container
  // returns to the top-left on mount and whenever the layout/table set changes, so
  // switching to 2D or changing filters never shows a blank scrolled-away grid.
  assert.match(floorPlanSource, /const scrollRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(floorPlanSource, /const layoutSignature = useMemo\(/);
  const effect = floorPlanSource.match(
    /useEffect\(\(\) => \{\s*const el = scrollRef\.current;[\s\S]*?\},\s*\[([^\]]*)\]\)/,
  );
  assert.ok(effect, 'TableFloorPlanView must reset its scroll container in a useEffect');
  assert.match(effect[0], /el\.scrollTop = 0;/);
  assert.match(effect[0], /el\.scrollLeft = 0;/);
  assert.match(effect[1], /layoutSignature/);
  // The ref is attached to the overflow-auto scroll container.
  assert.match(floorPlanSource, /ref=\{scrollRef\}[\s\S]*?overflow-auto/);
});
