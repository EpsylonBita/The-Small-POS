import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const usersPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'UsersPage.tsx');
const localesDir = path.join(projectRoot, 'src', 'locales');

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

test('users page loads the POS customer directory without app-user type filtering', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /pos\/customers\?page=\$\{page\}&limit=\$\{pageSize\}/);
  assert.match(source, /bridge\.customers\.search\(''\)/);
  assert.match(source, /native-customer-sync/);
  assert.match(source, /sort\(\(left, right\) => right\.users\.length - left\.users\.length\)/);
  // The dead, non-interactive platform-filter graphic is gone (replaced by a real
  // customer-directory filter control, covered by a dedicated test below).
  assert.doesNotMatch(source, /users\.platformFilter/);
  assert.doesNotMatch(source, /typeFilter/);
  assert.doesNotMatch(source, /setTypeFilter/);
});

// Founder 01/11 («διόρθωσε και επανασχεδίασε και αυτή την σελίδα»): the search is the ONE kit field look (with room
// for its icon) and the filter trigger is a kit icon button beside it; an active filter shows the kit selection
// yellow instead of the old yellow dot. No theme ternaries: the kit tokens switch with the theme.
test('users page search is the kit field and the filter trigger is a kit icon button', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(
    source,
    /const searchFieldClass = 'min-h-\[48px\] w-full rounded-xl border border-\(--pos-s-control\) bg-\(--pos-s-surface\) pl-10 pr-3 text-base font-semibold text-\(--pos-s-fg\) outline-hidden transition-colors placeholder:font-normal placeholder:text-zinc-400 focus:border-\(--pos-s-yellow\) dark:placeholder:text-zinc-500';/,
  );
  assert.match(source, /value=\{searchTerm\}\s*onChange=\{\(e\) => setSearchTerm\(e\.target\.value\)\}\s*className=\{searchFieldClass\}/);
  assert.match(
    source,
    /className=\{`pos-icon-btn\$\{filtersActive \? ' border-\(--pos-s-sel-bg\)! bg-\(--pos-s-sel-bg\)! text-\(--pos-s-sel-fg\)!' : ''\}`\}/,
  );
  // The old grey chrome, the trigger inside the input and its yellow dot are gone.
  assert.doesNotMatch(source, /resolvedTheme|isDark|useTheme/);
  assert.doesNotMatch(source, /bg-zinc-800 text-white border-zinc-600/);
  assert.doesNotMatch(source, /absolute right-2 top-1\/2 -translate-y-1\/2 rounded-2xl p-1\.5/);
  assert.doesNotMatch(source, /rounded-full bg-yellow-500/);
  assert.doesNotMatch(source, /bg-gray-800\/50' : 'bg-white'[\s\S]*focus:ring-blue-500 focus:border-blue-500/);
  assert.doesNotMatch(source, /<select/);
});

// Founder 01/11: the list is kit rows inside a pos-card, not a table with a solid YELLOW header (yellow is the
// selection / the one primary only). Icons are neutral (muted); colour only on the status word (active ok, blocked
// bad); the loyalty tier is a plain word; the view / block actions are kit icon buttons (block = danger).
test('users list is kit rows in a pos-card with neutral icons and coloured status words', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.doesNotMatch(source, /<table|<thead|<tbody|motion\.tr/);
  assert.doesNotMatch(source, /bg-yellow-400|text-yellow-500|text-amber-500|text-green-500/);
  assert.match(source, /<motion\.div variants=\{pageMotionItem\} className="pos-card">/);
  assert.match(source, /<div role="list" className="divide-y divide-\(--pos-s-border\)">/);
  assert.match(source, /role="listitem"\s*variants=\{pageMotionItem\}/);
  // Neutral icons, no wrapper.
  assert.match(source, /<Mail className="h-4 w-4 shrink-0" aria-hidden="true" \/>/);
  assert.match(source, /<Phone className="h-4 w-4 shrink-0" aria-hidden="true" \/>/);
  assert.match(source, /<ShoppingBag className=\{`h-4 w-4 shrink-0 \$\{subtleClass\}`\} aria-hidden="true" \/>/);
  assert.match(source, /<Star className=\{`h-4 w-4 shrink-0 \$\{subtleClass\}`\} aria-hidden="true" \/>/);
  assert.match(source, /const subtleClass = 'text-\(--pos-s-muted\)';/);
  // The status is a coloured word without a pill or icon.
  assert.match(source, /user\.is_banned \? 'text-\(--pos-s-bad\)' : 'text-\(--pos-s-ok\)'/);
  // The tier is a plain word: no tier colours, no star badge.
  assert.match(source, /return <span className="text-sm font-semibold">\{tierLabel\}<\/span>;/);
  assert.doesNotMatch(source, /'text-orange-700 dark:text-orange-500'|'text-amber-700 dark:text-amber-300'|'text-yellow-800 dark:text-yellow-400'/);
  // Kit icon buttons for view / block.
  assert.match(source, /onClick=\{\(\) => handleViewUser\(user\)\}\s*className="pos-icon-btn"/);
  assert.match(source, /className=\{user\.is_banned \? 'pos-icon-btn' : 'pos-icon-btn pos-icon-btn--danger'\}/);
  // Wrapperless chips stay gone.
  assert.doesNotMatch(source, /bg-yellow-100 text-yellow-800 dark:bg-yellow-900\/20/);
  assert.doesNotMatch(source, /bg-green-100 text-green-800 dark:bg-green-900\/20/);
  assert.doesNotMatch(source, /text-blue-600 dark:text-blue-400 hover:text-blue-900/);
  assert.doesNotMatch(source, /purple-/);
});

// Founder 01/11: the page opens with the kit hero (title + one muted line, refresh as a kit icon button).
test('users page header is the kit hero', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /<motion\.div variants=\{pageMotionItem\} className="pos-card p-4 md:p-5">/);
  assert.match(source, /<h1 className="truncate text-3xl font-bold tracking-tight">/);
  assert.match(source, /<p className=\{`mt-1 truncate text-sm \$\{subtleClass\}`\}>\s*\{t\('users\.description'\)/);
});

// Round 184 (touch-first a11y): UsersPage icon-only controls exposed native title descriptions
// ("... Description: ...") in the accessibility tree. Native title tooltips are hover-dependent and
// must not exist in the touchscreen POS; accessible names come from aria-label, and the click
// handlers / disabled logic are preserved.
test('UsersPage has no native title tooltips; icon controls keep handlers + localized aria-labels', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // No native DOM title attribute anywhere on the page.
  assert.doesNotMatch(source, /\btitle=/);

  // Refresh keeps its handler + localized aria-label.
  assert.match(source, /onClick=\{\(\) => void loadUsers\(\)\}/);
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);

  // Founder 01/11: the header refresh is the kit icon button (44 px, raised, press feedback and the disabled
  // look from the kit), touch-first with no hover. The old black/white and hand-drawn classes are gone.
  assert.match(
    source,
    /onClick=\{\(\) => void loadUsers\(\)\}\s*disabled=\{loading\}\s*aria-label=\{t\('common\.refresh', 'Refresh'\)\}\s*className="pos-icon-btn"/,
  );
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
  assert.doesNotMatch(source, /h-12 w-12 rounded-xl inline-flex/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  // Behaviour preserved: disabled guard and spinner.
  assert.match(source, /disabled=\{loading\}/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);

  // Row view-details button keeps its handler and localized aria-label.
  assert.match(
    source,
    /onClick=\{\(\) => handleViewUser\(user\)\}[\s\S]*?aria-label=\{t\('users\.viewDetails'\) \|\| 'View details'\}/,
  );

  // Row ban/unban button keeps its handler and the localized unban/ban aria-label.
  assert.match(source, /onClick=\{\(\) => handleToggleBan\(user\.id, user\.is_banned \|\| false\)\}/);
  assert.match(source, /aria-label=\{user\.is_banned \? t\('users\.unban'\) \|\| 'Unban' : t\('users\.ban'\) \|\| 'Ban'\}/);

  // Address edit/delete buttons keep their handlers and localized aria-labels.
  assert.match(
    source,
    /onClick=\{\(\) => handleEditAddress\(address\)\}[\s\S]*?aria-label=\{t\('customer\.actions\.editAddress'\)\}/,
  );
  assert.match(
    source,
    /onClick=\{\(\) => handleDeleteAddress\(address\.id\)\}[\s\S]*?aria-label=\{t\('customer\.actions\.deleteAddress'\)\}/,
  );
});

test('users table paginates the rendered rows', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /const USERS_PAGE_SIZE = 10;/);
  assert.match(source, /const \[currentPage, setCurrentPage\] = useState\(1\)/);
  assert.match(source, /const filteredUsers = useMemo/);
  assert.match(source, /const paginatedUsers = useMemo/);
  assert.match(source, /filteredUsers\.slice\(start, start \+ USERS_PAGE_SIZE\)/);
  assert.match(source, /\{paginatedUsers\.map\(\(user\) => \(/);
  assert.match(source, /setCurrentPage\(page => Math\.max\(1, page - 1\)\)/);
  assert.match(source, /setCurrentPage\(page => Math\.min\(totalPages, page \+ 1\)\)/);
  assert.doesNotMatch(source, /\{filteredUsers\.map\(\(user\) => \(/);
});

// Founder 01/11: the windows use the shared glass shell — the shared liquid-glass-modal-backdrop (dimmed and
// blurred page behind) instead of a hand-drawn bg-black/50 backdrop.
test('users detail modal opens through an app-level portal with the shared glass backdrop and shell', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  assert.match(source, /\{showDetailsModal && selectedUser && renderModalPortal\(\s*<div/);
  assert.match(
    source,
    /\{showDetailsModal && selectedUser && renderModalPortal\(\s*<div className="fixed inset-0 z-1200 flex items-center justify-center p-4">\s*<div className="liquid-glass-modal-backdrop" aria-hidden="true" \/>/,
  );
  assert.match(source, /const modalShellClass = 'liquid-glass-modal-shell relative flex w-full flex-col overflow-hidden text-\(--pos-s-fg\)';/);
  assert.match(source, /aria-labelledby=\{detailsTitleId\}\s*className=\{`max-h-\[calc\(100dvh-2rem\)\] max-w-2xl \$\{modalShellClass\}`\}/);
  // Header and footer are separated by the glass line; the one round close X closes through the close-only path.
  assert.match(source, /const modalHeaderClass = 'flex shrink-0 items-start justify-between gap-4 border-b border-\(--modal-glass-line\) p-5';/);
  assert.match(source, /const modalFooterClass = 'flex shrink-0 flex-wrap items-center gap-3 border-t border-\(--modal-glass-line\) p-5';/);
  assert.match(source, /onClick=\{closeDetailsModal\}\s*className="liquid-glass-modal-close"\s*aria-label=\{t\('common\.close', 'Close'\)\}/);
  // Body sections are pos-frost; block is the kit danger button, unblock and Close are neutral kit buttons.
  assert.match(source, /className="pos-frost grid gap-4 rounded-xl border p-4 sm:grid-cols-2"/);
  assert.match(source, /className=\{selectedUser\.is_banned \? secondaryButtonClass : dangerButtonClass\}/);
  assert.match(source, /onClick=\{closeDetailsModal\}\s*className=\{`ml-auto \$\{secondaryButtonClass\}`\}/);
  assert.doesNotMatch(source, /bg-black\/50 backdrop-blur-sm|bg-gray-900 border-gray-700|bg-white\/75|bg-gray-900\/70/);
  // No longer an inline page-contained z-50 modal.
  assert.doesNotMatch(source, /\{showDetailsModal && selectedUser && \(\s*<div/);
  assert.doesNotMatch(source, /className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black\/50"/);
});

test('address delete uses a portaled confirmation modal, not a native confirm dialog', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // Native confirm dialogs are gone.
  assert.doesNotMatch(source, /window\.confirm/);
  assert.doesNotMatch(source, /confirm\(t\(/);
  // Deletion is deferred to an explicit confirm handler behind a portaled, blurred modal.
  assert.match(source, /const \[addressPendingDelete, setAddressPendingDelete\] = useState/);
  assert.match(source, /const confirmDeleteAddress = async \(\) =>/);
  assert.match(source, /\{addressPendingDelete && renderModalPortal\(\s*<div/);
  // Founder 01/11: the shared glass backdrop and shell; neutral Cancel and the kit danger Delete.
  assert.match(
    source,
    /className="fixed inset-0 z-1300 flex items-center justify-center p-4"\s*onClick=\{\(\) => setAddressPendingDelete\(null\)\}\s*>\s*<div className="liquid-glass-modal-backdrop" aria-hidden="true" \/>/,
  );
  assert.match(source, /aria-labelledby=\{deleteAddressTitleId\}\s*className=\{`max-w-md \$\{modalShellClass\}`\}/);
  assert.match(source, /onClick=\{closeAddressDeleteModal\}\s*className="liquid-glass-modal-close"/);
  assert.match(source, /onClick=\{\(\) => void confirmDeleteAddress\(\)\}\s*className=\{dangerButtonClass\}/);
  assert.match(source, /const dangerButtonClass = 'pos-solid-btn pos-solid-btn--md pos-solid-btn--danger';/);
  assert.doesNotMatch(source, /rounded-xl bg-red-600 px-4 py-2/);
});

test('loyalty tier and pagination labels use localized users.* keys', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /t\(`users\.loyaltyTier\.\$\{tierKey\}`/);
  assert.match(source, /t\('users\.pagination\.previous'/);
  assert.match(source, /t\('users\.pagination\.next'/);
  assert.match(source, /t\('users\.pagination\.pageOf'/);
  // Founder 01/11: the range is plain localized words ("1–9 of 9"), the page buttons are kit buttons.
  assert.match(source, /t\('users\.pagination\.range', '\{\{start\}\}–\{\{end\}\} of \{\{total\}\}', \{ start: pageStart, end: pageEnd, total: filteredUsers\.length \}\)/);
  assert.match(source, /setCurrentPage\(page => Math\.max\(1, page - 1\)\)\}\s*disabled=\{activePage === 1\}\s*className=\{smallButtonClass\}/);
  assert.match(source, /setCurrentPage\(page => Math\.min\(totalPages, page \+ 1\)\)\}\s*disabled=\{activePage === totalPages\}\s*className=\{smallButtonClass\}/);
  assert.doesNotMatch(source, /border-yellow-500 text-yellow-700/);
  // Hardcoded English tier/pagination literals are gone.
  assert.doesNotMatch(source, /\{pageStart\}-\{pageEnd\} of \{filteredUsers\.length\}/);
  assert.doesNotMatch(source, /\btier = 'Bronze'/);
  assert.doesNotMatch(source, />\s*Previous\s*<\/button>/);
  assert.doesNotMatch(source, />\s*Next\s*<\/button>/);
});

test('users page translations exist in every POS locale', () => {
  const requiredUsersKeys = [
    'title',
    'description',
    'searchPlaceholder',
    'filterAll',
    'filterCustomers',
    'filterAppUsers',
    'customer',
    'contact',
    'activity',
    'loyalty',
    'status',
    'actions',
    'orders',
    'points',
    'active',
    'banned',
    'deleteAddressTitle',
    'loyaltyTier.bronze',
    'loyaltyTier.silver',
    'loyaltyTier.gold',
    'loyaltyTier.platinum',
    'pagination.previous',
    'pagination.next',
    'pagination.pageOf',
    'pagination.range',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const usersKeys = flattenKeys(locale.users);
    const missing = requiredUsersKeys
      .filter(key => !usersKeys.has(key))
      .map(key => `users.${key}`);

    assert.deepEqual(missing, [], `${file} is missing users page translations`);
  }
});

// Regression contract for the dead filter icon (2026-06-21 review): the funnel was a
// non-interactive lucide graphic (aria "Platform filter") with no handler. It is now a
// real, accessible filter control wired into filteredUsers + pagination.
test('UsersPage filter affordance is an accessible button with a status/loyalty popover', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // The filter trigger is a button with a localized accessible name and expanded state.
  assert.match(
    source,
    /<button\s+type="button"\s+onClick=\{\(\) => setShowFilterMenu\(open => !open\)\}\s+aria-label=\{t\('users\.filters\.openLabel'/,
  );
  assert.match(source, /aria-expanded=\{showFilterMenu\}/);
  assert.match(source, /aria-haspopup="menu"/);
  // It still uses the funnel icon, now inside the button (not a bare graphic).
  assert.match(source, /<Filter className="h-5 w-5" \/>/);

  // The popover exposes status and loyalty options as a menu on the solid kit surface (readable in both themes
  // through the kit tokens; Founder 01/11 replaced the dark/light ternary).
  assert.match(source, /role="menu"/);
  assert.match(source, /USER_STATUS_FILTERS\.map\(option =>/);
  assert.match(source, /USER_LOYALTY_FILTERS\.map\(option =>/);
  assert.match(source, /role="menu"\s*className="[^"]*border border-\(--pos-s-border\) bg-\(--pos-s-surface\) p-3 text-\(--pos-s-fg\) shadow-xl"/);
  // Founder 01/11: the chosen option is the kit selection (yellow with dark words), never a raw bg-yellow-400.
  // The kit option centres its words; a menu row reads from the left (justify-start! outranks the kit rule).
  assert.match(source, /className=\{`pos-choice w-full justify-start! text-left\$\{statusFilter === option \? ' is-selected' : ''\}`\}/);
  assert.match(source, /className=\{`pos-choice w-full justify-start! text-left\$\{loyaltyFilter === option \? ' is-selected' : ''\}`\}/);
  // Click-away closes the popover; it sits above the page/sidebar (high z).
  assert.match(source, /onClick=\{\(\) => setShowFilterMenu\(false\)\}/);
  assert.match(source, /z-1200(?![\w.-])/);
});

// Regression contract for the clipped popover (2026-06-21 retest): with a filter active
// the "Clear filters" button pushed the menu past the bottom of the 1282x802 POS window.
test('UsersPage filter popover is height-bounded with an internal scroll so it never clips the viewport', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // The popover is a bounded flex column capped well below the viewport at 1282x802
  // (the old calc(100vh-15rem) still overflowed below a low search-bar anchor). Founder 01/11: the options are
  // 44 px kit options now, so the cap is 22rem (450 px at 802) — the trigger sits in the toolbar under the hero,
  // and even with the offline banner above it the menu ends inside the window.
  assert.doesNotMatch(source, /max-h-\[calc\(100vh-15rem\)\]/);
  assert.match(source, /role="menu"[\s\S]*?flex max-h-\[calc\(100vh-22rem\)\][^`]*flex-col/);
  // The option lists scroll internally...
  assert.match(source, /min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide/);
  // ...and the Clear filters action (a kit button, Founder 01/11) is pinned (shrink-0) so it stays fully visible.
  assert.match(source, /className=\{`mt-3 shrink-0 w-full \$\{smallButtonClass\}`\}[\s\S]*?users\.filters\.clear/);
});

// Founder 01/11: the polish now comes from the kit — one field look (kitFieldLook) for every field in the
// windows, kit buttons, kit address cards (pos-frost) and a solid kit suggestion list.
test('UsersPage supervisor polish keeps controls rounded, on-palette, and touch-first', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /bg-purple|text-purple|border-purple|ring-purple/);
  assert.match(
    source,
    /const kitFieldLook = 'min-h-\[48px\] rounded-xl border border-\(--pos-s-control\) bg-\(--pos-s-surface\) px-3 text-base font-semibold text-\(--pos-s-fg\) outline-hidden transition-colors placeholder:font-normal placeholder:text-zinc-400 focus:border-\(--pos-s-yellow\) dark:placeholder:text-zinc-500';/,
  );
  assert.match(source, /const fieldClass = `w-full \$\{kitFieldLook\}`;/);
  // Street, city, postal code and floor share the field; the notes are the same field as a textarea.
  assert.equal((source.match(/className=\{fieldClass\}/g) ?? []).length, 4);
  assert.match(source, /className=\{`min-h-20 resize-none py-2\.5 \$\{fieldClass\}`\}/);
  assert.doesNotMatch(source, /focus:ring-yellow-500|w-full px-3 py-2 rounded-2xl text-sm/);
  // The address cards are pos-frost sections of the glass window.
  assert.match(source, /className="pos-frost rounded-xl border p-4"/);
  assert.match(
    source,
    /absolute z-50 mt-1 max-h-60 w-full overflow-y-auto scrollbar-hide rounded-xl border border-\(--pos-s-border\) bg-\(--pos-s-surface\) p-1 text-\(--pos-s-fg\) shadow-xl/,
  );
  // Neutral Cancel then the one yellow Save; address edit / delete are kit icon buttons (delete = danger).
  assert.match(source, /onClick=\{handleCancelEdit\}\s*className=\{secondaryButtonClass\}/);
  assert.match(source, /onClick=\{\(\) => handleSaveAddress\(address\.id\)\}\s*className=\{primaryButtonClass\}/);
  assert.match(source, /onClick=\{\(\) => handleEditAddress\(address\)\}\s*className="pos-icon-btn"/);
  assert.match(source, /onClick=\{\(\) => handleDeleteAddress\(address\.id\)\}\s*className="pos-icon-btn pos-icon-btn--danger"/);
  assert.doesNotMatch(source, /liquid-glass-modal-success|text-red-600 dark:text-red-400/);
});

test('UsersPage empty state shows a no-matches message under search/filters, not "no users yet"', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // Empty description uses the no-matches copy whenever search OR a directory filter
  // is active; users.noUsersYet is reserved for the truly-empty, unconstrained directory.
  assert.match(
    source,
    /searchTerm \|\| filtersActive[\s\S]*?t\('users\.noMatches'\)[\s\S]*?t\('users\.noUsersYet'\)/,
  );
  // The old search-only branch must no longer gate the empty description.
  assert.doesNotMatch(source, /searchTerm \? t\('users\.tryAdjusting'\)/);
});

test('UsersPage status/loyalty filters drive filteredUsers and reset pagination', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // filteredUsers runs the shared search+status+loyalty predicate.
  assert.match(source, /matchesUserDirectoryFilters\(user, \{\s*search: searchTerm,\s*status: statusFilter,\s*loyalty: loyaltyFilter,\s*\}\)/);
  assert.match(source, /\[searchTerm, statusFilter, loyaltyFilter, users\]/);
  // Changing search OR a filter resets to page 1.
  assert.match(source, /setCurrentPage\(1\);\s*\}, \[searchTerm, statusFilter, loyaltyFilter\]\)/);
  // The active-filter indicator is derived for the trigger styling/state.
  assert.match(source, /const filtersActive = hasActiveUserDirectoryFilters\(\{ status: statusFilter, loyalty: loyaltyFilter \}\)/);
});

test('UsersPage filter locale keys exist in every locale (Greek translated)', () => {
  const loadLocale = (lng: string) =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  const requiredKeys = [
    'filters.openLabel',
    'filters.statusLabel',
    'filters.loyaltyLabel',
    'filters.clear',
    'filters.status.all',
    'filters.status.active',
    'filters.status.banned',
    'filters.loyalty.all',
    'loyaltyTier.bronze',
    'loyaltyTier.silver',
    'loyaltyTier.gold',
    'loyaltyTier.platinum',
    'noMatches',
    'noUsersYet',
  ];
  const get = (obj: any, dotted: string) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const users = loadLocale(lng).users;
    for (const key of requiredKeys) {
      const value = get(users, key);
      assert.equal(typeof value, 'string', `${lng}.users.${key} missing`);
      assert.ok(value.length > 0, `${lng}.users.${key} empty`);
    }
  }
  // Greek must be a real translation, not the English source.
  assert.notEqual(loadLocale('el').users.filters.openLabel, loadLocale('en').users.filters.openLabel);
  assert.notEqual(loadLocale('el').users.noMatches, loadLocale('en').users.noMatches);
  assert.match(loadLocale('el').users.noMatches, new RegExp('[\\u0370-\\u03FF]'));
});

// Regression contract for the non-dismissable filter popover (2026-06-21 live QA): the
// role="menu" filter dropdown closed on click-away/toggle but ignored Escape.
test('UsersPage filter popover closes on Escape while open without mutating filter state', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // An Escape effect gated on showFilterMenu (listener only live while the menu is open),
  // reacting to Escape only, preventing default, and closing ONLY the popover.
  assert.match(
    source,
    /if \(!showFilterMenu\) \{\s*return;\s*\}\s*const handleEscape = \(event: KeyboardEvent\) => \{\s*if \(event\.key !== 'Escape'\) \{\s*return;\s*\}\s*event\.preventDefault\(\);\s*setShowFilterMenu\(false\);\s*\};/,
    'Escape must close only the filter popover via setShowFilterMenu(false)',
  );
  // The popover Escape path must not touch the status/loyalty filter setters.
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*setShowFilterMenu\(false\);\s*set(Status|Loyalty)Filter/);
  // Listener registration + cleanup for the filter effect.
  assert.match(source, /document\.addEventListener\('keydown', handleEscape\)/);
  assert.match(source, /document\.removeEventListener\('keydown', handleEscape\)/);
});

// Regression contract for the unlabelled details modal (2026-06-21 live QA): the
// portaled customer-details modal looked modal but exposed no dialog semantics.
test('UsersPage customer details modal exposes labelled dialog semantics', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // Stable title id from useId at the top level.
  assert.match(source, /import React, \{[^}]*\buseId\b[^}]*\} from 'react';/);
  assert.match(source, /const detailsTitleId = useId\(\);/);

  // The portaled details panel declares a labelled dialog wired to the title heading.
  assert.match(
    source,
    /ref=\{detailsDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{detailsTitleId\}/,
    'details modal panel must be a labelled dialog',
  );
  assert.match(
    source,
    /<h3 id=\{detailsTitleId\}[\s\S]*?\{t\('users\.customerDetails'\) \|\| 'Customer Details'\}/,
  );

  // Still portaled outside the page container with a blurred backdrop (no regression; Founder 01/11: the
  // shared glass backdrop).
  assert.match(source, /\{showDetailsModal && selectedUser && renderModalPortal\(/);
  assert.match(
    source,
    /className="fixed inset-0 z-1200 flex items-center justify-center p-4">\s*<div className="liquid-glass-modal-backdrop" aria-hidden="true" \/>/,
  );
});

// Regression contract for the non-dismissable details modal (2026-06-21 live QA): Escape
// did nothing; only the bottom Close button closed it.
test('UsersPage details modal Escape uses the topmost-dialog gate and the close-only path', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // Close-only callback mirrors the footer Close button and never calls ban/delete/save.
  assert.match(
    source,
    /const closeDetailsModal = useCallback\(\(\) => \{\s*setShowDetailsModal\(false\);\s*setSelectedUser\(null\);\s*setUserAddresses\(\[\]\);\s*\+\+customerDetailsGeneration\.current;\s*invalidateAddressSearch\(true\);\s*setEditingAddressId\(null\);\s*setEditedAddress\(\{\}\);\s*\}, \[invalidateAddressSearch\]\);/,
  );
  assert.doesNotMatch(
    source,
    /const closeDetailsModal = useCallback\(\(\) => \{[\s\S]*?(handleToggleBan|confirmDeleteAddress|handleSaveAddress)[\s\S]*?\}, \[invalidateAddressSearch\]\);/,
    'the details close path must not trigger ban/delete/address-save side effects',
  );

  // Escape effect gated on showDetailsModal, topmost-[role="dialog"] gated, routed to close-only.
  assert.match(source, /if \(!showDetailsModal\) \{\s*return;\s*\}/);
  assert.match(source, /const dialogs = Array\.from\(document\.querySelectorAll\('\[role="dialog"\]'\)\);/);
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== detailsDialogRef\.current/);
  assert.match(source, /event\.preventDefault\(\);\s*closeDetailsModal\(\);/);

  // The footer Close button routes through the same close-only callback.
  assert.match(source, /onClick=\{closeDetailsModal\}/);

  // No Escape handler routes to the side-effecting submit handlers.
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*void confirmDeleteAddress\(\)/);
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*handleToggleBan/);
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*void handleSaveAddress/);

  // The ban + delete actions remain wired only to their own buttons.
  assert.match(source, /handleToggleBan\(selectedUser\.id, selectedUser\.is_banned \|\| false\)/);
  assert.match(source, /onClick=\{\(\) => void confirmDeleteAddress\(\)\}/);
});

// Regression contract for out-of-order Escape (2026-06-21 live QA): the nested address-
// delete confirmation must itself be a [role="dialog"] so it becomes the topmost dialog
// and the details modal Escape handler self-suppresses while it is open.
test('UsersPage address-delete confirmation is a labelled dialog the details Escape gate yields to', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /const deleteAddressTitleId = useId\(\);/);
  assert.match(
    source,
    /role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{deleteAddressTitleId\}/,
    'the address-delete confirmation must be a labelled dialog so the topmost gate yields to it',
  );
  assert.match(
    source,
    /<h3 id=\{deleteAddressTitleId\}[\s\S]*?\{t\('users\.deleteAddressTitle', 'Delete address'\)\}/,
  );
  // Its existing cancel/confirm behavior is unchanged.
  assert.match(source, /onClick=\{\(\) => setAddressPendingDelete\(null\)\}/);
  assert.match(source, /onClick=\{\(\) => void confirmDeleteAddress\(\)\}/);
});

// Regression contract for the dead Escape on the address-delete confirmation (2026-06-21
// live QA): the confirmation was a labelled dialog (so the details modal self-suppressed)
// but had NO Escape handler of its own, so Escape closed nothing while it was topmost. It
// must close ITSELF on Escape via a close-only path, leaving the parent detail modal open.
test('UsersPage address-delete confirmation closes itself on Escape (topmost), leaving the details modal open', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // The confirmation panel carries a ref so the topmost-[role="dialog"] gate can target it.
  assert.match(source, /const deleteAddressDialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(
    source,
    /ref=\{deleteAddressDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{deleteAddressTitleId\}/,
    'the confirmation panel must wire deleteAddressDialogRef onto the labelled dialog',
  );

  // Close-only callback: its exact body clears the pending target only - no other call,
  // so it cannot trigger confirmDeleteAddress.
  assert.match(
    source,
    /const closeAddressDeleteModal = useCallback\(\(\) => \{\s*setAddressPendingDelete\(null\);\s*\}, \[\]\);/,
  );

  // A confirmation-owned Escape effect: gated on addressPendingDelete, topmost-gated against
  // its own ref, routed to the close-only path.
  assert.match(source, /if \(!addressPendingDelete\) \{\s*return;\s*\}/);
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== deleteAddressDialogRef\.current/);
  assert.match(source, /event\.preventDefault\(\);\s*closeAddressDeleteModal\(\);/);

  // The details modal's Escape effect yields: it self-suppresses unless IT is the topmost
  // dialog, so the confirmation (mounted above) closes first and the detail modal stays open.
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== detailsDialogRef\.current/);

  // Escape never routes to the delete submit (dismissal can't delete).
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*(void )?confirmDeleteAddress/);

  // All three Escape listeners (filter popover + details + confirmation) register and clean up.
  const adds = source.match(/document\.addEventListener\('keydown', handleEscape\)/g) ?? [];
  const removes = source.match(/document\.removeEventListener\('keydown', handleEscape\)/g) ?? [];
  assert.ok(adds.length >= 3, `expected >=3 keydown registrations (filter + details + confirmation), found ${adds.length}`);
  assert.ok(removes.length >= 3, 'each Escape listener must be cleaned up');
});

test('UsersPage deletes addresses through the local-first customer bridge', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /bridge\.customers\.deleteAddress\(selectedUser\.id, addressId\)/);
  assert.doesNotMatch(
    source,
    /Deleting an address requires an online connection/,
    'address deletion must queue offline instead of being blocked by navigator.onLine',
  );
  assert.doesNotMatch(
    source,
    /posApiFetch<any>\(`pos\/customers\/\$\{selectedUser\.id\}\/addresses\/\$\{addressId\}`/,
    'the Users page must not bypass the native customer sync path',
  );
});
