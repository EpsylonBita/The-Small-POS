# Windows technician evidence handoff — 12 November 2026 brief

Implemented by a bounded OpenAI Codex worker. The exact runtime model variant is not exposed in tool metadata. No Claude invocation, sub-agent, orchestrator, commit, push, stash, deployment or live till access was performed. All source changes are within `pos-tauri/`. Android's evidence handoff and implementation were read for parity; Android/shared/server changes remain with the coordinator.

Source verification is recorded below. **A visible Windows till/WebView2 capture, mixed-DPI operation and a release installer were not exercised.** Do not treat unit tests or the native API qualification as device certification.

## Tool behaviour

| Tool | Default | Extra inputs / personal mode |
| --- | --- | --- |
| `till_screenshot` | Requires a trimmed 10–200 character reason. Returns exactly one `image/jpeg` transport with measured width/height, byte size, image SHA-256 and canonical base64. Default longer edge 1280; accepted request 320–1920; JPEG at most 2 MiB. Twenty accepted attempts per session, at least five seconds apart; capture failures count. | No personal flag. The explicit screenshot reason authorizes the requested screen, with unconditional secret refusal. No fabricated `screen_name`, observation fields or app version enter image transport data. |
| `till_logs` | Existing retained projected event/code mode, filters, sorting and default 200 / maximum 500 lines. At most three 128 KiB file tails and 128 KiB returned line data. | `detail: 'text'` reads the original retained line, including its timestamp/target prefix, keeps operational prose and wraps it as `untrusted_till_data`; codes remain separate. Personal names/addresses known from admitted local identity fields, email and phone text are masked by default. Personal mode requires the reason and durable event before collection. Logger-removed content cannot be reconstructed. The optional v1 projected-only coverage object is omitted in text mode, like Android; line/file/deadline omissions still set truncation and redaction-drop counts. |
| `till_sync_queue` | Existing scoped counts, financial/diagnostics backlogs, at most 50 items; payload is literal `redacted`. Useful operational `last_error` text survives the secret scrub. | `include_payload: true` selects the owner's original `data` JSON, masks personal fields/known values unless opened, scrubs secrets and serializes into a 1024-character untrusted wrapper. Malformed or oversized source JSON is withheld and counted. Truncated payloads set a cell truncation entry. No queue replay or mutation. |
| `till_sql_query` | Queries a private read-only evidence replica. Safe/free-text columns retain scrubbed operational content; personal columns use a fixed marker before SQL, including NULL/empty values. Unknown/secret columns remain fixed markers and unknown/secret tables empty. Dynamic settings retain only the existing admitted printer-brand values. Existing row/cell/result/deadline/authorizer limits remain. | Personal mode builds its own UUID-named scratch replica and drops its owned file/sidecars on success or failure. It never replaces or reuses the default replica. Safe/free-text/PII values still undergo the unconditional secret scrub before aliases or expressions can read them. |
| `till_diagnostics_bundle` | Reads one section from its existing owner; preserves operational values/prose with personal field/value masking. It creates no ZIP and runs no repair. | Personal mode is audited before collection. About, retained system Health, terminal-context/Health-view/manifest observations and retained projected runtime logs have direct cache/log readers and do not open business SQLite. A missing observation remains unavailable. Already-redacted cached exports cannot recover removed personal values. Native section arrays are limited to 50 rows and mark truncation. |
| `till_shifts` | Existing open shifts, drawer sessions, last Z and read-only readiness projection. Staff remains literal `redacted`. | Personal mode opens available `staff_name` in an untrusted wrapper, after the audit. No shift/drawer/Z mutation. The readiness owner still returns the existing finite blockers; no new financial fields were invented outside the contract. |
| `till_health` | Reads the retained observation by database path without opening business SQLite. Missing/incomplete observations have `HEALTH_OBSERVATION_MISSING`; existing freshness/count projections remain. | No new input or fresh Health service invocation. |
| Other tier-one tools | Existing readers and execution policies remain. Root metadata now carries a closed cause when an owner reports unavailable retained evidence. | Native open/schema/SQL-full failures retain their technical cause through the common executor. No new tier-two/three execution capability or write authority. |

Personal reads require `include_personal_data: true`; a reason alone opens nothing. The five personal-tool reason refinements and screenshot inputs are checked before the accepted envelope is persisted. Detected secrets in reasons are refused. The reason and action must be rendered by the pill and acknowledged after browser animation frames before native dispatch continues. Presentation waits hold no Core, support-database or business mutex and are cancelled by the ordinary native gate.

Default prose uses an in-memory, session-owned, Unicode case-insensitive known-person index from admitted PII columns, supplemented by customer delivery notes. It refreshes from an independent read-only handle when available and is cleared at End. A consistent raw snapshot supplies the replica's own index before sanitization. Retained already-redacted/cache-only sections can use an existing index without opening business SQLite. When a free-prose read needs an index and none can be built, it fails closed with the native technical cause. This is coverage of retained/known identities, not a claim that arbitrary unlabelled historical names can be inferred from language. Secret fields, PANs, credential assignments, bearer/basic/JWT/API tokens, support codes and key blocks are scrubbed in both modes; surrounding operational prose remains readable.

## Capture implementation and limitations

The native implementation uses [WebView2 `ICoreWebView2::CapturePreview`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2), through Tauri's existing `with_webview` COM access. It captures the sole webview in the app's `main` window, including renderer portals, support pill and HTML modals. It uses no desktop DC, desktop screenshot API, other application's HWND, CDP or remote-control surface.

* Coordinator change (12/11/2026): the POS's own webview (the one that carries the window's label) is captured even when the window holds other webviews. A child webview (the efood partner page) sits parked at 2x2 logical pixels while hidden and blocks nothing; a child that is actually on screen (larger than 8 physical pixels on a side, or of unreadable size) is refused with `SCREEN_CAPTURE_UNAVAILABLE`, before and after the capture. No partial or composited child image is claimed. The worker's first version refused any window with more than one webview, which would have made the tool unusable on a till with the efood plugin.
* The main window must be visible and not minimized; it does not need the keyboard focus (coordinator change: the preview captures the webview's own content, never another application). Missing/ambiguous surfaces, embedded frames, video, canvas, objects and embeds are refused. Native OS dialogs and other windows are outside this capture surface; an unfocused main window is refused rather than omitting an active picker.
* The COM preview writes a PNG to an in-memory HGLOBAL `IStream`. Its callback sends only an agile COM reference to the blocking worker. COM stream reading, PNG decode, RGB conversion, resize and JPEG encoding run off the UI thread. Native input is bounded to 32 MiB / 16,777,216 decoded pixels. These implementation guards can refuse exceptionally large displays.
* JPEG dimensions are measured from the actual native pixel image, rather than CSS bounds or an assumed DPI factor. Encoding uses the existing `image` crate, RGB pixels, quality 85/70/50/30 and then smaller dimensions until the 2 MiB limit is met. The encoder output must pass the ported complete ingress JPEG marker walk. Only baseline/progressive JPEG structure and thumbnail-free JFIF APP0 are accepted; EXIF, comments, ICC/other APP segments, malformed entropy/post-scan segments, trailing images and thumbnails are rejected.
* The capture worker has a five-second deadline with short cancellation polling; the pill presentation has a separate three-second maximum. Pre-emption discards the result, with the gate's recorded financial cause. WebView2 exposes no cancellation handle for an already submitted preview: a late callback checks the cancellation/deadline and releases its stream without exporting it. A physical memory-erasure guarantee is not claimed.

The capability check requires Windows, the actual main-window WebView2 interface and a single webview; it never advertises a stub collector. A reasoned request still checks live visibility/privacy/API success and can fail. A real till must qualify the COM callback/marshalling and visible output before release.

## Secret surfaces

The shipped native script inspects DOM state, never screenshot pixels. It refuses visible `data-support-secret` surfaces, native password/autocomplete fields, credential/PIN/key/card-number input identities, secret-bearing visible DOM text/input values, full Luhn-valid PANs, and support/token/key patterns. It checks again after capture. Mutation records retain a sticky refusal for secret/ambiguous nodes, old secret text/attributes and transient secure surfaces, including nodes removed before the callback. Ordinary clock changes do not invalidate a capture. The guard is disconnected on completion and cancellation.

Coordinator change (12/11/2026): free text is no longer taken for a support key (the first Windows version refused any eight characters of the key alphabet, for example «TAKEAWAY»); the support code screen is refused through its explicit marker. The card-number check runs only on card-shaped digits (13 to 19 in a row, or groups of four) that are not part of an identifier joined by a hyphen or underscore, so an order number such as BOX-<13 digits>-… is not refused by chance. Same rule on both tills.

Explicit markers cover the custom Login PIN dots, `PINLoginModal`, shared `POSGlassPINInput`, revealable terminal/API-key connection fields, support code/QR, integration inputs, gift tender inputs, gift funding PIN/card inputs, and newly issued full gift-card numbers. Ordinary password-backed PIN fields are covered automatically: support actor renewal/on-site PINs, waiter sign-in, menu/paid-action authorization, shift and close-without-handover PINs, satellite release, gift close, refunds/voids and Z confirmation. Future custom PIN/key/card or canvas-based surfaces must carry the same marker on a native DOM wrapper; do not rely on custom dots being readable as a password field.

Android composes activity-owned dialogs, whereas Windows captures renderer-owned modals in one webview and refuses child webviews/ambiguous surfaces. Windows text logs include the original native logging prefix; Android returns its parsed message portion. Windows retains its optional coverage metadata for code mode, while text mode follows Android's optional shape. These are the intentional platform differences. Neither native capture path has been device-certified by this worker.

## Local audits and one-shot pixels

`support.db` v4 adds `support_evidence_events` and `support_evidence_sessions`; there is no business-database migration. Session context binds the authenticated session/actor display label and local organization/branch/terminal. If financial work prevented the initial identity observation, the next evidence audit resolves only those non-secret mirrors under a new read permit and caches them. If the local scope cannot be verified, the audit fails closed rather than inventing an identity. Each evidence event references the monotonic terminal audit sequence, command/command sequence and timestamp. Reasons and safe sizes/hashes are durable; returned personal values and pixels are absent from these event rows. The existing four wire phases remain unchanged; their digest can identify an evidence event without adding free-form wire details.

`personal_data_access` and `screenshot_requested` commit before their reads. `screenshot_captured` commits size/hash after capture. Audit failure prevents exporting the evidence. The pill acknowledgement precedes collection. The screenshot counter/cooldown uses durable accepted commands and survives restart; failed captures count and replay never executes another capture.

Neither the accepted-command replay JSON nor `support_result_outbox` ever receives base64. They retain safe image metadata, the original accepted digest and original envelope-byte accounting. Pixels are held in an in-memory one-shot map for one upload attempt, expire automatically after 30 seconds even without polling, and are removed at End. The transport takes only the three results it will attempt; later images are not accidentally consumed by batching. Restart, lost/failed delivery, expiry or replay produces a data-free `OUTCOME_UNKNOWN` / `SCREENSHOT_ALREADY_CONSUMED` response with its own digest. Acknowledging that fallback removes it from the outbox. Existing 20 MiB session accounting includes the original image envelope bytes.

## Failure mapping

| Condition | `failure_detail_code` |
| --- | --- |
| Confirmed absent business file | `BUSINESS_DATABASE_MISSING` |
| Native business open/corruption failure | `BUSINESS_DATABASE_OPEN_FAILED` |
| Missing table / column, including SQLite's input-error variant | `TABLE_MISSING` / `COLUMN_MISSING` |
| Other replica construction failure | `REPLICA_BUILD_FAILED` |
| Replica disk guard / SQLite full | `INSUFFICIENT_FREE_DISK` |
| Missing/incomplete retained observation, unavailable readiness/printer facts or retained log owner, missing local evidence binding | `HEALTH_OBSERVATION_MISSING` |
| Missing capture API/window, a child webview on screen, a hidden or minimized window, or unsupported/oversized capture surface | `SCREEN_CAPTURE_UNAVAILABLE` |
| COM preview/marshalling/read/decode/encode/JPEG validation/deadline failure | `SCREEN_CAPTURE_FAILED` |
| Secure field/marker/text/PAN, or a privacy-relevant mutation during capture | `SCREEN_CONTAINS_SECRETS` |
| Checkout / card or fiscal / shift close / Z recorded after native admission | `PREEMPTED_BY_SALE` / `PREEMPTED_BY_PAYMENT` / `PREEMPTED_BY_SHIFT_CLOSE` / `PREEMPTED_BY_Z` |
| One-shot image absent on replay/delivery retry | `SCREENSHOT_ALREADY_CONSUMED` |
| `SQLITE_PATCH_REQUIRED` | Recognized closed contract member; not a Windows runtime path because Windows ships bundled SQLite, not Android's patched SQLite bridge. |

No native exception/path enters the detail field. Outer error codes remain the existing closed codes, with internal typed causes unpacked by the executor.

**Shared-contract follow-up:** the closed detail list has no fitting member for generic input/policy/session/rate/result-budget/presentation/audit-storage refusals, or restore/migration pre-emption. Those continue using their existing outer code without a fabricated technical detail, as Android does. If “every failure” literally includes those refusals, the shared/server owner must extend the detail enum and both native mappings. No new order-command or runtime outer `Err("NEW_CODE")` was introduced, so no Rust/shared runtime-error registry addition is needed. The Windows enum/marker guard also protects protocol labels from coinciding indexed names; the Android owner should consider the same protection around its generic known-value substitution. Windows text coverage cannot use a new `retained_original_log_tail` source under the current strict shared schema; this implementation omits that optional field instead of sending an invalid value.

## File-by-file changes

Paths below are relative to `pos-tauri/`.

| File | Change |
| --- | --- |
| `src-tauri/Cargo.toml` | Enables only `Win32_System_Com_StructuredStorage` on the existing `windows` dependency for HGLOBAL streams; no new crate or lockfile change. |
| `src-tauri/src/diagnostics.rs` | Separate evidence section policy and path-based retained/cache readers; normal exports keep their existing redaction. Isolates the existing raw-log seal regression fixture through its existing injected-directory exporter. |
| `src-tauri/src/support/evidence.rs` | Input refinement, closed causes, secret/PAN/person masking, session-owned identity index, local evidence journal, unavailable metadata and presentation wait. |
| `src-tauri/src/support/screenshot.rs` | Real WebView2 capture, API qualification, deadline/cancellation, worker COM stream processing, JPEG bounds and full marker validator. |
| `src-tauri/src/support/screenshot_guard.js` | Shipped DOM privacy preflight/final check and sticky transient-secret observation. |
| `src-tauri/src/support/mod.rs` | Registers the new native modules. |
| `src-tauri/src/support/db.rs` | v4 local evidence/session tables and migration tests' correct historical notice-migration range. |
| `src-tauri/src/support/delivery.rs` | Validates new refinements before accepted-envelope persistence. |
| `src-tauri/src/support/dispatch.rs` | Native screenshot handler, capability advertisement, pill acknowledgement wait and matching pre-emption causes. |
| `src-tauri/src/support/executor.rs` | Optional typed failure transport, durable screenshot admission caps, separate screenshot result cap and non-durable one-shot pixel outbox. |
| `src-tauri/src/support/session.rs` | Persists safe session evidence binding; exposes reason/action/command presentation fields and accepts pill acknowledgements. |
| `src-tauri/src/support/transport.rs` | Takes only the three pending results it will upload, preserving one-shot images further down the queue. |
| `src-tauri/src/support/replica.rs` | Evidence values before SQL, typed file/schema/disk/build failures and isolated personal replicas with owned-sidecar disposal. |
| `src-tauri/src/support/sql_query.rs` | Typed prepare errors and evidence-aware untrusted text cells. |
| `src-tauri/src/support/redaction.rs` | Reuses native PAN scrub with tab/NBSP/zero-width separators; legacy record policy remains. |
| `src-tauri/src/support/collectors/logs.rs` | Retained text mode with actual messages, original filters/caps, unconditional scrub and reasoned observation failures. |
| `src-tauri/src/support/collectors/sync_queue.rs` | Optional bounded JSON payload selection; useful errors; malformed-payload counts and cell truncation. |
| `src-tauri/src/support/collectors/shifts.rs` | Personal staff label wrapper; default withheld staff and existing read-only readiness retained. |
| `src-tauri/src/support/collectors/diagnostics.rs` | Raw operational evidence section entry point with typed missing observations; compatibility collector retains its old masking pass. |
| `src-tauri/src/support/collectors/health.rs` | Path-based retained observation collector and explicit missing/incomplete cause. |
| `src-tauri/src/support/collectors/mod.rs` | Adds root unavailable cause metadata. |
| `src-tauri/src/support/contracts.rs` | Updates embedded artifact assertions for the 31st kind and screenshot cap section. |
| `src-tauri/src/support/catalogue/tests.rs` | Uses the support owner's schema version instead of a stale literal; no catalogue runtime change. |
| `src-tauri/src/support/tests/evidence_tests.rs` | New inputs, privacy, enum preservation, typed causes, isolated replicas, actual JPEG bytes, secure refusal, pre-emption, journal binding and realistic v3 upgrade. |
| `src-tauri/src/support/tests/executor_state_tests.rs` | Every closed detail through envelopes; screenshot byte non-persistence, original accounting, one-shot retry and durable caps. |
| `src-tauri/src/support/tests/desktop_output_contract_tests.rs` | Extends strict golden oracle for optional causes, payload/staff wrapper unions, text coverage and screenshot metadata; exercises real collectors/encoder. |
| `src-tauri/src/support/tests/mod.rs` | Registers evidence regressions. |
| `src/renderer/hooks/useSupportSession.ts` | Optional native evidence reason/personal/command fields in snapshot schema. |
| `src/renderer/components/support/SupportBanner.tsx` | Always-visible translated evidence reason/action and native post-render acknowledgement. |
| `src/renderer/components/support/SupportCodeScreen.tsx` | Secret marker around support code/QR. |
| `src/renderer/components/support/__tests__/SupportEvidence.test.tsx` | Pill action/reason, all six translated reason placeholders and execution of the actual native privacy script, including transient secrets and ordinary clock updates. |
| `src/renderer/components/auth/PINLoginModal.tsx` | Marks the custom PIN entry surface. |
| `src/renderer/components/ui/pos-glass-components.tsx` | Marks the shared custom PIN input. |
| `src/renderer/components/modals/ConnectionSettingsModal.tsx` | Marks revealable API key and PIN inputs; operational peripheral/IP fields remain capturable. |
| `src/renderer/components/payment/GiftCardTender.tsx` | Marks full gift-card entry. |
| `src/renderer/pages/LoginPage.tsx` | Marks custom PIN dots and setup PIN inputs. |
| `src/renderer/pages/IntegrationsPage.tsx` | Marks API key/secret/webhook inputs; operational integration checkboxes remain capturable. |
| `src/renderer/pages/GiftCardFundingPanel.tsx` | Marks funding/card/PIN inputs. |
| `src/renderer/pages/GiftCardsPage.tsx` | Marks gift-card lookup entry and newly issued full gift-card number. |
| `src/locales/support/el.json` | Greek screenshot/personal-data action with reason; matches Android. |
| `src/locales/support/en.json` | English screenshot/personal-data action with reason; matches Android. |
| `src/locales/support/de.json` | German screenshot/personal-data action with reason; matches Android. |
| `src/locales/support/fr.json` | French screenshot/personal-data action with reason; matches Android. |
| `src/locales/support/it.json` | Italian screenshot/personal-data action with reason; matches Android. |
| `src/locales/support/sq.json` | Albanian screenshot/personal-data action with reason; matches Android. |
| `docs/support-technician-evidence-20261112.md` | This review/verification/device handoff. |

No changes to `shared/`, `admin-dashboard/`, `POSSystemMobile/`, critical-operation admission/interruption logic, write policy, business schema or later-tier runtime execution. No dependency installation or permission bypass was attempted. The added COM feature names an existing SDK interface and adds no licensing/dependency family. `cargo-deny` is not installed; no repository `deny.toml` was found, so that separate checker could not run.

## Verification

Heavy commands ran sequentially, with `CARGO_BUILD_JOBS=5`, `LOCALAPPDATA=C:\Temp\zt-rust-localappdata` for Rust, and without setting `FORCE_COLOR`. No full `cargo test --lib` was run. Verification logs are local ignored `pos-tauri/support-*-verification.log` files.

| Command | Final outcome |
| --- | --- |
| `cargo fmt --check` (`src-tauri/`; also run with explicit app manifest) | PASS. |
| `cargo test --lib support` (final run uses `--manifest-path pos-tauri/src-tauri/Cargo.toml`) | PASS: 447 passed, 0 failed, 3 ignored; 4383 filtered out. `RUST_TEST_THREADS=1`; 97.61 seconds for the final native test process. |
| `cargo test --lib diagnostics` (explicit app manifest) | PASS: 75 passed, 0 failed, 0 ignored; 4756 filtered out. `RUST_TEST_THREADS=1`; 38.42 seconds. |
| `npm.cmd run type-check` | PASS, TypeScript `tsc --noEmit`. |
| `npx.cmd --no-install vitest run src/renderer/components/support` | Prescribed runner attempted but EPERM at the dependency junction. Equivalent command below PASS: 15 files, 237 tests. |
| `npx.cmd --no-install vitest run --config .support-vitest.config.mjs --configLoader runner --cache=false src/renderer/components/support` | PASS: 15 files, 237 tests; 16.05 seconds on the final run. Temporary config mirrors app aliases/setup, limits workers to three and uses a local cache. |
| `npm.cmd test` | PASS: 1527 tests, 4 suites, 0 failed/skipped. |
| `npm.cmd run locale:parity` | PASS: all six app languages, 9150 keys each, no missing/extra keys or support errors; support bundles also match Android in renderer tests. |
| `npm.cmd run test:support-layer` | Prescribed runner attempted but EPERM at dependency `.cache`. Equivalent local-output runner PASS: 78 tests, 0 failed/skipped. |
| `node .support-layer-run.mjs` | PASS: 78 tests; identical support-layer entry point/esbuild options, only generated output moved inside `pos-tauri/`. |
| `git diff --check -- pos-tauri` | PASS. |
| `cargo deny --version` | Not available: `cargo-deny` is not installed. No dependency/lockfile family was added. |

The final support run includes the unchanged native checkout/pre-emption/availability/write-guard tests as well as the new evidence cases. Parallel native runs intermittently failed existing nonblocking Health-cache assertions (`health_uses_real_builder...` or `stale_and_failed...`) because a cache observation was unavailable under concurrent test access; the production try-lock policy was left unchanged. All support tests pass with one test thread, and the concurrency-specific gate tests still launch and exercise their own threads. The ignored 500 MiB/reference-hardware and other explicitly opt-in gates were not run.

The first full diagnostics run passed 74 tests and hit one sandbox write denial in the existing raw-log seal fixture under `C:\Temp`. That fixture now uses the exporter's already-existing injected log-directory entry point with the same default options, in its owned temporary test directory. The final diagnostics run passes all 75. It still proves that normal export includes no raw repair log/sentinel; no test was skipped or weakened.

Temporary verification configs and generated bundles are removed after verification; an empty untracked cache directory may remain. Their equivalent commands are recorded here; they are not product changes. No release build/installer, visible device capture, cargo-deny run or ignored hardware benchmark is claimed.

Environment workarounds: the prescribed plain Vitest startup tries writing through the read-only dependency junction's `.vite-temp`, and the support-layer script writes through its `.cache`. Both were attempted and failed with EPERM. Equivalent temporary runners kept the same app aliases/setup/entry point and moved only generated/cache output under this worktree's `pos-tauri/`. No write to another worktree or dependency installation occurred. Early static regex failures were caused by Windows CRLF conversion of edited files; normalized LF restored the original static assumptions. Those failures were corrected, not skipped.

## Real-till checklist for the coordinator

1. Apply/verify the server evidence migration and result-ingress optional failure field from the server handoff. Connect with a support key, confirm the till's active pill and reason before requesting evidence. Confirm supported capability advertisement on a single-webview build and refusal with the efood child present.
2. Capture the main orders screen and a renderer modal at 100%, 125%, 150%, 200% and mixed-monitor DPI. Check that the image depicts the current app viewport/modals, has the requested longest edge and measured JPEG dimensions, and contains no other application/desktop pixels. Exercise the real COM agile-stream callback on the supported WebView2 runtime.
3. Request capture on PIN dots, shared PIN inputs, password/credential settings including revealed API key, support key/QR, gift-card entry and issued full number. Require `SCREEN_CONTAINS_SECRETS` and no image. Open/close a secure modal during capture; also test transient secret toasts, native pickers, minimized/unfocused main window and embedded/child surfaces.
4. Start sale, card/fiscal payment, shift close and Z while capture, text evidence and a long replica read run. Selling must continue promptly and cancelled results must have the matching `PREEMPTED_BY_*`. Run the ignored 500 MB/reference-hardware latency release gate separately on the reference till.
5. Compare code/text logs, default/requested queue payload, SQL aliases, diagnostics and staff labels with/without personal access. Personal access needs a reason; audit it before collection. Credentials, PANs, PINs and support keys must remain absent in both modes. Confirm personal scratch replicas/sidecars disappear and default SQL remains masked afterwards.
6. Try requests less than five seconds apart and a 21st request in one session, including failed captures. Test End/restart/offline/lost upload while capturing and uploading. Confirm no local replay pixels, data-free consumed fallback, original session-byte accounting, automatic expiry, and exactly one server image consumption. Verify local audit contains scope/actor/reason/hash/size and no pixels or returned private values.

Native Windows visible capture, the reference-hardware latency benchmark, a release build/installer and Android qualification remain unverified by this bounded worker.
