import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'hotel', 'HousekeepingView.tsx'),
  'utf8',
);

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

test('Round 369: HousekeepingView renders the standard visible page title above its controls', () => {
  assert.match(
    viewSource,
    /<h1 className=\{`truncate text-3xl font-bold tracking-tight \$\{isDark \? 'text-white' : 'text-gray-900'\}`\}>\s*\{t\('navigation\.menu\.housekeeping', \{ defaultValue: 'Housekeeping' \}\)\}\s*<\/h1>/,
  );
  assert.match(
    viewSource,
    /data-vertical-hero="housekeeping"[\s\S]*rounded-3xl border p-4 backdrop-blur-xl[\s\S]*navigation\.menu\.housekeeping[\s\S]*housekeepingView\.stats\.totalTasks/,
    'Housekeeping title and stats should live in the same rounded glass hero',
  );
  assert.ok(
    viewSource.indexOf('navigation.menu.housekeeping') < viewSource.indexOf('housekeepingView.stats.totalTasks'),
    'Housekeeping page title must render before the stats/control row',
  );
});

test('HousekeepingView localizes toasts and the average-time unit', () => {
  assert.match(viewSource, /t\('housekeepingView\.toasts\.loadFailed'/);
  assert.match(viewSource, /t\('housekeepingView\.toasts\.updateFailed'/);
  assert.match(viewSource, /t\('housekeepingView\.toasts\.assignFailed'/);
  assert.match(viewSource, /\{avgCompletionTime\} \{t\('common\.minutes', 'min'\)\}/);

  // The bare literal usages are gone (the English only survives inside t() defaultValue).
  assert.doesNotMatch(viewSource, /: 'Failed to update task'\)/);
  assert.doesNotMatch(viewSource, /: 'Failed to assign staff'\)/);
  assert.doesNotMatch(viewSource, /\{avgCompletionTime\}\{t\('common\.minutes'/);
  assert.doesNotMatch(viewSource, /\{avgCompletionTime\}min</);
});

test('HousekeepingView shows a localized empty state instead of a dead board', () => {
  // When there are no tasks the board renders an explanatory empty state rather
  // than four blank columns.
  assert.match(viewSource, /filteredTasks\.length === 0 \? \(/);
  assert.match(viewSource, /t\('housekeepingView\.empty\.title'/);
  assert.match(viewSource, /t\('housekeepingView\.empty\.description'/);
  // The empty state still offers a working action (refresh).
  assert.match(viewSource, /onClick=\{handleRefresh\}[\s\S]*housekeepingView\.empty\.description|housekeepingView\.empty\.description[\s\S]*onClick=\{handleRefresh\}/);
});

test('HousekeepingView surfaces cleaning rooms as fallback tasks from shared Rooms data', () => {
  assert.match(viewSource, /import \{ useRooms \} from '\.\.\/\.\.\/\.\.\/hooks\/useRooms';/);
  assert.match(viewSource, /import \{ useResolvedPosIdentity \} from '\.\.\/\.\.\/\.\.\/hooks\/useResolvedPosIdentity';/);
  assert.match(viewSource, /useResolvedPosIdentity\('branch\+organization'\)/);
  assert.match(viewSource, /buildHousekeepingFallbackTasks\(rooms, tasks\)/);
  assert.match(viewSource, /const allTasks = useMemo\(\(\) => \[\.\.\.tasks, \.\.\.fallbackTasks\]/);
  // Stats/filters/empty-state operate on the combined list, so cleaning rooms
  // count in the total and hide the "no tasks" empty state.
  assert.match(viewSource, /return allTasks\.filter\(\(task\) =>/);
  assert.doesNotMatch(viewSource, /return tasks\.filter\(\(task\) => \{/);
  assert.match(viewSource, /completedToday[\s\S]*?allTasks\.filter/);
});

test('HousekeepingView fetchTasks is compatible with both fixed and old admin status=all contracts', () => {
  const fetchFn = viewSource.match(/const fetchTasks = useCallback\(async \(options[\s\S]*?\}, \[\]\);/);
  assert.ok(fetchFn, 'fetchTasks not found');

  // Prefers ?status=all so a fixed admin API returns every status.
  assert.match(fetchFn[0], /let result = await requestHousekeeping\('\?status=all'\);/);
  // On a successful-but-empty all-status response (an OLD admin API matches "all"
  // literally means zero rows), it retries the no-status endpoint and adopts its active
  // tasks if present, so a freshly created task surfaces and fallback rows dedupe away.
  assert.match(fetchFn[0], /if \(result\.ok && result\.tasks\.length === 0\) \{/);
  assert.match(fetchFn[0], /const activeOnly = await requestHousekeeping\(''\);/);
  assert.match(fetchFn[0], /if \(activeOnly\.ok && activeOnly\.tasks\.length > 0\) \{/);

  // The shared helper builds the path and normalizes the browser/desktop envelopes.
  assert.match(fetchFn[0], /const path = `\/api\/pos\/housekeeping\$\{pathSuffix\}`;/);
  assert.match(fetchFn[0], /const ok = Boolean\(response\.success\) && Boolean\(response\.data\?\.success\);/);
  // It must still hit the all-status endpoint first (don't silently drop completed/verified
  // support on fixed APIs by only ever calling the no-status endpoint).
  assert.match(fetchFn[0], /requestHousekeeping\('\?status=all'\)/);
});

test('HousekeepingView never sends a synthetic fallback id to the task update/assign APIs', () => {
  const statusFn = viewSource.match(/const handleStatusChange = useCallback\(async \(taskId[\s\S]*?\}, \[\]\);/);
  assert.ok(statusFn, 'handleStatusChange not found');
  assert.match(statusFn[0], /if \(isFallbackTaskId\(taskId\)\) return;/);
  // The guard must precede any API/offline mutation call.
  assert.ok(
    statusFn[0].indexOf('isFallbackTaskId') < statusFn[0].indexOf('posApiPatch'),
    'fallback guard must run before the status API call',
  );

  const assignFn = viewSource.match(/const handleAssignStaff = useCallback\(async \(taskId[\s\S]*?\}, \[staff\]\);/);
  assert.ok(assignFn, 'handleAssignStaff not found');
  assert.match(assignFn[0], /if \(isFallbackTaskId\(taskId\)\) return;/);
  assert.ok(
    assignFn[0].indexOf('isFallbackTaskId') < assignFn[0].indexOf('posApiPatch'),
    'fallback guard must run before the assign API call',
  );
});

test('HousekeepingView status transitions apply shared timestamp semantics and record an optimistic override', () => {
  const statusFn = viewSource.match(/const handleStatusChange = useCallback\(async \(taskId[\s\S]*?\}, \[\]\);/);
  assert.ok(statusFn, 'handleStatusChange not found');

  // The optimistic local update now goes through the shared applyStatusTransition helper
  // (unit-tested in housekeeping-fallback.test.ts) so Completed Today / average completion
  // time reflect the change immediately and stay consistent with the fetch merge layer.
  assert.match(statusFn[0], /const now = new Date\(\)\.toISOString\(\);/);
  assert.match(statusFn[0], /const priorTask = tasksRef\.current\.find\(\(task\) => task\.id === taskId\);/);
  assert.match(statusFn[0], /applyStatusTransition\(priorTask, status, now\)/);

  // It records the optimistic transition so a refetch while the offline mutation is still
  // syncing cannot regress it back to the stale admin status (the live defect).
  assert.match(
    statusFn[0],
    /statusOverridesRef\.current\.set\(taskId, toHousekeepingStatusOverride\(nextTask\)\)/,
  );

  // The fallback guard still precedes the API call (synthetic ids never PATCHed).
  assert.ok(
    statusFn[0].indexOf('isFallbackTaskId') < statusFn[0].indexOf('posApiPatch'),
    'fallback guard must run before the status API call',
  );
  // The old timestamp-blind single-line update is gone.
  assert.doesNotMatch(statusFn[0], /\? \{ \.\.\.task, status, updated_at: new Date\(\)\.toISOString\(\) \} :/);
  // The inline timestamp block was extracted into applyStatusTransition (no duplication here).
  assert.doesNotMatch(statusFn[0], /const next: HousekeepingTask = \{ \.\.\.task, status, updated_at: now \};/);
});

// Regression contract for the live refresh-after-local-status-change defect (2026-06-21):
// a refetch while sync was unhealthy overwrote the optimistic in_progress/completed/verified
// transition with the stale admin row. The view must merge pending overrides on every fetch.
test('HousekeepingView re-applies pending status overrides on fetch so a refresh cannot regress a local transition', () => {
  // The override store + tasks-mirror ref exist.
  assert.match(viewSource, /const statusOverridesRef = useRef<Map<string, HousekeepingStatusOverride>>\(new Map\(\)\);/);
  assert.match(viewSource, /const tasksRef = useRef<HousekeepingTask\[\]>\(\[\]\);/);
  assert.match(viewSource, /useEffect\(\(\) => \{\s*tasksRef\.current = tasks;\s*\}, \[tasks\]\);/);

  const fetchFn = viewSource.match(/const fetchTasks = useCallback\(async \(options[\s\S]*?\}, \[\]\);/);
  assert.ok(fetchFn, 'fetchTasks not found');

  // The fetched admin list is merged with pending optimistic overrides before it hits state.
  assert.match(
    fetchFn[0],
    /applyHousekeepingStatusOverrides\(\s*result\.tasks,\s*statusOverridesRef\.current,\s*tasksRef\.current,?\s*\)/,
  );
  // Overrides the server has caught up to are pruned.
  assert.match(fetchFn[0], /for \(const id of resolved\) \{\s*statusOverridesRef\.current\.delete\(id\);\s*\}/);
  // State is set from the MERGED list, never the raw admin list (the regression source).
  assert.match(fetchFn[0], /setTasks\(mergedTasks\);/);
  assert.doesNotMatch(fetchFn[0], /setTasks\(result\.tasks\)/);
});

test('HousekeepingView omits task-only controls for fallback rows and shows a localized hint', () => {
  assert.match(viewSource, /task\.isFallback \? \(/);
  assert.match(viewSource, /t\('housekeepingView\.fallbackHint'/);
});

test('HousekeepingView fallback rows expose a localized create-task action', () => {
  // The fallback branch is no longer a dead end: it offers a Create task button
  // (localized) wired to handleCreateTask, alongside the explanatory hint.
  assert.match(viewSource, /onClick=\{\(\) => handleCreateTask\(task\)\}/);
  assert.match(viewSource, /t\('housekeepingView\.action\.createTask'/);
  const fallbackBranch = viewSource.match(/task\.isFallback \? \([\s\S]*?\) : \(/);
  assert.ok(fallbackBranch, 'fallback branch not found');
  assert.match(fallbackBranch[0], /handleCreateTask\(task\)/, 'create-task button must live in the fallback branch');
  assert.match(fallbackBranch[0], /housekeepingView\.action\.createTask/);
  assert.match(fallbackBranch[0], /housekeepingView\.fallbackHint/, 'the hint stays alongside the new action');
});

test('HousekeepingView create-task path creates a REAL task without sending the synthetic id', () => {
  const createFn = viewSource.match(/const handleCreateTask = useCallback\(async \(task[\s\S]*?\}, \[fetchTasks\]\);/);
  assert.ok(createFn, 'handleCreateTask not found');

  // Only acts on synthetic fallback rows that map to a real room.
  assert.match(createFn[0], /if \(!isFallbackTaskId\(task\.id\) \|\| !task\.room_id\) return;/);

  // The create payload uses the real room id + a concrete task_type enum, and must
  // NOT carry the synthetic fallback id (no "fallback:<roomId>" reaches the server).
  const bodyBlock = createFn[0].match(/const body = \{[\s\S]*?\};/);
  assert.ok(bodyBlock, 'create body not found');
  assert.match(bodyBlock[0], /room_id: task\.room_id/);
  assert.match(bodyBlock[0], /task_type: 'checkout_clean'/);
  assert.doesNotMatch(bodyBlock[0], /task\.id/, 'the synthetic id must never be in the create payload');

  // Creation is a POST to the collection endpoint, never a PATCH/assign with the id.
  assert.match(createFn[0], /posApiPost<[^>]*>\('\/api\/pos\/housekeeping', body\)/);
  assert.doesNotMatch(createFn[0], /posApiPatch/);
  assert.doesNotMatch(createFn[0], /task_id:/);

  // On success it reloads so the now-covered room drops its fallback row and the real
  // task (with assign/start/complete controls) takes its place.
  assert.match(createFn[0], /await fetchTasks\(\{ silent: true \}\)/);
});

test('housekeeping create-task copy is a real Greek translation, not the English source', () => {
  const el = locale('el').housekeepingView;
  const en = locale('en').housekeepingView;
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

  assert.match(el.action.createTask, GREEK_LETTER, 'el action.createTask should be Greek');
  assert.notEqual(el.action.createTask, en.action.createTask, 'el action.createTask must be translated');
  for (const key of ['createSuccess', 'createFailed']) {
    assert.match(el.toasts[key], GREEK_LETTER, `el toasts.${key} should be Greek`);
    assert.notEqual(el.toasts[key], en.toasts[key], `el toasts.${key} must be translated`);
  }
});

test('HousekeepingView localizes the task-type label in the card and filter, not the raw value', () => {
  assert.match(viewSource, /const resolveTaskTypeLabel = useCallback\(/);
  assert.match(viewSource, /housekeepingView\.taskType\.\$\{type\}/);
  // Both surfaces render the resolved label.
  assert.match(viewSource, /\{resolveTaskTypeLabel\(task\.task_type\)\}/);
  assert.match(viewSource, /\{resolveTaskTypeLabel\(type\)\}/);
  // Raw type is preserved for filtering (option value) and data, only the label changes.
  assert.match(viewSource, /<option key=\{type\} value=\{type\}>/);
  // The raw renders are gone.
  assert.doesNotMatch(viewSource, /^\s*\{task\.task_type\}\s*$/m);
  assert.doesNotMatch(viewSource, /<option key=\{type\} value=\{type\}>\{type\}<\/option>/);
  // Unknown/custom types stay readable via a safe humanized fallback.
  assert.match(viewSource, /defaultValue: humanizeTaskType\(type\)/);
});

test('housekeepingView translation keys are present in every locale', () => {
  const flatKeys = ['loading', 'errorTitle', 'room', 'unassigned', 'staffFallback', 'fallbackHint'];
  const groups: Record<string, string[]> = {
    status: ['pending', 'inProgress', 'completed', 'verified'],
    stats: ['totalTasks', 'completedToday', 'avgTime'],
    filter: ['allFloors', 'floor', 'allTypes', 'allPriorities', 'allStaff', 'unassigned'],
    priority: ['urgent', 'high', 'normal', 'low'],
    taskType: ['cleaning', 'checkout_clean', 'stayover_clean', 'deep_clean', 'turndown', 'inspection'],
    action: ['start', 'complete', 'verify', 'createTask'],
    empty: ['title', 'description'],
    toasts: ['loadFailed', 'updateFailed', 'assignFailed', 'createSuccess', 'createFailed'],
  };

  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const h = locale(language).housekeepingView;
    assert.ok(h, `${language} missing housekeepingView`);
    for (const key of flatKeys) {
      assert.equal(typeof h[key], 'string', `${language}.housekeepingView.${key} missing`);
      assert.ok(h[key].length > 0, `${language}.housekeepingView.${key} empty`);
    }
    for (const [group, keys] of Object.entries(groups)) {
      for (const key of keys) {
        assert.equal(typeof h[group]?.[key], 'string', `${language}.housekeepingView.${group}.${key} missing`);
      }
    }
  }

  assert.doesNotMatch(locale('el').housekeepingView.empty.description, /check-out/i);

  // The fallback hint must be a real Greek translation, not the English source.
  assert.notEqual(
    locale('el').housekeepingView.fallbackHint,
    locale('en').housekeepingView.fallbackHint,
    'el fallbackHint must differ from the English source',
  );

  // Every known housekeeping enum (the real values the admin create API emits) must
  // be a real Greek translation, not the raw enum or the English source.
  const TASK_TYPE_ENUMS = ['cleaning', 'checkout_clean', 'stayover_clean', 'deep_clean', 'turndown', 'inspection'];
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');
  for (const enumValue of TASK_TYPE_ENUMS) {
    const el = locale('el').housekeepingView.taskType[enumValue];
    const en = locale('en').housekeepingView.taskType[enumValue];
    assert.match(el, GREEK_LETTER, `el taskType.${enumValue} should be Greek: "${el}"`);
    assert.notEqual(el, enumValue, `el taskType.${enumValue} must not be the raw enum value`);
    assert.notEqual(el, en, `el taskType.${enumValue} must differ from the English source`);
  }
});

// --- Round 256 (live QA, 1282x802 Greek/dark): Housekeeping read as a desktop kanban squeezed into
// a touchscreen POS — a narrow first pending column with a native white scrollbar, most of the page
// empty, and old blue/navy/gray blocks with hover/title patterns. The board is now full-width glass
// status sections with a responsive card grid, hidden scrollbar, POS glass/yellow/neutral chrome, and
// semantic glass action buttons with a neutral disabled state. Behaviour/data/i18n are unchanged. ---

test('Round 256: HousekeepingView uses no off-theme blue, no hover-only utilities, no native title', () => {
  assert.doesNotMatch(viewSource, /bg-blue-/);
  assert.doesNotMatch(viewSource, /hover:/);
  // No DOM native title= attribute — the refresh control exposes an aria-label instead.
  assert.doesNotMatch(viewSource, /\btitle=/);
  assert.match(viewSource, /aria-label=\{t\('common\.refresh'/);
});

test('Round 256: the task board is full-width grouped status sections with a responsive card grid', () => {
  // Status sections (not narrow kanban columns): each is a <motion.section> tagged with its status,
  // and its cards flow in a responsive grid that uses the available width.
  assert.match(viewSource, /<motion\.section[^>]*data-housekeeping-section=\{column\.status\}/);
  assert.match(viewSource, /grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3/);
  // The old narrow 4-column kanban grid is gone.
  assert.doesNotMatch(viewSource, /grid grid-cols-2 xl:grid-cols-4 gap-4 overflow-hidden/);
  // Empty status sections are skipped so the visible ones fill the width (4 pending rooms spread out).
  assert.match(viewSource, /if \(columnTasks\.length === 0\) return null;/);
});

test('Round 256: the task area scrolls with the hidden scrollbar (no native white rail)', () => {
  assert.match(viewSource, /flex-1 overflow-y-auto scrollbar-hide/);
  // The old per-column native-scrollbar lane is gone.
  assert.doesNotMatch(viewSource, /flex-1 overflow-y-auto space-y-2 pr-1/);
});

test('Round 256: stats / filters / headers / cards use the POS glass system, not gray blocks', () => {
  // No old gray surface blocks survive.
  assert.doesNotMatch(viewSource, /bg-gray-(700|800|900)/);
  // Glass surfaces (translucent zinc + border + blur) are used for the chrome.
  const glass = viewSource.match(/bg-zinc-900\/(50|60) border-white\/10/g) || [];
  assert.ok(glass.length >= 4, `expected >=4 glass surfaces (stats/header/card/section), found ${glass.length}`);
  assert.match(viewSource, /backdrop-blur-md/);
  // The refresh control is an amber glass icon button.
  assert.match(viewSource, /bg-amber-500\/15 text-amber-300/);
});

test('Round 256/428: action buttons are non-blue semantic glass with a neutral disabled state', () => {
  // Start/Create/Verify = amber glass, Complete = green glass (dark accents).
  assert.match(viewSource, /border-amber-400\/40 bg-amber-500\/20 text-amber-200/);
  assert.match(viewSource, /border-emerald-500\/40 bg-emerald-500\/20 text-emerald-300/);
  assert.doesNotMatch(viewSource, /purple-/);
  assert.doesNotMatch(viewSource, /rounded-lg/);
  assert.match(viewSource, /w-full py-2 text-xs font-medium rounded-2xl border transition-transform active:scale-95/);
  assert.match(viewSource, /w-full px-2 py-2 rounded-2xl border text-xs/);
  // Every status/create action button shares the neutral disabled glass (Start/Create/Complete/Verify).
  const neutralDisabled =
    viewSource.match(
      /disabled:bg-zinc-400\/20 disabled:text-zinc-400 disabled:border-zinc-400\/30 disabled:active:scale-100/g,
    ) || [];
  assert.ok(neutralDisabled.length >= 4, `expected >=4 neutral-disabled action buttons, found ${neutralDisabled.length}`);
  // Touch feedback via active:, never the old dimmed-color buttons.
  assert.match(viewSource, /active:scale-95/);
});

test('Round 359: Housekeeping light theme keeps cards, controls, and action buttons readable', () => {
  assert.match(
    viewSource,
    /const lightGlassSurface = 'bg-white\/72 border-zinc-300\/80 shadow-\[0_12px_30px_rgba\(15,23,42,0\.10\)\]'/,
  );
  assert.match(
    viewSource,
    /const lightControlSurface = 'bg-white\/90 text-gray-950 border-zinc-300 shadow-sm shadow-black\/5'/,
  );

  // Light labels/body copy moved darker; the old washed-out gray-500 metadata should not remain in the
  // task card/empty-state body areas.
  assert.match(viewSource, /isDark \? 'text-zinc-400' : 'text-gray-700'/);
  assert.match(viewSource, /isDark \? 'text-gray-400' : 'text-gray-600'/);

  // Light action buttons are visibly active surfaces, not pale disabled-looking bg-*-50 buttons.
  assert.match(viewSource, /border-amber-500\/60 bg-amber-100 text-amber-900 active:bg-amber-200/);
  assert.match(viewSource, /border-emerald-500\/60 bg-emerald-100 text-emerald-900 active:bg-emerald-200/);
  assert.doesNotMatch(viewSource, /border-purple-500\/60 bg-purple-100 text-purple-900 active:bg-purple-200/);
});
