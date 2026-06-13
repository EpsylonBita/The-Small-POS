import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const scheduleViewPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'pages',
  'verticals',
  'salon',
  'StaffScheduleView.tsx',
);
const branchDataPath = path.join(
  projectRoot,
  'src-tauri',
  'src',
  'commands',
  'branch_data.rs',
);
const localesDir = path.join(projectRoot, 'src', 'locales');
const requiredStaffScheduleKeys = [
  'actions.close',
  'actions.nextWeek',
  'actions.previousWeek',
  'actions.refresh',
  'actions.selectStaff',
  'days.short.fri',
  'days.short.mon',
  'days.short.sat',
  'days.short.sun',
  'days.short.thu',
  'days.short.tue',
  'days.short.wed',
  'presets.closing',
  'presets.evening',
  'presets.morning',
  'status.active',
  'status.cancelled',
  'status.completed',
  'status.no_show',
  'status.scheduled',
];

const readScheduleSource = () => readFileSync(scheduleViewPath, 'utf8');

function flattenKeys(value: unknown, prefix = '', out = new Set<string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenKeys(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

function collectStaffScheduleTranslationKeys(source: string) {
  const keys = new Set<string>();
  const pattern = /t\(\s*['"`](staffSchedule\.[^'"`]+)['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (!match[1].includes('${')) {
      keys.add(match[1].replace(/^staffSchedule\./, ''));
    }
  }
  return [...keys].sort();
}

test('StaffScheduleView uses a responsive calendar without visible scrollbars', () => {
  const source = readScheduleSource();

  assert.match(
    source,
    /scrollbar-hide/,
    'scrollable regions should hide native scrollbars while preserving touch and wheel scroll',
  );
  assert.doesNotMatch(
    source,
    /overflow-auto/,
    'schedule should use axis-specific scrolling so visible horizontal scrollbars are not introduced',
  );
  assert.doesNotMatch(
    source,
    /min-w-\[/,
    'weekly grid must not force a desktop-width minimum that creates a horizontal scrollbar',
  );
  assert.match(
    source,
    /2xl:grid-cols-7/,
    'weekly schedule should progressively expand to seven day columns on wide screens',
  );
  assert.match(
    source,
    /flex min-h-64 overflow-hidden flex-col/,
    'day cards should clip their own contents instead of letting header controls spill outside',
  );
  assert.match(
    source,
    /min-w-0 flex-1/,
    'day-card header labels should be allowed to shrink inside narrow cards',
  );
  assert.match(
    source,
    /flex shrink-0 items-center gap-1\.5/,
    'day-card header actions should stay compact and inside the card',
  );
  assert.match(
    source,
    /h-9 w-9/,
    'day-card add buttons should fit inside seven-column cards',
  );
});

test('StaffScheduleView uses yellow accents for selected controls instead of blue chrome', () => {
  const source = readScheduleSource();

  assert.match(source, /focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400\/25/);
  assert.match(source, /bg-yellow-400 px-4 py-3 text-sm font-semibold text-black/);
  assert.match(source, /bg-yellow-400 border-yellow-400 text-black/);
  assert.match(source, /bg-yellow-950\/20 border-yellow-500/);
  assert.match(source, /bg-yellow-100 border-yellow-200 text-yellow-800/);
  assert.match(source, /hover:border-yellow-500 hover:text-yellow-200/);
  assert.doesNotMatch(source, /staffSchedule\.actions\.addShift/);
  assert.match(source, /staffSchedule\.addShiftForDay/);
  assert.doesNotMatch(source, /focus:border-blue-500/);
  assert.doesNotMatch(source, /bg-blue-600/);
  assert.doesNotMatch(source, /border-blue-500/);
  assert.doesNotMatch(source, /border-blue-600/);
  assert.doesNotMatch(source, /text-blue-/);
  assert.doesNotMatch(source, /rgba\(37,99,235/);
  assert.doesNotMatch(source, /rgba\(59,130,246/);
  assert.doesNotMatch(source, /style=\{roleFilter === role \?/);
});

test('StaffScheduleView only shows ERGANI publish when the plugin is acquired', () => {
  const source = readScheduleSource();

  assert.match(source, /const ERGANI_PLUGIN_ID = 'ergani_digital_schedule'/);
  assert.match(source, /posApiGet<\{ integrations\?: PosIntegrationPayload\[\] \}>/);
  assert.match(source, /\/pos\/integrations\?provider=\$\{ERGANI_PLUGIN_ID\}/);
  assert.match(source, /integration\.is_purchased === true/);
  assert.match(source, /integration\.is_enabled !== false/);
  assert.match(source, /\{hasErganiPlugin \? \(\s*<button[\s\S]*Publish to ERGANI/);
  assert.match(source, /\{hasErganiPlugin && erganiPublishStatus \? \(/);
});

test('StaffScheduleView passes role filters through the admin staff-schedule sync path', () => {
  const source = readScheduleSource();
  const branchData = readFileSync(branchDataPath, 'utf8');

  assert.match(source, /params\.append\('role', roleFilter\)/);
  assert.match(source, /role:\s*roleFilter === 'all' \? undefined : roleFilter/);
  assert.match(branchData, /role:\s*Option<String>/);
  assert.match(branchData, /role=/);
});

test('StaffScheduleView staffSchedule translation keys exist in every POS locale', () => {
  const source = readScheduleSource();
  const requiredKeys = [...new Set([
    ...collectStaffScheduleTranslationKeys(source),
    ...requiredStaffScheduleKeys,
  ])].sort();

  assert.ok(requiredKeys.length > 0, 'StaffScheduleView should use staffSchedule translation keys');

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const available = flattenKeys(locale.staffSchedule);
    const missing = requiredKeys.filter(key => !available.has(key));

    assert.deepEqual(
      missing,
      [],
      `${file} is missing StaffScheduleView translations:\n${missing.map(key => `  - staffSchedule.${key}`).join('\n')}`,
    );
  }
});
