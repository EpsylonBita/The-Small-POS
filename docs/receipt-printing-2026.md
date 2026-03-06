# POS Tauri Receipt Printing (2026 Layout)

## Overview
- All queued print entities now render from structured documents (`order_receipt`, `kitchen_ticket`, `shift_checkout`, `z_report`) through `src-tauri/src/receipt_renderer.rs`.
- Hardware output is generated directly as ESC/POS bytes from structured data. The legacy HTML-to-text stripping path is removed from queue printing.
- HTML artifacts are still written to `receipts/` for preview/audit/debug.

## Template System
- `receipt_template` supports `classic` and `modern`.
- `modern` is default for new `receipt` and `kitchen` profiles.
- DB migration v20 rolls existing `receipt`/`kitchen` profiles from `NULL`/`classic` to `modern`.
- Renderer keeps both templates active; profile template is respected exactly at runtime.
- Optional local override is available via `receipt.template_override` (`classic` or `modern`) for controlled diagnostics.
- Both templates use the same content skeleton (header -> order meta -> delivery -> items -> totals -> payment -> footer) with different visual styling.
- Visual profile grammar (ESC/POS):
  - `classic`: compact metadata pairs, plain section headers, light dashed rules.
  - `modern`: framed focus blocks, `[ SECTION ]` centered headers, stronger spacing rhythm and totals/payment framing.

## Command Profile Safety
- Renderer command profile:
  - `safe_text`: no `GS !` text-size commands (Star-safe path).
  - `full_style`: full text-size styling enabled.
- Default behavior:
  - All printers -> `full_style`
  - `safe_text` is opt-in via profile/settings override.
- Optional override:
  - `receipt.command_profile = safe_text|full_style`
- If `full_style` is forced on Star, dispatch logs emit a warning because unsupported size commands may render as printable artifacts.
- In `safe_text`, readability hierarchy is created with `ESC E` bold, section framing, spacing, and alignment only.

## Classic Customer Receipt v2 (2026-03-04)
- Scope is limited to classic customer receipts only:
  - `order_receipt`
  - `delivery_slip`
- Classic kitchen/shift/z-report layouts remain on the legacy classic path.
- Logo flow is unchanged:
  - logo bytes are still prepended by the print pipeline before body rendering.
- Classic receipt visual target now matches the screenshot-2 structure:
  - top rule
  - centered bold address block
  - rule
  - left-aligned phone + VAT/DOY lines
  - rule
  - compact meta/items spacing
  - stable ASCII-style dashed separators for broader thermal compatibility
  - single separator behavior between `Subtotal` and emphasized `TOTAL`
  - footer as `**************` + localized thank-you + `**************`
- Payment-line normalization for receipt docs:
  - cash rows print as `Cash` using `cash_received` when present and `> 0`
  - fallback to payment `amount` when `cash_received` is missing
  - `Change` remains as a normal payment line when present
  - no separate `Received` payment row is emitted
- Connection/model behavior stays transport-agnostic:
  - desktop dispatch remains Windows spooler-based
  - profile fields (`type`, `connectionDetails`, `printerName`) remain unchanged
  - same layout logic is used for installed USB/Bluetooth/LAN printer queues
- Star quality tuning note:
  - print density/darkness is controlled at printer utility or memory-switch level
  - keep renderer layout generic; tune density per-device outside receipt template logic

## Classic Customer Receipt v2.1 Lock (2026-03-04)
- Correction pass for screenshot-2 parity on classic customer receipts only.
- Strict visual lock for `order_receipt` and `delivery_slip`:
  - force Font A at render time
  - force compact spacing rhythm (independent of profile density/emphasis)
- Header/body spacing corrections:
  - remove extra post-header gap before the order banner
  - avoid duplicate pre-banner separator line
  - explicit separator after order meta line for stable screenshot-2 structure
- Address normalization:
  - classic customer header splits address by comma/newline/pipe
  - each segment is centered to avoid embedded newline artifacts from raw settings values
- Footer geometry lock:
  - short centered stars above footer text
  - full-width star line below footer text
- Currency safety for classic customer receipts:
  - use `€` when brand/charset/code-page combo is known-safe
  - fallback to ASCII `EUR` for unsupported/unknown combinations
  - Star inline euro rendering uses CP858 switch with Star page index `4` (Line Mode)
- Transport unchanged:
  - logo prepend flow unchanged
  - spooler-based dispatch remains connection-agnostic for installed USB/Bluetooth/LAN queues

## Classic Customer Receipt v3 Exact Mode (2026-03-05)
- Added `raster_exact` for classic customer docs (`order_receipt`, `delivery_slip`) to target screenshot-like deterministic output.
- Existing default remains `text`; kitchen/shift/z-report paths are unchanged.
- `raster_exact` composes the full classic customer body as a monochrome bitmap and dispatches via spooler RAW (no transport-path changes).
- Logo flow is still prepend-based; extra logo/body LF is skipped only when body mode is `raster_exact` to avoid variable top gap.
- New optional `connection_json` keys (no DB schema changes):
  - `render_mode`: `text` | `raster_exact`
  - `emulation`: `auto` | `escpos` | `star_line`
  - `printable_width_dots`
  - `left_margin_dots`
  - `threshold`
- Defaults:
  - printable widths: 58mm `384`, 80mm `576`, 112mm `832`
  - threshold default: `160`
- Text fallback adjustments for classic customer docs:
  - removed hardcoded double-rule behavior around `TOTAL`
  - keeps deterministic single-rule flow
  - retains short-top/long-bottom star footer geometry

## Classic Customer Receipt v3.2 TrueType Pass (2026-03-05)
- `raster_exact` now renders classic customer body text with embedded TrueType faces:
  - `NotoSerif-Regular.ttf`
  - `NotoSerif-Bold.ttf`
- Greek accent coverage is fixed for raster mode (`Τύπος`, `Ευχαριστούμε`, `προτίμηση` etc.) and avoids bitmap `?` substitutions from 8x8 glyph limits.
- Screenshot-2 spacing lock is tightened with a deterministic preset:
  - larger address/body typography than previous bitmap raster pass
  - fixed top inset after logo handoff
  - ordered section rhythm: header rules -> reverse banner -> meta -> items -> subtotal -> TOTAL (single separators) -> payments -> dashed rule -> short-top stars -> footer -> long-bottom stars
- Logo behavior remains unchanged:
  - existing prepend pipeline still applies
  - logo size policy is unchanged in this pass
- Connection and transport remain unchanged/agnostic:
  - same RAW spooler dispatch for installed USB/Bluetooth/LAN Windows queues
  - same optional profile calibration keys (`render_mode`, `emulation`, `printable_width_dots`, `left_margin_dots`, `threshold`)
- Calibration guidance:
  - MCP31 first pass: `emulation=star_line`, keep width empty for full 80mm default (`576`), optional `left_margin_dots=0..8`, `threshold=145..165`
  - non-Star queue: keep `auto` or force `escpos`, then tune width/margin/threshold only

## Classic Raster Exact Extended Scope (2026-03-05)
- `render_mode=raster_exact` now applies to all classic receipt documents, not only customer slips:
  - `order_receipt`
  - `delivery_slip`
  - `kitchen_ticket`
  - `shift_checkout`
  - `z_report`
- Same TTF typography and spacing system is used for these classic documents so visual weight/readability stays consistent across checkout, Z report, and driver-related print flows.

## Receipt v3.3 Readability + Category Context (2026-03-05)
- Full-width default on 80mm:
  - default printable width now stays `576` dots (no MCP31 forced narrowing).
  - manual `printable_width_dots` override still applies when set.
  - `left_margin_dots` is now clamped so `left_margin_dots + printable_width_dots` never exceeds physical width (prevents right-edge clipping on full-width 80mm).
- Readability scale lock for raster exact across all classic docs:
  - `Small` (`fontType=b`, `layoutDensity=compact`, `headerEmphasis=normal`) => scale `0.92`
  - `Normal` => scale `1.00`
  - `Large` (`fontType=a`, `layoutDensity=balanced|spacious`, `headerEmphasis=strong`) => scale `1.28`
- Localization coverage update:
  - `Without` and `Little` now localize by app language in text/raster receipt output.
- Category context:
  - category line now prints category name only (for example `Waffles`) with no `Category:` prefix and no `Main > Sub` path on receipt items.
  - best-effort backfill from cached menu data (`menu_item_id`) is used for older orders missing category fields.
- Notes:
  - item notes merge all available note fields (`notes`, `special_instructions`, `instructions`) and print as `Note: ...` under each item.
  - order-level notes (`delivery_notes` + `special_instructions`) are emitted above items for customer receipts and kitchen slips when present.
- Discount display:
  - when `discount_percentage > 0`, totals line prints `Discount (X%)` with the discount amount and subtotal is displayed pre-discount.
- Card masking line:
  - receipt card mask line is shown only when transaction reference includes explicit card-mask markers (`****`, `xxxx`, or `last4`), not from generic/mock refs.
- Transport unchanged:
  - all USB/Bluetooth/LAN profiles still dispatch through Windows spooler RAW.

## Queue Payload Snapshots
- `print_jobs` includes `entity_payload_json` (migration v20).
- `enqueue_print_job_with_payload(...)` stores snapshot JSON for queued renders.
- `report:print-z-report` now enqueues snapshot-backed `z_report` jobs instead of immediate raw print.
- Queue worker logic:
  - `z_report` + payload: render from payload snapshot.
  - `z_report` without payload: render from persisted `z_reports` row.

## Settings Dependencies (Offline Cache)
- Admin terminal settings response is cached into local settings via `cache_terminal_settings_snapshot(...)`.
- Cached categories consumed by renderer:
  - `receipt.*` (template behavior, QR toggles, footer text, copy label)
  - `restaurant.*` (branch name/subtitle/address/phone/website fallback)
  - `organization.name`, `organization.logo_url`
  - fallback terminal keys: `terminal.store_name`, `terminal.store_address`, `terminal.store_phone`
- `terminal_config_get_settings` now returns merged local settings map (`get_settings`) so renderer-related settings are available through existing IPC usage.

## Header Composition (Branch-Only Primary)
- Receipt header now renders a branch-centric primary line directly under the logo/header area.
- Primary line rule:
  - use `store_subtitle` when present and distinct from organization name,
  - otherwise fallback to `organization_name`.
- Organization name is not printed as a separate extra line when branch subtitle exists.
- ESC/POS and HTML paths use the same logical order:
  - primary branch line
  - address
  - phone
  - VAT
  - tax office
- Delivery slip no longer prints duplicate branch/title lines after the shared header block.

## Header Data Precedence
- Brand fallback (`organization_name`) in layout config:
  - `organization.name`
  - fallback `restaurant.name`
  - fallback `terminal.store_name`
- Branch primary candidate (`store_subtitle`) in layout config:
  - `restaurant.subtitle`
  - fallback `restaurant.name` when different from brand
  - fallback `organization.subtitle`
- Snapshot caching now persists branch identity for this flow:
  - `restaurant.name` from `branch_info.name`
  - `restaurant.subtitle` from `branch_info.subtitle`/`display_name` (or branch name fallback)
  - `terminal.store_name` also accepts `branch_info.name` fallback

## POS Settings API Compatibility Notes
- Source of truth for receipt header branch details is `GET /api/pos/settings/[terminal_id]` (`branch_info` + `organization_branding`).
- Production route now retries branch queries with schema-compatible select sets when columns drift (`tax_id`/`tax_office`, `address`, `display_name`, `postal_code`).
- `branch_info` keeps backward compatibility and may include:
  - `name`
  - `display_name` (optional)
  - `address`
  - `city`
  - `postal_code` (optional)
  - `phone`
  - `tax_id` (optional)
  - `tax_office` (optional)
- If receipts still render without branch block, inspect print logs for:
  - `store_subtitle`
  - `store_address`
  - `store_phone`
  - `vat_number`
  - `tax_office`
  These must be non-null after a successful terminal settings sync.

## Readability Notes (Driver + Kitchen)
- Modern and classic both keep driver/kitchen-critical data in the same order, with modern using stronger section framing.
- 58mm safety is preserved via compact-width guards and command-profile gating.
- Delivery-specific fields in kitchen delivery blocks remain bolded for quick scanning.

## Runtime Verification
- Current renderer revision marker: `2026-03-05-r16`.
- Queue dispatch logs include:
  - `layout_revision`
  - `template`
  - `command_profile`
  - `font_type`
  - `layout_density`
  - `header_emphasis`
  - header-source traces (`brand_source`, `branch_source`, `address_source`, `phone_source`)
- Use these log fields to confirm that a running binary is using the expected renderer/layout path.

## 80mm Layout Notes
- Header block under logo is always:
  - branch primary line (`store_subtitle` or organization fallback)
  - address
  - phone
  - VAT
  - tax office
- Logo rasterization now uses compact height caps per paper width to keep order metadata above the fold on thermal rolls.

## Per-Printer Typography Controls (v25)
- `printer_profiles` now supports:
  - `font_type`: `a` | `b`
  - `layout_density`: `compact` | `balanced` | `spacious`
  - `header_emphasis`: `normal` | `strong`
- Defaults:
  - `font_type = a`
  - `layout_density = compact`
  - `header_emphasis = strong`
- Runtime behavior:
  - Font type uses ESC/POS `ESC M` (`A` larger, `B` compact).
  - Density controls blank-line rhythm and section spacing.
  - Header emphasis controls bold/rule strength for top focus and section headers.
- Star-safe limitation:
  - `safe_text` avoids risky `GS !` scaling commands.
  - Size tuning is done via `font_type` + density/emphasis presets for reliability.

## Width + Charset Behavior
- Paper widths: `58mm`, `80mm`, `112mm`.
- `PaperWidth` supports `Mm58`, `Mm80`, `Mm112` with width-aware wrapping/alignment in renderer output.
- Printer profile validation accepts `paper_width_mm` in `{58, 80, 112}`.
- Character set handling:
  - Applies known code page mappings.
  - Unknown/unsupported mappings fall back with render warnings.
  - `greekRenderMode=bitmap` intentionally falls back to text mode with warning.

## QR + Logo Policy
- QR prints only when:
  - `receipt.show_qr_code` is truthy, and
  - QR source exists (`receipt.qr_url` first, then `restaurant.website`).
- No placeholder is printed if QR source is absent.
- Logo handling:
  - Text header fallback is always available.
  - If logo is enabled but unavailable/unsupported, a render warning is recorded on the print job.

## Compliance Masking
- Card output in receipts uses masked/truncated representation (`****1234` when available).
- Full PAN is never rendered by receipt output paths.

## Sync Queue Diagnostics Hotfix v1 (2026-03-05)
- Scope:
  - POS-side sync diagnostics only (`pos-tauri`), no admin API changes.
  - Retry/backoff algorithm is unchanged.
- Added sync blocker snapshot payload in `sync:get-status` and emitted `sync_status` events:
  - `lastQueueFailure` includes queue id, entity type/id, operation, status, retry counters, next retry time, last error, and failure classification.
- Failure classification values:
  - `backpressure` for HTTP 429 / queue-backed-up style errors
  - `permanent` for known order validation errors
  - `transient` for known retryable order failures
  - `unknown` fallback for non-order/uncategorized cases
- Log noise reduction:
  - sync cycle warnings are deduplicated by failure fingerprint (`entity_type|entity_id|last_error|retry_count|max_retries|status`) with a `120s` cooldown.
  - repeated reconcile skip logs for the same order are throttled with repeat counters.
- Sync modal now shows a “Current blocker” card:
  - failing entity + error text
  - retry progress + next retry timestamp
  - classification badge
  - quick action for order blockers: `Retry Order Now`.
- Transport/printing behavior remains unchanged:
  - Windows spooler RAW dispatch for installed USB/Bluetooth/LAN queues.
