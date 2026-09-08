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

## Shop follow-up on 1.4.104 — 2026-09-08

The user reported 1,128.2 MB for the six-process WebView2 Manager group after
starting the shop PC. This is a startup/interaction report, not evidence that
memory accumulated over a long uninterrupted session.

During read-only RustDesk inspection at approximately 10:51 shop time, Task
Manager was in the foreground and the POS dashboard was behind it. The POS
showed no active shift and zero orders in its visible tabs. Task Manager showed:

- Native The Small POS process: 67.3 MB.
- WebView2 Manager group: approximately 43.8–45.9 MB.
- Expanded group at 45.9 MB: The Small POS content 23.9 MB, browser manager
  7.0 MB, GPU 5.7 MB, network utility 1.8 MB, crash handler 1.7 MB, storage
  utility 0.8 MB. The expanded labels identify this group with the POS.

No application restart, reinstall, data deletion or order mutation was performed.
These are Task Manager memory-column observations; no private-commit or JS-heap
measurement was captured from the shop. In this release, sustained loss of focus
requests WebView2's Low memory target after 30 seconds. Therefore, the background
figures cannot establish lower active allocations or rule out a retained-memory
problem.

### Active-window reproduction

The POS window was temporarily moved to the right so Task Manager's process
memory column remained visible while the POS retained focus. Only the staff
selection modal was opened using Start Shift, then dismissed with Escape; no
staff member/PIN was selected, no shift was started and no order was entered.
Three successive open/close cycles reproduced increasing content-process memory:

| Observation | WebView2 POS content | WebView2 GPU |
| --- | ---: | ---: |
| Active dashboard before first open | about 39 MB | 23.5 MB |
| First open, settled observation | 491.6 MB | 44.4 MB |
| After first close | 455.9 MB | 77.7 MB |
| Second open, later observation | 834.2 MB | 59.1 MB |
| After second close | 833.4 MB | 92.0 MB |
| Third open | about 1,249 MB | 61.8 MB |
| After third close | about 1,248 MB | 83.4 MB |
| Later idle dashboard, still focused, approximately 10:58 | 1,225.6 MB | 55.4 MB |

The native process remained approximately 65–69 MB during these observations.
These are individual-process values, not the grouped total in the user's
screenshot. Open durations and observation intervals were not identical; this
is a qualitative reproduction, not a controlled allocation benchmark.

The reproduction confirms rising active working-set memory associated with
repeated modal use, retained after close. It does not yet identify whether the
content process retains JS objects, DOM/native resources, rendering caches or
other allocations. A heap/native-allocation profile is still needed. Do not
interpret the low background measurement as a fix or attribute the issue solely
to the separate GPU process. No installation change was made during this
measurement. The subsequent source changes are recorded below.

Both machines were subsequently verified through file metadata and SHA-256:
1.4.104, 40,182,784 bytes, SHA-256
`D6D4436A17CBB0DA7A58374B7DCB3DF583807F35D64499BCACA0FB7E3A84A40F`.
Both run WebView2 152.0.4191.66. The laptop reports Intel UHD Graphics driver
31.0.101.4502; the shop reports Intel Graphics driver 32.0.101.7076. The differing
driver is an observation, not an established cause.

Installer inspection: ordinary update preserves credentials. The uninstall hook
deletes managed credentials only when Delete App Data is selected outside update
mode; an actual uninstall also removes the installer-owned Caller ID firewall
rule. A reinstall is not an established remedy for the reported memory usage.

### Configuration payload investigation and source correction

The user also reported a visible loading step before the shop staff list, while
the laptop displays staff immediately. Read-only SQLite queries captured only
counts, lengths and cache metadata, without exporting customer or staff records:

| Local storage observation | Laptop | Shop |
| --- | ---: | ---: |
| Sum of setting-value lengths | approximately 122 KB | 16,571,840 |
| Operational `local` category | approximately 110 KB | 16,561,120 |
| Staff cache bytes / staff count | 10,289 / 16 | 7,172 / 12 |
| Local orders count at observation | 3 | 0 |

The staff cache exists in both installations. The shop's large category contains
customer, delivery-validation, address-candidate and cached API responses.
The configuration response previously included all of these records. Multiple
settings/identity/audio consumers consequently received large unrelated strings.
Saving the staff cache also emitted terminal-configuration notifications, which
triggered identity/module/audio refresh paths. Additionally, useTerminalSettings
replaced its configuration with the notification's `{updated: [...]}` metadata,
discarding branch identity and forcing later fallback lookups.

Changes in source:

- Bulk configuration reads filter `local` and `staff_auth_cache` in SQL before
  loading values. Targeted cache reads, SQLite persistence, credentials, offline
  data and orders are preserved; no migration or data deletion is involved.
- Cache-only generic setting writes do not emit global configuration events.
  Mixed writes still announce real configuration changes.
- The settings hook ignores old cache notifications, reloads authoritative
  configuration for actual changes and rejects obsolete asynchronous responses.

A real SQLite regression fixture with a 16 MiB cache failed before the change:
the configuration response was 16,777,334 bytes. Its corrected acceptance check
requires a response below 8 KiB while proving both caches remain readable.
Three initial hook regressions also failed before correction: cache notification
erased branch identity, real changes were not reloaded, and response ordering was
not handled. These demonstrate specific defects, not a measured post-fix shop
working set. The corrected executable still needs the same active-window shop
test before claiming the 1.2 GB observation is resolved.

Fresh verification for this correction: 85 native settings tests passed,
including the large-cache projection and mixed configuration/cache notification
cases; 30 renderer tests passed across settings updates, staff loading, onboarding
identity and app audio. TypeScript checking and the production frontend build
passed. The existing large-chunk build warning and three unrelated native
unused-code warnings remain. These measurements preceded release 1.4.105;
they do not represent an installed measurement of the corrected build.
