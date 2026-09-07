# POS memory review — 2026-09-07

## Observed on the installed shop POS

Task Manager readings for the WebView2 process group during the final reproduction:

| Stage | Memory |
| --- | ---: |
| Dashboard before check-in | 293 MB |
| Staff selection / PIN / role | up to 1,552 MB |
| After closing check-in | 569 MB |
| Small pickup order | 641–953 MB |
| After order creation | 855 MB |

The native POS was approximately 63–78 MB in the earlier observation. These are
process working-set readings, not heap snapshots. The renderer accounted for most
of the check-in growth. They do not prove an unreclaimable leak, identify the exact
allocation source, or establish that a particular pause was caused by collection.

## Changes

- Staff check-in uses an opaque modal shell without backdrop filters and avoids
  layout animation on its staff/role cards and selected-staff summary.
- Floating action buttons default to static rendering without animated gradient
  layers. Static mode disables descendant and pseudo-element animations as well.
  Explicitly animated buttons pause while modal background isolation is active;
  nested modals release the pause only after the last modal unmounts.
- The staff picker reads active shifts through one branch-scoped local snapshot
  (`shift:get-active-for-branch`). Cached and refreshed staff share this snapshot.
  Obsolete modal loads cannot overwrite a later open session.
- Native memory policy keeps the active POS at `Normal` and uses `Low` only while
  inactive: immediately when hidden/minimized, or after 30 seconds continuously
  unfocused. Focus restoration cancels that grace period. Closing check-in no
  longer starts a delayed 20-second Low period.
  The legacy `memory:trim-webview` channel reconciles activity rather than forcing
  a collection. Scripts and synchronization remain running.
- PDF rasterization, page-count probing, and supplier text extraction destroy
  their PDF.js loading tasks in `finally`. Rasterization also releases page canvas
  buffers between pages, including on failure.

WebView2's memory target is a best-effort hint, not a hard memory limit or guaranteed
GC. Low can page memory to disk and affect later responsiveness; see the
[Microsoft API reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_19).

## Release comparison

Validate with the same installed WebView2 runtime and representative local data:

1. Record native, renderer, GPU and group memory separately after startup settles.
   Keep POS focused during active-use measurements (Task Manager can remain always
   on top without focus). Otherwise the inactivity policy itself can lower the
   working set and confound the comparison; record focus and memory target too.
2. Repeat staff selection, PIN, role and return to dashboard ten times. Use test
   data for actual check-in writes; opening/closing alone can be repeated safely.
3. Repeat menu and cart interactions and one authorized test order. Record input
   latency and long tasks along with memory, not only Task Manager's total.
4. Check that returning from another app restores Normal; transient native menus
   must not unnecessarily lower the target. Keep a separate run with trim disabled
   to distinguish reclaimed working sets from lower allocation rates.
5. Compare static/opaque rendering with an otherwise identical diagnostic build
   retaining the prior effects. Do not attribute combined-build changes to a
   single cause without that comparison.

Local regression tests and rendering checks validate the changed behavior.
Post-change RAM and latency on the shop installation remain unverified until the
new build is run there. Do not treat the figures above as post-fix measurements.

## Verification evidence

- 30 focused Vitest tests passed, covering staff-loading races/offline fallback,
  modal focus/closing, primary order actions, and PDF resource lifetime.
- 78 support-layer checks passed; the renderer/native parity contract passed.
- All 6 targeted native tests passed: five activity-policy cases and the real
  SQLite branch snapshot case (active rows, branch isolation, satellite rows and
  newest-first ordering). `cargo fmt --check` passed. The test compiler reported
  three existing unused-code warnings in unrelated code.
- Production frontend build and TypeScript checking passed. See the follow-up
  below for the subsequent reduction of the approximately 6 MB App chunk.
- Optimized Windows release build passed. Local artifact and SHA-256 are in
  `output/pos-memory-release-2026-09-07/`. Caller ID uses the production release
  workflow public pins, with the tracked updater public key injected through a
  local config override. No private signing key was needed for the executable.
- Chromium rendering checks passed: default/static FABs have zero animations;
  explicit animated mode has 13, all paused under nested dialogs and resumed
  after the final close. Opaque modal shell and backdrop have no filters in
  either theme. Fixture evidence is in `output/playwright/pos-memory/` at the
  repository root; it uses real components/CSS with provider stubs.

## Loading, responsiveness and accessibility follow-up

- Optional pages, non-food dashboards, external displays and the embedded
  rooms/appointments tabs load on use. Vertical imports target individual files
  so selecting one vertical does not load all others. The food ordering path stays
  ready once its dashboard loads. Background sync, capture and production Caller
  ID listeners remain in the app shell outside route Suspense boundaries.
- Connection settings, expenses and Z reports defer their first mount. After
  opening once, their children remain mounted when closed, preserving existing
  state and exit animations. Loading uses a cancellable, opaque dialog.
- Both shared modal variants now use per-instance title IDs. Nested accessible
  names, stable IDs across rerenders and custom-header labels are covered by tests.
- Product insertion calculates price and updates the cart synchronously. A slow
  category-name lookup no longer delays the tap. The existing category loader
  fills missing labels without per-tap requests, touching only current cart rows;
  closed sessions cannot overwrite a later session's categories.
- Obsolete background offer validations stop after their IPC response, before
  calculating rules. Current-cart rules and final checkout validation stay fresh;
  no new pricing cache was introduced.
- Split chunks are packaged local assets; opening an optional page does not
  require an Internet connection. Locale loading semantics are unchanged.

Approximate minified JavaScript, including each phase's static dependency graph
(uncompressed decimal MB; all dictionaries still load initially):

| Phase | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| App chunk alone | 5.98 MB | 2.77 MB | 54% |
| Startup through login | 6.47 MB | 3.26 MB | 50% |
| Startup through food dashboard | 6.47 MB | 4.38 MB | 32% |

The production build still reports chunks over 500 kB. This comparison counts
shared dependencies, so it does not mistake the deferred dashboard file for code
eliminated from a logged-in session. Audit scripts, build graph, comparison and
test logs are in `output/pos-bundle/` at the repository root.

All 47 focused tests across 13 files passed after integration, covering optional
imports, dialog naming/loading/closing, immediate cart insertion and edit races,
offer cancellation, check-in, order triggers, Caller ID and payment close flows.

Chromium loaded the production login with no uncaught JavaScript errors and no
requests for the 12 checked optional modules. All 12 could then be imported from
the local production assets with external requests blocked. Browser-only IPC
unavailability messages are expected; this check does not simulate the shop's
native bridge or validate a real payment.

Bundle reduction targets startup parsing/evaluation; it is not evidence of a
particular RAM reduction. The earlier Windows executable/ZIP predates this
follow-up and does not contain these frontend changes.
