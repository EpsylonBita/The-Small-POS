import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sidebarPath = path.join(projectRoot, 'src', 'renderer', 'components', 'NavigationSidebar.tsx');

function getLogoutBlock(source: string): string {
  const start = source.indexOf('{/* Logout Button */}');
  assert.notEqual(start, -1, 'logout button block should exist');

  const end = source.indexOf('</button>', start);
  assert.notEqual(end, -1, 'logout button should close');

  return source.slice(start, end);
}

// Round 236: tables/rooms/appointments/services are now reached through the Orders hub, so they
// are filtered out of the navigation rail (the pages/routes/guards themselves are untouched).
test('navigation sidebar hides hub-migrated modules from the rail (Round 236)', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  assert.match(source, /const HUB_MIGRATED_NAV_IDS = new Set<string>\(\[/);
  const setStart = source.indexOf('HUB_MIGRATED_NAV_IDS = new Set');
  const setBlock = source.slice(setStart, source.indexOf(']);', setStart));
  for (const id of ['tables', 'rooms', 'appointments', 'services', 'service_catalog']) {
    assert.ok(setBlock.includes(`'${id}'`), `HUB_MIGRATED_NAV_IDS should include ${id}`);
  }

  // The raw modules from context are filtered before everything downstream consumes them.
  assert.match(source, /const \{ navigationModules: rawNavigationModules, isLoading \} = useModules\(\);/);
  assert.match(
    source,
    /rawNavigationModules\.filter\(\(navModule\) => !HUB_MIGRATED_NAV_IDS\.has\(navModule\.module\.id\)\)/,
  );
});

test('navigation sidebar logout button uses transparent red outline without hover fill', () => {
  const source = readFileSync(sidebarPath, 'utf8');
  const logoutBlock = getLogoutBlock(source);

  assert.match(logoutBlock, /border border-red-500\/70 bg-transparent text-red-500/);
  assert.match(logoutBlock, /<LogOut className="w-5 h-5 text-red-500" strokeWidth=\{2\} \/>/);
  assert.doesNotMatch(logoutBlock, /hover:bg-red/);
  assert.doesNotMatch(logoutBlock, /hover:border-red/);
  assert.doesNotMatch(logoutBlock, /hover:text-red/);
  assert.doesNotMatch(logoutBlock, /hover:scale/);
});

test('navigation sidebar opens settings through the modal callback without shift gating', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  assert.match(
    source,
    /if \(id === 'settings'\) \{\s*onOpenSettings && onOpenSettings\(\);\s*return;\s*\}/,
  );
});

test('navigation sidebar no longer includes the swipe-to-hide collapse layer', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  assert.doesNotMatch(source, /isCollapsed/);
  assert.doesNotMatch(source, /handleSwipe/);
  assert.doesNotMatch(source, /finishSwipeGesture/);
  assert.doesNotMatch(source, /NAVIGATION_SWIPE/);
  assert.doesNotMatch(source, /-translate-x-\[calc\(100%-0\.75rem\)\]/);
});

test('navigation sidebar touch movement scrolls while long press drag remains available', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  assert.match(source, /const NAVIGATION_DRAG_HOLD_MS = 280;/);
  assert.match(source, /const NAVIGATION_DRAG_SCROLL_CANCEL_THRESHOLD_PX = 8;/);
  assert.match(source, /const scrollNavigationFromPointer = \(session: NavigationDragSession, clientY: number\) => \{/);
  assert.match(source, /session\.isScrolling = true;/);
  assert.match(source, /scrollContainer\.scrollTop = Math\.max\(0, Math\.min\(session\.scrollStartTop - deltaY, maxScrollTop\)\);/);
  assert.match(source, /style=\{\{ touchAction: isComingSoon \? 'pan-y' : 'none' \}\}/);
  assert.match(source, /beginModuleDrag\(session\);/);
});

// Round 168 (live QA): native `title` tooltips are hover behaviour on a touchscreen, so the
// sidebar must use aria-label only. Accessible names (including coming-soon / locked-module
// wording) are preserved.
test('navigation sidebar uses aria-labels and no native title tooltips', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // No native browser tooltip anywhere in the sidebar.
  assert.doesNotMatch(source, /\btitle=\{/);

  // Static action buttons carry localized aria-labels.
  assert.match(source, /aria-label=\{t\('navigation\.checkIn'\)\}/);
  assert.match(source, /aria-label=\{t\('navigation\.zReport'\)\}/);
  assert.match(source, /aria-label=\{t\('navigation\.settings'\)\}/);
  assert.match(source, /aria-label=\{t\('navigation\.logout'\)\}/);

  // Module buttons expose the computed accessible label (preserving coming-soon / locked / plain
  // module semantics) via aria-label, not a tooltip.
  assert.match(source, /aria-label=\{accessibleLabel\}/);
  assert.match(source, /accessibleLabel = t\('modules\.comingSoon'/);
  assert.match(source, /accessibleLabel = t\('modules\.lockedModule'/);
  assert.match(source, /accessibleLabel = moduleLabel;/);

  // Coming-soon modules stay disabled/non-clickable; the stale "just show tooltip" comment is gone.
  assert.match(source, /disabled=\{isComingSoon\}/);
  assert.doesNotMatch(source, /just show tooltip/);
});

// Restoration guard (round 186, updated round 190): unlocked INACTIVE nav icons are QUIET NEUTRAL --
// black in light, a dark-safe neutral grey (text-zinc-400) in dark; ONLY the active/current route
// gets the per-module neon color + glow. The same inactive-neutral rule applies to Check In + Settings.
test('navigation sidebar inactive unlocked icons are neutral, only the active route uses per-module neon', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // getNeonClass: inactive returns neutral text (grey in dark, black in light), neon only when active.
  assert.match(source, /const getNeonClass = \(color: string, isActive: boolean, theme: string\) => \{/);
  assert.match(
    source,
    /if \(!isActive\) \{[\s\S]*?return theme === 'dark' \? 'text-zinc-400' : 'text-black';/,
  );

  // ACCESSIBILITY / design: the dark inactive branch must be a dark-safe grey -- NOT literal black
  // (invisible on the black rail) and NOT white/white-neon (too bright; only the active route glows).
  assert.doesNotMatch(source, /if \(!isActive\) \{[\s\S]*?return theme === 'dark' \? 'text-black'/);
  assert.doesNotMatch(source, /if \(!isActive\) \{[\s\S]*?return theme === 'dark' \? 'text-white'/);

  // Active route uses the per-module neon color + glow (green/orange/purple/... with drop-shadow).
  assert.match(source, /case 'green':\s*return 'text-green-500 drop-shadow-\[0_0_10px_rgba\(34,197,94,0\.9\)\]'/);
  assert.match(source, /case 'orange':\s*return 'text-\[#f97316\] drop-shadow-/);

  // Active is the current route, and the module icon is tinted via getNeonClass(color, isActive, theme).
  assert.match(source, /const isActive = currentView === module\.id;/);
  assert.match(source, /getNeonClass\(color, isActive, resolvedTheme\)/);

  // Check In + Settings buttons follow the SAME inactive-neutral rule via getNeonClass (not a
  // hardcoded text-zinc-100/900), and the Settings icon has no nested color override (wrapper
  // controls it). Logout stays its own red.
  assert.match(source, /data-testid="check-in-btn"[\s\S]*?getNeonClass\('yellow', false, resolvedTheme\)/);
  assert.match(source, /<Settings className="w-5 h-5" \/>/);
  assert.doesNotMatch(source, /text-zinc-100|text-zinc-900/);
  assert.match(source, /border border-red-500\/70 bg-transparent text-red-500/);
});

// Round 201 (dashboard shell selected-state semantics, live QA): module nav buttons were plain
// buttons with no current-page semantics, so assistive tech couldn't tell which route is the current
// page. The active module (currentView === module.id) now exposes aria-current="page"; inactive
// modules get no aria-current. Built from the existing isActive flag, no visual/icon/drag change.
test('navigation sidebar marks the active module route with aria-current="page" (inactive get none)', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // The current-page semantics derive from the existing isActive = currentView === module.id flag.
  assert.match(source, /const isActive = currentView === module\.id;/);
  assert.match(source, /aria-current=\{isActive \? 'page' : undefined\}/);

  // Never hardcoded always-on (so inactive modules don't all claim to be the current page).
  assert.doesNotMatch(source, /aria-current="page"/);

  // No native title tooltip introduced by the change.
  assert.doesNotMatch(source, /\btitle=\{/);
});

// Round 201 correction (live QA): the Windows UIA tree did not expose aria-current as a state, so the
// active module's accessible NAME itself must announce it — only when isActive, built from the
// localized navigation.currentPage key (derived, never always-on). Inactive keeps the plain label.
test('navigation sidebar bakes the current-page state into the active module accessible name', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // The current-page label is applied only in the isActive branch, via the localized key + {{label}}.
  assert.match(
    source,
    /\} else if \(isActive\) \{[\s\S]*?accessibleLabel = t\('navigation\.currentPage', \{\s*label: moduleLabel,/,
  );
  // Inactive modules still fall through to the plain moduleLabel (state is not hardcoded onto them).
  assert.match(source, /\} else \{\s*accessibleLabel = moduleLabel;\s*\}/);

  // The new key exists and carries the {{label}} placeholder in every POS locale.
  const loadLocale = (lng: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lng}.json`), 'utf8'));
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = (loadLocale(lng).navigation as Record<string, unknown>).currentPage;
    assert.equal(typeof value, 'string', `${lng} navigation.currentPage missing`);
    assert.ok((value as string).includes('{{label}}'), `${lng} navigation.currentPage must interpolate {{label}}`);
  }
});

// Round 223 (live POS QA, touch reachability): with many modules enabled the rail scrolls, and Settings
// and Logout used to sit at the very end of the SAME scrollable nav list, so the operator had to scroll
// the icon rail to reach them. The rail is now a flex column: a persistent top action area (Check In),
// a min-h-0 overflow-y-auto MODULE-SCROLL region (scrollContainerRef — the active-module auto-scroll and
// drag target), and a PERSISTENT bottom utility cluster (Z Report, Settings, Logout) that lives OUTSIDE
// the scroll region so it is always reachable without scrolling the modules.
test('navigation sidebar pins Z Report / Settings / Logout in a persistent utility cluster outside the module scroll', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // Stable markers exist for the module-scroll region and the utility cluster.
  assert.match(source, /data-navigation-module-scroll/);
  assert.match(source, /data-navigation-utility-actions/);

  // scrollContainerRef now lives on the module-scroll region (not the whole rail), and that region is the
  // one that scrolls (overflow-y-auto) and flexes (min-h-0 / flex-1).
  assert.match(
    source,
    /data-navigation-module-scroll[\s\S]*?ref=\{scrollContainerRef\}[\s\S]*?overflow-y-auto/,
  );
  assert.match(source, /const scrollContainerRef = useRef<HTMLDivElement>\(null\)/);
  // The active-module auto-scroll still targets scrollContainerRef (the module-scroll region).
  assert.match(source, /const container = scrollContainerRef\.current;/);
  // The module list still drags/scrolls inside scrollContainerRef (guards from the drag test preserved).
  assert.match(source, /const scrollContainer = scrollContainerRef\.current;/);

  // Region boundaries: module scroll comes BEFORE the utility cluster, and the module map renders inside
  // the scroll region while the three utilities render inside the cluster (outside the scroll region).
  const moduleScrollIdx = source.indexOf('data-navigation-module-scroll');
  const utilityIdx = source.indexOf('data-navigation-utility-actions');
  const navEnd = source.indexOf('</nav>', utilityIdx);
  assert.notEqual(moduleScrollIdx, -1);
  assert.notEqual(utilityIdx, -1);
  assert.notEqual(navEnd, -1);
  assert.ok(moduleScrollIdx < utilityIdx, 'module scroll region must come before the utility cluster');

  const moduleScrollRegion = source.slice(moduleScrollIdx, utilityIdx);
  const utilityCluster = source.slice(utilityIdx, navEnd);

  // The module list (drag/reorder map) lives in the scroll region, and the scroll region flexes.
  assert.match(moduleScrollRegion, /orderedNavigationModules\.map\(\(navModule\) => \{/);
  assert.match(moduleScrollRegion, /min-h-0/);
  assert.match(moduleScrollRegion, /flex-1/);
  assert.match(moduleScrollRegion, /overflow-y-auto/);

  // Z Report, Settings and Logout are all inside the persistent utility cluster...
  assert.match(utilityCluster, /\{\/\* Z Report Button \*\/\}/);
  assert.match(utilityCluster, /\{\/\* Settings Button \*\/\}/);
  assert.match(utilityCluster, /\{\/\* Logout Button \*\/\}/);
  // ...and NOT inside the scrollable module region.
  assert.doesNotMatch(moduleScrollRegion, /\{\/\* Z Report Button \*\/\}/);
  assert.doesNotMatch(moduleScrollRegion, /\{\/\* Settings Button \*\/\}/);
  assert.doesNotMatch(moduleScrollRegion, /\{\/\* Logout Button \*\/\}/);

  // Z Report sits above Settings, which sits above Logout (utility ordering preserved).
  assert.ok(
    utilityCluster.indexOf('Z Report Button') < utilityCluster.indexOf('Settings Button'),
    'Z Report should sit above Settings in the utility cluster',
  );
  assert.ok(
    utilityCluster.indexOf('Settings Button') < utilityCluster.indexOf('Logout Button'),
    'Settings should sit above Logout in the utility cluster',
  );

  // Check In stays the top persistent action, above the module scroll region.
  const checkInIdx = source.indexOf('data-testid="check-in-btn"');
  assert.ok(checkInIdx !== -1 && checkInIdx < moduleScrollIdx, 'Check In stays above the module scroll region');

  // Touch-first: the persistent cluster adds no hover-only behaviour and no native title tooltip.
  assert.doesNotMatch(utilityCluster, /hover:/);
  assert.doesNotMatch(source, /\btitle=\{/);

  // Logout keeps its red outline inside the cluster; Settings stays neutral (getNeonClass inactive),
  // not always-on neon.
  assert.match(utilityCluster, /border border-red-500\/70 bg-transparent text-red-500/);
  assert.match(utilityCluster, /<Settings className="w-5 h-5" \/>[\s\S]*?<\/button>/);
  assert.match(utilityCluster, /getNeonClass\('yellow', false, resolvedTheme\)/);
});

// Round 232 (live QA, touch discoverability): the module rail scrolls with a hidden scrollbar, so after
// moving between views a module like Παραγγελίες can sit above the fold with no visible hint that the icon
// list scrolls. Subtle top/bottom edge-fade caps appear only when the module-scroll region can scroll
// up/down. Round 299 (live QA) REMOVED the standalone amber pill that used to sit inside each cap: in the
// collapsed rail it read like a broken inactive nav item / selected indicator and violated the selected-only
// neon rule (inactive nav area must stay black/white/neutral; only the active route shows neon). The caps
// are now a NEUTRAL black/white gradient fade only -- decorative (pointer-events-none + aria-hidden), no
// visible text, no coloured dash, and they never move the pinned Check In / Z Report / Settings / Logout.
test('Round 232/299: navigation sidebar shows NEUTRAL-fade scroll-hint caps (no coloured pill) for the module-scroll region only', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // Top/bottom scrollability state.
  assert.match(source, /const \[canScrollUp, setCanScrollUp\] = useState\(false\)/);
  assert.match(source, /const \[canScrollDown, setCanScrollDown\] = useState\(false\)/);

  // Scroll-listener effect: derives the hints from the module-scroll container geometry, listens to
  // 'scroll', and re-runs when the module list/order, available height, or current view change.
  assert.match(source, /const container = scrollContainerRef\.current;/);
  assert.match(source, /setCanScrollUp\(scrollTop > threshold\)/);
  assert.match(source, /setCanScrollDown\(scrollTop \+ clientHeight < scrollHeight - threshold\)/);
  assert.match(source, /container\.addEventListener\('scroll', updateScrollHints, \{ passive: true \}\)/);
  assert.match(source, /container\.removeEventListener\('scroll', updateScrollHints\)/);
  assert.match(source, /\}, \[currentView, orderedNavigationModules, availableHeight\]\);/);

  // Stable markers: a relative affordance frame wrapping the scroll region + the two caps.
  assert.match(source, /data-navigation-scroll-affordance className="relative flex min-h-0 flex-1 flex-col"/);

  // Scope to the affordance frame (frame -> utility cluster).
  const frameStart = source.indexOf('data-navigation-scroll-affordance');
  assert.notEqual(frameStart, -1, 'affordance frame must exist');
  const utilStart = source.indexOf('data-navigation-utility-actions', frameStart);
  const frame = source.slice(frameStart, utilStart);

  // Top cap shown only when can scroll up; bottom only when can scroll down.
  assert.match(frame, /\{canScrollUp && \(\s*<div\s+aria-hidden="true"\s+data-navigation-scroll-hint-top/);
  assert.match(frame, /\{canScrollDown && \(\s*<div\s+aria-hidden="true"\s+data-navigation-scroll-hint-bottom/);

  // Both caps are decorative overlays (pointer-events-none) + aria-hidden.
  assert.ok((frame.match(/pointer-events-none absolute inset-x-0/g) || []).length >= 2, 'both caps are pointer-events-none overlays');
  assert.ok((frame.match(/aria-hidden="true"/g) || []).length >= 2, 'both caps are aria-hidden');

  // Round 299: the standalone coloured pill is gone -- no `h-1 w-6 ... bg-amber` dash anywhere in the
  // affordance frame (the drag-reorder drop-slots are a different `h-1 w-8` element and are not caps).
  assert.doesNotMatch(frame, /h-1 w-6 rounded-full bg-amber/);

  // Each cap is a NEUTRAL black/white gradient edge-fade OVERLAY ONLY -- a self-closing <div> with no inner
  // element, no amber/yellow, no off-theme colour. This is the selected-only neon rule: the inactive nav
  // area stays neutral; only the active route icon is neon (asserted elsewhere).
  const topIdx = frame.indexOf('data-navigation-scroll-hint-top');
  const topCap = frame.slice(topIdx, frame.indexOf('/>', topIdx) + 2);
  const botIdx = frame.indexOf('data-navigation-scroll-hint-bottom');
  const bottomCap = frame.slice(botIdx, frame.indexOf('/>', botIdx) + 2);
  for (const cap of [topCap, bottomCap]) {
    assert.match(cap, /bg-gradient-to-[bt]/);
    assert.match(cap, /from-black|from-white/);
    assert.match(cap, /to-transparent/);
    // No coloured dash / pill: no inner element and no amber/yellow tokens.
    assert.doesNotMatch(cap, /<span/);
    assert.doesNotMatch(cap, /bg-amber|text-amber|border-amber/);
    assert.doesNotMatch(cap, /yellow/);
    assert.doesNotMatch(cap, /blue|purple|orange/);
    assert.doesNotMatch(cap, /hover:/);
    assert.doesNotMatch(cap, /\btitle=/);
  }

  // Whole-file touch-first invariants preserved.
  assert.doesNotMatch(source, /\btitle=\{/);
  assert.doesNotMatch(source, /\bhover:/);

  // Utilities (Z Report/Settings/Logout) stay OUTSIDE the module scroll: the affordance frame comes before
  // the utility cluster, and the cluster carries no scroll-hint caps.
  assert.ok(frameStart < utilStart, 'scroll affordance frame must come before the utility cluster');
  const utility = source.slice(utilStart, source.indexOf('</nav>', utilStart));
  assert.doesNotMatch(utility, /data-navigation-scroll-hint/);
});

// Round 302 (live QA, touchscreen) + correction: after closing Settings the inactive Settings control kept
// a heavy NATIVE focus rectangle that read like a selected state on this touch POS. First pass used a plain
// focus-visible ring, but Codex re-QA showed that tapping a modal's close X (pointer) and returning focus to
// the opener via .focus() STILL painted the yellow ring (Chromium's focus-visible heuristic). The robust fix
// is an explicit input-modality guard: focus:outline-none is ALWAYS on; the yellow ring class is attached
// ONLY while keyboard modality is active. Window-level capture-phase listeners flip modality -- keydown ->
// keyboard (ring), pointerdown anywhere (incl. the modal close tap) -> pointer (no ring) BEFORE focus
// returns. No hover; active/tap feedback and the inactive/active neon-colour logic are unchanged.
test('Round 302: sidebar focus ring is gated by an input-modality guard (pointer/touch shows no ring; keyboard does)', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // The native outline is removed ALWAYS (base); the yellow keyboard ring is a separate variant layered on
  // top of the base via focus-visible only.
  assert.match(source, /const SIDEBAR_FOCUS_BASE = 'rounded-xl focus:outline-none';/);
  assert.match(
    source,
    /const SIDEBAR_FOCUS_RING_KEYBOARD = `\$\{SIDEBAR_FOCUS_BASE\} focus-visible:ring-2 focus-visible:ring-yellow-400\/70`;/,
  );

  // Input-modality state + window-level capture listeners: keydown -> keyboard mode, pointerdown -> pointer
  // mode (capture phase, so a modal-close tap flips modality before focus returns to the opener).
  assert.match(source, /const \[keyboardMode, setKeyboardMode\] = useState\(false\)/);
  assert.match(source, /const onKeyDown = \(\) => setKeyboardMode\(true\)/);
  assert.match(source, /const onPointerDown = \(\) => setKeyboardMode\(false\)/);
  assert.match(source, /window\.addEventListener\('keydown', onKeyDown, true\)/);
  assert.match(source, /window\.addEventListener\('pointerdown', onPointerDown, true\)/);

  // The ring is GATED on keyboardMode: keyboard -> ring variant, pointer/touch -> base (NO ring).
  assert.match(source, /const sidebarFocusRing = keyboardMode \? SIDEBAR_FOCUS_RING_KEYBOARD : SIDEBAR_FOCUS_BASE;/);

  // No plain focus:ring- (it would show after a pointer/touch tap); only focus-visible:ring, and only in the
  // keyboard variant.
  assert.doesNotMatch(source, /focus:ring-/);
  assert.match(source, /focus-visible:ring-2 focus-visible:ring-yellow-400\/70/);

  // The gated value is applied to the 5 sidebar icon buttons (Check In / modules / Z Report / Settings /
  // Logout).
  const refs = source.match(/\$\{sidebarFocusRing\}/g) || [];
  assert.ok(refs.length >= 5, `expected the gated focus ring on >=5 sidebar buttons, found ${refs.length}`);
  assert.match(source, /data-testid="check-in-btn"[\s\S]*?\$\{sidebarFocusRing\}/, 'Check In button');
  assert.match(source, /relative w-12 h-12[\s\S]*?\$\{sidebarFocusRing\} \$\{isComingSoon/, 'module button');
  assert.match(source, /onClick=\{handleOpenZ\}[\s\S]*?\$\{sidebarFocusRing\}/, 'Z Report button');
  assert.match(source, /onClick=\{handleOpenSettings\}[\s\S]*?\$\{sidebarFocusRing\}/, 'Settings button');
  assert.match(source, /onClick=\{onLogout\}[\s\S]*?\$\{sidebarFocusRing\}/, 'Logout button');

  // No hover utilities anywhere (touch-first); active/tap feedback stays.
  assert.doesNotMatch(source, /hover:/);
  assert.match(source, /active:scale-95/);

  // The inactive/active neon-colour logic is untouched: inactive unlocked icons stay neutral (grey in dark,
  // black in light); only the active route gets neon. (Also covered by the inactive-neutral test above.)
  assert.match(
    source,
    /if \(!isActive\) \{[\s\S]*?return theme === 'dark' \? 'text-zinc-400' : 'text-black';/,
  );
});

// Round 348 (live QA regression hardening): inactive sidebar icons carry NO neon/drop-shadow; only the
// active route glows; and the rail stays touch-first (no hover/group-hover). Source already matches; this
// locks the inactive-no-glow + active-glow-count + no-hover contract.
test('Round 348: sidebar inactive icons have no glow, active-only neon, no hover utilities', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  // The getNeonClass inactive branch returns a plain neutral with NO drop-shadow glow.
  const inactiveStart = source.indexOf('if (!isActive)', source.indexOf('const getNeonClass ='));
  assert.notEqual(inactiveStart, -1, 'getNeonClass inactive branch must exist');
  const inactiveBranch = source.slice(inactiveStart, source.indexOf('}', inactiveStart));
  assert.match(inactiveBranch, /return theme === 'dark' \? 'text-zinc-400' : 'text-black';/);
  assert.doesNotMatch(inactiveBranch, /drop-shadow/, 'inactive icons must not carry a neon glow');

  // Exactly the per-module active colors carry the neon glow (green/purple/orange/amber/blue = 5).
  assert.equal((source.match(/drop-shadow-\[0_0_10px/g) ?? []).length, 5, 'five active per-module neon glows');

  // Touch-first: the sidebar uses no hover/group-hover utilities anywhere.
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
});
