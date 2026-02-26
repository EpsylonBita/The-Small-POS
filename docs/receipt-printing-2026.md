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
  - `restaurant.*` (address/phone/website fallback)
  - `organization.name`, `organization.logo_url`
  - fallback terminal keys: `terminal.store_name`, `terminal.store_address`, `terminal.store_phone`
- `terminal_config_get_settings` now returns merged local settings map (`get_settings`) so renderer-related settings are available through existing IPC usage.

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

