import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'StaffShiftModal.tsx'),
  'utf8',
);
const loadLocale = (lng: string) =>
  JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lng}.json`), 'utf8'));

// The role slugs that previously leaked as raw codes in Greek mode, plus `server`.
const ROLE_SLUGS = [
  'housekeeping_supervisor',
  'branch_manager',
  'line_cook',
  'shift_lead',
  'housekeeper',
  'bartender',
  'front_desk',
  'room_service',
  'head_chef',
  'server',
];

test('StaffShiftModal humanizes unknown role slugs instead of leaking raw codes', () => {
  assert.match(modalSource, /const humanizeRoleSlug = \(roleName: string\): string =>/);
  // translateRoleName falls back to a humanized label, never the raw slug.
  assert.match(modalSource, /return humanizeRoleSlug\(normalized\);/);
  // The old leak (returning the raw role name when a key is missing) must be gone.
  assert.doesNotMatch(modalSource, /return translated === key \? roleName : translated;/);
  // Role displays continue to route through translateRoleName.
  assert.match(modalSource, /translateRoleName\(role\.role_name\)/);
});

test('known staff role slugs resolve to localized labels in every locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const roleNames = loadLocale(lng).common?.roleNames ?? {};
    for (const slug of ROLE_SLUGS) {
      assert.equal(typeof roleNames[slug], 'string', `${lng}.common.roleNames.${slug} missing`);
      assert.ok(roleNames[slug].length > 0, `${lng}.common.roleNames.${slug} empty`);
      assert.notEqual(roleNames[slug], slug, `${lng}.common.roleNames.${slug} must not equal the raw slug`);
    }
  }
  // Greek labels must differ from English to prove real translation, not an echo.
  const en = loadLocale('en').common.roleNames;
  const el = loadLocale('el').common.roleNames;
  for (const slug of ROLE_SLUGS) {
    assert.notEqual(el[slug], en[slug], `el.common.roleNames.${slug} should be translated`);
  }
});

test('humanized fallback turns a snake_case slug into a readable label', () => {
  // Mirror the component helper to prove no raw snake_case reaches the UI for
  // unknown coded roles while readable custom role names stay intact.
  const humanize = (roleName: string): string =>
    /[_-]/.test(roleName.trim())
      ? roleName
          .trim()
          .split(/[_\s-]+/)
          .filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ')
      : roleName.trim();

  assert.equal(humanize('housekeeping_supervisor'), 'Housekeeping Supervisor');
  assert.equal(humanize('front_desk'), 'Front Desk');
  assert.equal(humanize('VIP Host'), 'VIP Host');
  assert.equal(humanize('Chef de Partie'), 'Chef de Partie');
  assert.equal(humanize('some_custom_role'), 'Some Custom Role');
  assert.doesNotMatch(humanize('any_unknown_role'), /_/);
});

// --- Round 313 (live QA, Greek/dark, 1282x802): the Start Shift -> PIN step had a dots input + Continue
// but NO on-screen keypad, so a touchscreen cashier couldn't enter a PIN without a physical keyboard. A
// numeric keypad now drives the SAME enteredPin state (append up to 4 / clear / backspace) WITHOUT
// auto-submitting; the Continue button remains the only click-submit. The shared check-in eyebrow style is
// also calmed from shouty uppercase/letter-spacing to normal case. Auth/check-in logic is untouched. ---

test('Round 313: the PIN step has a touch numeric keypad wired to enteredPin, with no auto-submit', () => {
  const pinStart = modalSource.indexOf('data-testid="staff-pin-section"');
  const pinEnd = modalSource.indexOf('data-testid="staff-role-section"', pinStart);
  assert.ok(pinStart > 0 && pinEnd > pinStart, 'the PIN step section must be found');
  const pinStep = modalSource.slice(pinStart, pinEnd);

  // The keypad exists.
  assert.match(pinStep, /data-testid="staff-pin-keypad"/);
  // 1-9 grid + a 0 key; digits append to the SAME enteredPin state, capped at length 4.
  assert.match(pinStep, /\['1', '2', '3', '4', '5', '6', '7', '8', '9'\]\.map/);
  assert.match(pinStep, /setEnteredPin\(\(prev\) => \(prev\.length >= 4 \? prev : prev \+ digit\)\)/);
  assert.match(pinStep, /setEnteredPin\(\(prev\) => \(prev\.length >= 4 \? prev : prev \+ '0'\)\)/);
  // Clear empties; backspace removes the last digit.
  assert.match(pinStep, /onClick=\{\(\) => setEnteredPin\(''\)\}/);
  assert.match(pinStep, /setEnteredPin\(\(prev\) => prev\.slice\(0, -1\)\)/);

  // Keyboard entry still works exactly as before: numeric onChange + Enter submits at length 4.
  assert.match(pinStep, /onChange=\{\(e\) => setEnteredPin\(e\.target\.value\.replace\(\/\\D\/g, ''\)\)\}/);
  assert.match(pinStep, /onKeyDown=\{\(e\) => e\.key === 'Enter' && enteredPin\.length === 4 && handlePinSubmit\(\)\}/);

  // No auto-submit: the keypad itself never calls handlePinSubmit.
  const keypadStart = pinStep.indexOf('data-testid="staff-pin-keypad"');
  const keypad = pinStep.slice(keypadStart, pinStep.indexOf('</div>', pinStep.indexOf('Delete className')));
  assert.doesNotMatch(keypad, /handlePinSubmit/, 'the keypad must not submit -- Continue stays the only submit');
  // Within the PIN body, handlePinSubmit fires ONLY from the Enter-key handler (Round 313 3rd follow-up
  // hoisted the Continue button into renderCheckInFooter so its footer can pin to the viewport).
  const bodySubmits = pinStep.match(/handlePinSubmit\(\)/g) ?? [];
  assert.equal(bodySubmits.length, 1, 'in the PIN body only the Enter handler calls handlePinSubmit (no auto-submit)');

  // The Continue submit button lives in the hoisted check-in footer with the exact same gating, so it stays
  // the only click-submit and is visible at the bottom on first open.
  const footerStart = modalSource.indexOf('const renderCheckInFooter = () => {');
  const footerEnd = modalSource.indexOf('// Debug logging', footerStart);
  assert.ok(footerStart > 0 && footerEnd > footerStart, 'renderCheckInFooter must exist');
  const footer = modalSource.slice(footerStart, footerEnd);
  assert.match(footer, /void handlePinSubmit\(\);/, 'the Continue button is the click-submit path');
  assert.match(footer, /disabled=\{loading \|\| enteredPin\.length !== 4\}/, 'Continue stays disabled until a 4-digit PIN');
  assert.match(footer, /renderCheckInBackButton\('select-staff'\)/, 'the PIN-step Back action is in the footer');

  // Touch-first + on-palette: >=44px keys, no hover, no native title, no blue/cyan/purple/indigo/violet/sky.
  assert.match(pinStep, /min-h-\[44px\]/);
  assert.doesNotMatch(pinStep, /hover:/);
  assert.doesNotMatch(pinStep, /\btitle=/);
  assert.doesNotMatch(pinStep, /\b(?:bg|text|border|from|to|ring)-(?:blue|cyan|purple|indigo|violet|sky)-/);
});

test('Round 313: the shared check-in eyebrow micro-labels are normal-case (not shouty uppercase/tracking)', () => {
  assert.match(modalSource, /const checkInEyebrowClass = 'text-xs font-semibold text-slate-500 dark:text-slate-400';/);
  // The old uppercase + letter-spaced eyebrow style is gone from the shared check-in label.
  assert.doesNotMatch(modalSource, /const checkInEyebrowClass = 'text-xs uppercase tracking-/);
});

// --- Round 313 follow-up (live QA): the PIN step opened too tall at 1282x802 -- only digits 1-9 showed at
// the top scroll position, while Clear/0/Backspace and the Back+Continue footer were below the fold. The
// step is now compacted (denser staff summary, shorter PIN input, tighter spacing) so the whole interaction
// fits the first viewport. The keypad keys stay >=44px touch targets. ---
test('Round 313 follow-up: the PIN step is compact (no tall py-5/text-4xl input, tighter keypad) for first-view fit', () => {
  const pinStart = modalSource.indexOf('data-testid="staff-pin-section"');
  const pinEnd = modalSource.indexOf('data-testid="staff-role-section"', pinStart);
  assert.ok(pinStart > 0 && pinEnd > pinStart, 'the PIN step section must be found');
  const pinStep = modalSource.slice(pinStart, pinEnd);

  // The oversized PIN input (py-5 / text-4xl) that pushed the bottom keypad row + footer below the fold is gone.
  assert.doesNotMatch(pinStep, /py-5 text-center text-4xl/, 'the tall PIN input must be compacted');
  assert.match(pinStep, /py-2\.5 text-center text-3xl/, 'the PIN input is compact (py-2.5 / text-3xl)');

  // Tighter keypad rhythm, but every key is still a >=44px touch target.
  assert.match(pinStep, /data-testid="staff-pin-keypad" className="mt-3 grid grid-cols-3 gap-1\.5"/);
  assert.match(pinStep, /min-h-\[44px\]/);

  // Compact section wrapper (space-y-3, not the old space-y-6) so the full step fits without scrolling.
  assert.match(modalSource, /className="space-y-3" data-testid="staff-pin-section"/);
  assert.doesNotMatch(modalSource, /className="space-y-6" data-testid="staff-pin-section"/);
});

// --- Round 313 (2nd follow-up, live QA): the keypad was visible but Back + disabled Continue were still
// below the fold at 1282x802. Each keypad key carried `min-h-[44px]` AND `py-3`, so the floor was overshot
// (~52px/row); dropping `py-3` returns keys to exactly 44px (touch target preserved) and reclaims ~32px.
// The duplicate "Enter PIN" eyebrow + inset label are removed (single h3 heading), and the scroll/stepper
// spacing is tighter -- so the summary + PIN field + all 12 keys + footer fit the first viewport. ---
test('Round 313 (2nd follow-up): keypad keys are exactly-44px (no py-3 overshoot) and the PIN heading is not duplicated', () => {
  const pinStart = modalSource.indexOf('data-testid="staff-pin-section"');
  const pinEnd = modalSource.indexOf('data-testid="staff-role-section"', pinStart);
  assert.ok(pinStart > 0 && pinEnd > pinStart, 'the PIN step section must be found');
  const pinStep = modalSource.slice(pinStart, pinEnd);

  // Keypad keys keep the 44px touch floor but no longer stack py-3 on top of it (that overshoot pushed the
  // footer below the fold).
  assert.match(pinStep, /min-h-\[44px\]/);
  assert.doesNotMatch(pinStep, /min-h-\[44px\][^"]*\bpy-3\b/, 'keypad keys must not add py-3 over the 44px floor');
  // The compact digit key is min-h-[44px] + text-xl with no vertical padding token.
  assert.match(pinStep, /min-h-\[44px\] items-center justify-center rounded-xl border border-slate-200\/80 bg-white\/85 text-xl font-black/);

  // The PIN heading is rendered once (the duplicate eyebrow + inset label are gone); the helper stays.
  const enterPinHeadings = (pinStep.match(/staffShift\.enterPIN'\)/g) ?? []).length;
  assert.equal(enterPinHeadings, 1, `the PIN step must render the Enter PIN heading once (found ${enterPinHeadings})`);
  assert.match(pinStep, /staffShift\.enterPinHelper/, 'the localized helper line is kept');

  // The keypad still has all 12 controls wired to enteredPin (preserved from Round 313) -- no behavior change.
  assert.match(pinStep, /\['1', '2', '3', '4', '5', '6', '7', '8', '9'\]\.map/);
  assert.match(pinStep, /onClick=\{\(\) => setEnteredPin\(''\)\}/);
  assert.match(pinStep, /setEnteredPin\(\(prev\) => prev\.slice\(0, -1\)\)/);
});

// --- Round 313 (3rd follow-up, live QA): Back + Continue were STILL below the fold. Root cause: the
// check-in action footer was inside the framer-motion step pane, whose transform created a containing block
// that trapped the footer's `sticky bottom-0` inside the pane -- so it could never pin to the scroll
// viewport. The footer is now hoisted into renderCheckInFooter() and rendered as a SIBLING of the animated
// pane, so it pins to the scroll region and stays visible at the bottom. The per-step bodies no longer carry
// the footer. ---
test('Round 313 (3rd follow-up): the check-in footer is hoisted out of the animated pane so it pins to the viewport', () => {
  // The footer is a dedicated function whose only wrapper is checkInFooterClass (which keeps sticky bottom-0).
  assert.match(modalSource, /const renderCheckInFooter = \(\) => \{/);
  assert.match(modalSource, /return <div className=\{checkInFooterClass\}>\{inner\}<\/div>;/);
  assert.match(modalSource, /const checkInFooterClass = 'sticky bottom-0 /, 'the footer keeps sticky bottom-0');

  // It is rendered as a SIBLING right after the animated pane (NOT inside the <motion.div> whose transform
  // would trap the sticky), so its containing block is the scroll region.
  assert.match(modalSource, /<\/AnimatePresence>\s*\{\/\*[\s\S]*?\*\/\}\s*\{renderCheckInFooter\(\)\}/);

  // The footer no longer lives inside any step body: checkInFooterClass appears only twice (the const
  // definition + the single renderCheckInFooter return), never inside the staff-pin/role/cash sections.
  const footerClassUses = (modalSource.match(/checkInFooterClass/g) ?? []).length;
  assert.equal(footerClassUses, 2, `checkInFooterClass should be the const + one footer wrapper (found ${footerClassUses})`);

  // The pin-step body (the animated pane content) no longer contains the footer wrapper.
  const pinStart = modalSource.indexOf('data-testid="staff-pin-section"');
  const pinEnd = modalSource.indexOf('data-testid="staff-role-section"', pinStart);
  const pinStep = modalSource.slice(pinStart, pinEnd);
  assert.doesNotMatch(pinStep, /checkInFooterClass/, 'the footer must not be inside the transformed pin-step body');
});
