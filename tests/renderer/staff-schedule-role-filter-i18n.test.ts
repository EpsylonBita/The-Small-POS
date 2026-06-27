import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { translateRoleName, humanizeRoleSlug } from '../../src/renderer/utils/role-labels';

const projectRoot = process.cwd();
const viewSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'pages', 'verticals', 'salon', 'StaffScheduleView.tsx'),
  'utf8',
);
const loadRoleNames = (lng: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lng}.json`), 'utf8')).common
    .roleNames;

// Mimic i18next: known keys resolve to their localized value, missing keys echo
// the key back (which `translateRoleName` treats as "not translated").
const makeT = (roleNames: Record<string, string>) => (key: string): string => {
  const prefix = 'common.roleNames.';
  if (key.startsWith(prefix)) {
    return roleNames[key.slice(prefix.length)] ?? key;
  }
  return key;
};

// The role slugs whose chips leaked English display names in Greek mode, paired
// with the English `role_display_name` the API/database ships for each.
const REPORTED_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['waiter', 'Waiter/Server'],
  ['housekeeping_supervisor', 'Housekeeping Supervisor'],
  ['driver', 'Driver'],
  ['branch_manager', 'Branch Manager'],
  ['admin', 'Administrator'],
  ['line_cook', 'Line Cook'],
  ['shift_lead', 'Shift Lead'],
  ['housekeeper', 'Housekeeper'],
];

test('known role slugs localize and i18n wins over the English data display name', () => {
  const t = makeT(loadRoleNames('en'));
  assert.equal(translateRoleName(t, 'waiter'), 'Waiter');
  assert.equal(translateRoleName(t, 'admin'), 'Admin');
  // The actual defect: the API ships an English display name; i18n must still win.
  assert.equal(translateRoleName(t, 'waiter', 'Waiter/Server'), 'Waiter');
  assert.equal(translateRoleName(t, 'admin', 'Administrator'), 'Admin');
});

test('reported role chips resolve to Greek, never the English display name', () => {
  const el = loadRoleNames('el');
  const t = makeT(el);
  for (const [slug, english] of REPORTED_ROLES) {
    const label = translateRoleName(t, slug, english);
    // The chip must render the Greek locale label, not the English data display name.
    assert.equal(label, el[slug], `${slug} should render its Greek label`);
    assert.notEqual(label, english, `${slug} must not render the English label "${english}" in Greek`);
  }
});

test('true custom/data role names survive when no known slug exists', () => {
  const t = makeT(loadRoleNames('en'));
  // Unknown slug with a real custom display name keeps the custom name verbatim.
  assert.equal(translateRoleName(t, 'senior_stylist_vip', 'Senior Stylist VIP'), 'Senior Stylist VIP');
  // Unknown coded slug with no display name is humanized, never leaked as raw code.
  assert.equal(translateRoleName(t, 'regional_coordinator'), 'Regional Coordinator');
  assert.equal(translateRoleName(t, 'regional_coordinator', ''), 'Regional Coordinator');
  assert.doesNotMatch(translateRoleName(t, 'any_unknown_role'), /_/);
});

test('humanizeRoleSlug titleizes slugs without mangling readable names', () => {
  assert.equal(humanizeRoleSlug('housekeeping_supervisor'), 'Housekeeping Supervisor');
  assert.equal(humanizeRoleSlug('front_desk'), 'Front Desk');
  assert.equal(humanizeRoleSlug('VIP Host'), 'VIP Host');
  assert.equal(humanizeRoleSlug('Chef de Partie'), 'Chef de Partie');
});

test('StaffScheduleView routes role filter chips through the shared i18n helper', () => {
  assert.match(viewSource, /import \{ translateRoleName \} from '\.\.\/\.\.\/\.\.\/utils\/role-labels';/);
  // A dedicated chip resolver wires translateRoleName with the active `t`, using the
  // raw display name only as a custom-role fallback.
  assert.match(viewSource, /const getRoleChipLabel = useCallback\(/);
  assert.match(
    viewSource,
    /translateRoleName\(t, roleName, roleDisplayNameByName\.get\(roleName\)\)/,
  );
  // The rendered chip uses the localized resolver, not the raw data label.
  assert.match(viewSource, /\{getRoleChipLabel\(role\)\}/);
});

test('StaffScheduleView localizes every role label surface, not just the chips', () => {
  // Weekly shift normalization (day cards) resolves through i18n.
  assert.match(
    viewSource,
    /roleLabel: translateRoleName\(t, roleName, staffMember\?\.role\?\.displayName\)/,
  );
  // Week preview role line.
  assert.match(
    viewSource,
    /translateRoleName\(t, row\.staff\.role\?\.name \|\| 'staff', row\.staff\.role\?\.displayName\)/,
  );
  // Create-modal staff <option> suffix.
  assert.match(
    viewSource,
    /translateRoleName\(t, member\.role\?\.name \|\| 'staff', member\.role\?\.displayName\)/,
  );

  // The old English-leaking patterns (data display name first, no i18n) are gone.
  assert.doesNotMatch(viewSource, /staffMember\?\.role\?\.displayName \|\| getRoleLabel/);
  assert.doesNotMatch(viewSource, /row\.staff\.role\?\.displayName \|\| row\.staff\.role\?\.name/);
  assert.doesNotMatch(viewSource, /member\.role\?\.displayName \|\| member\.role\?\.name/);
  // The humanize-only helper it replaced is fully retired.
  assert.doesNotMatch(viewSource, /const getRoleLabel = useCallback/);
});
