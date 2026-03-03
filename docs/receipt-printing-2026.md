# POS Tauri Receipt Printing (2026 Layout)

## Overview
- All queued print entities now render from structured documents (`order_receipt`, `kitchen_ticket`, `shift_checkout`, `z_report`) through `src-tauri/src/receipt_renderer.rs`.
- Hardware output is generated directly as ESC/POS bytes from structured data. The legacy HTML-to-text stripping path is removed from queue printing.
- HTML artifacts are still written to `receipts/` for preview/audit/debug.

## Template System
- `receipt_template` supports `classic` and `modern`.
- `modern` is default for new `receipt` and `kitchen` profiles.
- DB migration v20 rolls existing `receipt`/`kitchen` profiles from `NULL`/`classic` to `modern`.
- Renderer keeps both templates active; `modern` changes section hierarchy/styling while preserving thermal safety.
- Runtime compatibility guard: for `order_receipt`, `delivery_slip`, and `kitchen_ticket`, a legacy profile value of `classic` is auto-promoted to `modern` unless `receipt.allow_classic_template=true` exists in local settings.

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

## Header Composition (Brand + Branch)
- Receipt header now always renders a brand line plus branch block directly under the logo/header area.
- ESC/POS and HTML paths use the same logical order:
  - brand (`organization_name`)
  - branch (`store_subtitle` when present and not a duplicate of brand)
  - address
  - phone
  - VAT
  - tax office
- Delivery slip no longer prints a duplicate subtitle line after the shared header block.

## Header Data Precedence
- Brand line (`organization_name`) in layout config:
  - `organization.name`
  - fallback `restaurant.name`
  - fallback `terminal.store_name`
- Branch line (`store_subtitle`) in layout config:
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
- Modern kitchen template increases title and order identifier prominence on non-compact paper widths.
- 58mm safety is preserved via compact-width guards.
- Delivery-specific fields in kitchen delivery blocks remain bolded for quick scanning.

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
