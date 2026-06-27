import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'salon', 'StaffScheduleView.tsx'),
  'utf8',
);
const formatSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'utils', 'format.ts'),
  'utf8',
);

test('StaffScheduleView formats dates/times through the locale-aware helpers', () => {
  assert.match(viewSource, /import \{ formatDate, formatTime \} from '\.\.\/\.\.\/\.\.\/utils\/format';/);
  // Week range, day cards and the create-modal date use formatDate.
  assert.match(viewSource, /formatDate\(currentWeekStart, \{ day: 'numeric', month: 'short' \}\)/);
  assert.match(viewSource, /formatDate\(endDate, \{ day: 'numeric', month: 'short' \}\)/);
  assert.match(viewSource, /formatDate\(day, \{ day: '2-digit', month: 'short' \}\)/);
  assert.match(viewSource, /formatDate\(createModalDate, \{ weekday: 'long', day: '2-digit', month: 'short' \}\)/);
  assert.match(viewSource, /formatDate\(day, \{ weekday: 'short' \}\)/);
  // Shift time ranges and the add-shift preview use formatTime/formatDate.
  assert.match(viewSource, /formatTime\(start, \{ hour: '2-digit', minute: '2-digit' \}\)/);
  assert.match(viewSource, /formatTime\(end, \{ hour: '2-digit', minute: '2-digit' \}\)/);
  assert.match(viewSource, /formatDate\(start, \{ day: '2-digit', month: 'short' \}\)/);
  assert.match(viewSource, /formatDate\(end, \{ day: '2-digit', month: 'short' \}\)/);
});

test('StaffScheduleView no longer uses system-locale date/time formatting', () => {
  // The empty-locale array ([]) falls back to the OS locale, not the app language,
  // which is exactly what rendered English month/day names in Greek mode.
  assert.doesNotMatch(viewSource, /toLocaleDateString\(\[\]/);
  assert.doesNotMatch(viewSource, /toLocaleTimeString\(\[\]/);
  assert.doesNotMatch(viewSource, /toLocaleString\(\[\]/);
});

test('format helpers resolve the active i18n language', () => {
  // formatDate/formatTime must prefer the active i18n language so they localize.
  assert.match(formatSource, /const resolveLocale = \(locale\?: string\): string =>/);
  assert.match(formatSource, /i18n\.language/);
  assert.match(formatSource, /export function formatDate\(/);
  assert.match(formatSource, /export function formatTime\(/);
});

const loadDuration = (lng: string): { duration: string; durationHoursOnly: string } => {
  const json = JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8'),
  );
  return { duration: json.shift?.duration, durationHoursOnly: json.shift?.durationHoursOnly };
};

// Interpolate the {{hours}}/{{minutes}} placeholders the way i18next does at
// runtime, so we can assert the *rendered* duration label, not just the template.
const interpolate = (template: string, vars: Record<string, number>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ''));

test('StaffScheduleView resolves the add-shift duration label through i18n keys', () => {
  // The raw English-unit template literal must be gone.
  assert.doesNotMatch(viewSource, /\$\{hours\}h/);
  // Both branches route through localized, interpolated duration keys.
  assert.match(viewSource, /t\('shift\.durationHoursOnly', '\{\{hours\}\}h', \{ hours \}\)/);
  assert.match(viewSource, /t\('shift\.duration', '\{\{hours\}\}h \{\{minutes\}\}m', \{ hours, minutes \}\)/);
});

test('duration keys exist in every POS locale and Greek localizes the units', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const { duration, durationHoursOnly } = loadDuration(lng);
    assert.equal(typeof duration, 'string', `${lng}.shift.duration missing`);
    assert.equal(typeof durationHoursOnly, 'string', `${lng}.shift.durationHoursOnly missing`);
    // Placeholders must survive so runtime interpolation works.
    assert.match(duration, /\{\{hours\}\}/, `${lng}.shift.duration must keep {{hours}}`);
    assert.match(duration, /\{\{minutes\}\}/, `${lng}.shift.duration must keep {{minutes}}`);
    assert.match(durationHoursOnly, /\{\{hours\}\}/, `${lng}.shift.durationHoursOnly must keep {{hours}}`);
  }

  // Greek must not render the English "h"/"m" unit abbreviations next to numbers.
  const el = loadDuration('el');
  const elBoth = interpolate(el.duration, { hours: 8, minutes: 30 });
  const elHoursOnly = interpolate(el.durationHoursOnly, { hours: 8 });
  assert.doesNotMatch(elBoth, /\dh|\dm/, `Greek duration leaked English units: "${elBoth}"`);
  assert.doesNotMatch(elHoursOnly, /\dh/, `Greek hours-only leaked English units: "${elHoursOnly}"`);

  // And the Greek labels are genuinely distinct from English (real translation).
  const en = loadDuration('en');
  assert.notEqual(el.duration, en.duration);
  assert.notEqual(el.durationHoursOnly, en.durationHoursOnly);
});
