# Changelog

## [1.1.0] - 2025-12-14

### Changed
- Moved to dedicated public repository (The-Small-POS) for seamless auto-updates
- Auto-updates now work without authentication tokens

## [1.0.2] - 2025-12-14

### Fixed
- Fixed auto-updater for private GitHub repository access
- Added GitHub token authentication support for update checks

### Changed
- Updated publish configuration with private repo flag

## [1.0.1] - 2025-12-14

### Changed
- Improved build configuration for native dependencies
- Updated electron-builder settings for better compatibility

## [1.0.0] - 2025-12-09

### Added
- Staff Payment History: View individual staff payment history and daily totals directly in the Staff Shift Modal.
- Expected Payment Calculation: Automatically calculates expected payment based on hourly rate and active shift duration.
- Enhanced Payment Form: Added payment type selection (Wage, Tip, Bonus, etc.) and optional notes field.
- Large Payment Confirmation: Added a confirmation dialog for payments exceeding 200€.
- IPC Handlers: Added `shift:get-staff-payments-by-staff` and `shift:get-staff-payment-total-for-date`.

### Changed
- Updated `StaffShiftModal.tsx` to include the new payment UI and logic.
- Extended `StaffService.ts` to support fetching payments by staff and date.
- Updated `en.json` with new translation keys for staff payments.

## [Unreleased] - 2025-02-09

### Added
- Added `order_details` column to `driver_earnings` table (migration `20250209000000_add_order_details_to_driver_earnings.sql`).
- Added validation logic in `OrderService.ts` via `validateOrderForFinalization`.
- Added support for syncing `driver_earnings` in `SyncService.ts`.

### Changed
- Updated `StaffService.ts` to populate `order_details` when recording driver earnings.
- Updated `OrderService.ts` `updateOrderStatus` to log warnings if validation fails.
- Updated `order-handlers.ts` to log warnings for missing critical fields in `order:create`.
- Updated `SyncService.ts` to handle `driver_earnings` sync queue items.

## [Unreleased] - 2024-05-21

### Added
- Automated waiter checkout reconciliation logic in `handleCheckOut` and `StaffShiftModal.tsx`.
- Explicit null-safety guards for `table.orders` iterations in `StaffShiftModal.tsx` (Verification Comment 1).
- Accurate payment type counting (Cash vs Card) in waiter summary (Verification Comment 2).
- New `generateWaiterCheckoutReceipt` static import in `PrintService.ts`.

### Changed
- Replaced dynamic `require` with static import for waiter checkout template in `PrintService.ts`.
- Refactored Waiter Checkout UI in `StaffShiftModal.tsx` to display automated cash reconciliation.
- Improved UI resilience against missing or malformed order data.

### Fixed
- Fixed typescript errors related to missing types in `StaffShiftModal.tsx`.
