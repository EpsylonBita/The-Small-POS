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

test('users page search and filter controls use neutral grey chrome', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /resolvedTheme === 'dark' \? 'bg-zinc-900\/70' : 'bg-gray-100'/);
  assert.match(source, /bg-zinc-800 text-white border-zinc-600 focus:ring-white\/40 focus:border-white\/70/);
  assert.match(source, /bg-white text-gray-900 border-gray-300 focus:ring-gray-400 focus:border-gray-500/);
  // The filter trigger button is positioned at the input's right edge.
  assert.match(source, /className=\{`absolute right-2 top-1\/2 -translate-y-1\/2 rounded-2xl p-1\.5 transition-transform/);
  assert.doesNotMatch(source, /bg-gray-800\/50' : 'bg-white'[\s\S]*focus:ring-blue-500 focus:border-blue-500/);
  assert.doesNotMatch(source, /<select/);
});

test('users table uses yellow header neutral rows and wrapperless chips', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /<thead className="bg-yellow-400">/);
  assert.match(source, /text-xs font-semibold uppercase tracking-wider text-black/);
  assert.match(source, /resolvedTheme === 'dark' \? 'bg-zinc-950' : 'bg-gray-100'/);
  assert.match(source, /resolvedTheme === 'dark' \? 'active:bg-zinc-900' : 'active:bg-gray-200'/);
  assert.match(source, /'text-orange-700 dark:text-orange-500'/);
  assert.match(source, /'text-amber-500 dark:text-amber-300'/);
  assert.match(source, /'text-yellow-500 dark:text-yellow-400'/);
  assert.match(source, /<Mail className="w-4 h-4 mr-2 text-yellow-500" \/>/);
  assert.match(source, /<Phone className="w-4 h-4 mr-2 text-yellow-500" \/>/);
  assert.match(source, /<ShoppingBag className="w-4 h-4 mr-2 text-green-500" \/>/);
  assert.match(source, /inline-flex items-center text-xs font-medium text-green-500 dark:text-green-400/);
  assert.match(source, /inline-flex items-center text-xs font-medium text-red-500 dark:text-red-400/);
  assert.match(source, /inline-flex items-center text-xs font-medium \$\{color\}/);
  assert.doesNotMatch(source, /bg-yellow-100 text-yellow-800 dark:bg-yellow-900\/20/);
  assert.doesNotMatch(source, /bg-green-100 text-green-800 dark:bg-green-900\/20/);
  assert.doesNotMatch(source, /text-blue-600 dark:text-blue-400 hover:text-blue-900/);
  assert.doesNotMatch(source, /purple-/);
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

  // Round 262: the header refresh button is amber glass (was a stark black/white inversion square),
  // touch-first with active press feedback and no hover. The old black/white classes are gone.
  assert.match(source, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(source, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  // Behaviour/shape preserved: disabled guard, 44px square, spinner, active feedback, neutral disabled.
  assert.match(source, /disabled=\{loading\}/);
  assert.match(source, /h-12 w-12/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /loading \? 'opacity-60 cursor-not-allowed' : 'active:scale-95'/);
  assert.match(source, /active:scale-95/);

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

test('users detail modal opens through an app-level portal with a blurred high-z backdrop', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  assert.match(source, /\{showDetailsModal && selectedUser && renderModalPortal\(\s*<div/);
  assert.match(
    source,
    /className="fixed inset-0 z-\[1200\] flex items-center justify-center p-4 bg-black\/50 backdrop-blur-sm"/,
  );
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
  assert.match(
    source,
    /className="fixed inset-0 z-\[1300\] flex items-center justify-center p-4 bg-black\/50 backdrop-blur-sm"/,
  );
  assert.match(source, /onClick=\{\(\) => void confirmDeleteAddress\(\)\}/);
});

test('loyalty tier and pagination labels use localized users.* keys', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /t\(`users\.loyaltyTier\.\$\{tierKey\}`/);
  assert.match(source, /t\('users\.pagination\.previous'/);
  assert.match(source, /t\('users\.pagination\.next'/);
  assert.match(source, /t\('users\.pagination\.pageOf'/);
  // Hardcoded English tier/pagination literals are gone.
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

  // The popover exposes status and loyalty options as a menu with readable dark/light colors.
  assert.match(source, /role="menu"/);
  assert.match(source, /USER_STATUS_FILTERS\.map\(option =>/);
  assert.match(source, /USER_LOYALTY_FILTERS\.map\(option =>/);
  assert.match(source, /'bg-zinc-900 border-zinc-700 text-white'/);
  assert.match(source, /'bg-white border-gray-200 text-gray-900'/);
  // Click-away closes the popover; it sits above the page/sidebar (high z).
  assert.match(source, /onClick=\{\(\) => setShowFilterMenu\(false\)\}/);
  assert.match(source, /z-\[1200\]/);
});

// Regression contract for the clipped popover (2026-06-21 retest): with a filter active
// the "Clear filters" button pushed the menu past the bottom of the 1282x802 POS window.
test('UsersPage filter popover is height-bounded with an internal scroll so it never clips the viewport', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // The popover is a bounded flex column capped well below the viewport at 1282x802
  // (the old calc(100vh-15rem) still overflowed below a low search-bar anchor).
  assert.doesNotMatch(source, /max-h-\[calc\(100vh-15rem\)\]/);
  assert.match(source, /role="menu"[\s\S]*?flex max-h-\[calc\(100vh-28rem\)\][^`]*flex-col/);
  // The option lists scroll internally...
  assert.match(source, /min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide/);
  // ...and the Clear filters action is pinned (shrink-0) so it stays fully visible.
  assert.match(source, /mt-3 shrink-0 w-full rounded-2xl border[\s\S]*?users\.filters\.clear/);
});

test('UsersPage supervisor polish keeps controls rounded, on-palette, and touch-first', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /bg-purple|text-purple|border-purple|ring-purple/);
  assert.match(source, /w-full pl-10 pr-12 py-2 rounded-2xl/);
  assert.match(source, /rounded-2xl px-3 py-1\.5 text-left text-sm transition-transform active:scale-\[0\.98\]/);
  assert.match(source, /rounded-2xl border px-3 py-2 font-medium transition-transform active:scale-\[0\.98\]/);
  assert.match(source, /p-4 rounded-2xl border/);
  assert.match(source, /absolute z-50 w-full mt-1 rounded-2xl shadow-lg max-h-60 overflow-y-auto scrollbar-hide/);
  assert.match(source, /w-full px-3 py-2 rounded-2xl text-sm/);
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

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
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

  // Still portaled outside the page container with a blurred backdrop (no regression).
  assert.match(source, /\{showDetailsModal && selectedUser && renderModalPortal\(/);
  assert.match(
    source,
    /className="fixed inset-0 z-\[1200\] flex items-center justify-center p-4 bg-black\/50 backdrop-blur-sm"/,
  );
});

// Regression contract for the non-dismissable details modal (2026-06-21 live QA): Escape
// did nothing; only the bottom Close button closed it.
test('UsersPage details modal Escape uses the topmost-dialog gate and the close-only path', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  // Close-only callback mirrors the footer Close button and never calls ban/delete/save.
  assert.match(
    source,
    /const closeDetailsModal = useCallback\(\(\) => \{\s*setShowDetailsModal\(false\);\s*setSelectedUser\(null\);\s*setUserAddresses\(\[\]\);\s*\}, \[\]\);/,
  );
  assert.doesNotMatch(
    source,
    /const closeDetailsModal = useCallback\(\(\) => \{[\s\S]*?(handleToggleBan|confirmDeleteAddress|handleSaveAddress)[\s\S]*?\}, \[\]\);/,
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
