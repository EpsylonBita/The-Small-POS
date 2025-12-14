# Implementation Plan - Inter-Terminal Sync Refinements

## 1. Security Enhancements
- [x] **HMAC Signature Verification**:
    - Implemented `generateSignature` in `InterTerminalCommunicationService`.
    - Added `x-terminal-signature` header to `forwardOrderToParent` requests.
    - Verified signature on server-side `startHttpServer`.
    - Added `getInterTerminalSecret` to `SettingsService` for secure key management.
- [x] **Branch Validation**:
    - Enforced branch ID matching for incoming forwarded orders.
    - Added logic to ignore discovered parents from different branches (optional security check).

## 2. Database Schema Updates
- [x] **Migration Logic**:
    - Updated `DatabaseService.applyMigrations()` to add:
        - `orders` table: `routing_path`, `source_terminal_id`, `forwarded_at`.
        - `sync_queue` table: `routing_attempt`, `routing_path`.
    - ensured `better-sqlite3` compatibility by integrating directly into the app's startup service instead of a standalone script (which failed due to ABI mismatch).

## 3. Configuration Refinement
- [x] **SyncService Integration**:
    - Updated `SyncService` to read `inter_terminal_port` from `SettingsService`.
    - Passed configured port to `InterTerminalCommunicationService` constructor.
- [x] **InterTerminalCommunicationService Updates**:
    - Implemented configurable timeout for `isParentReachable` using `getParentConnectionRetryIntervalMs`.
    - Implemented discovery timeout wrapper in `startParentDiscovery` using `getParentDiscoveryTimeoutMs`.

## 4. Code Refactoring & Stability
- [x] **Type Safety**:
    - Fixed `TerminalFeatures` index signature in `FeatureService.ts` to allow `boolean | undefined`.
    - Updated `feature-mapping.ts` to support relaxed type constraints.
    - Verified entire codebase with `npm run type-check`.
- [x] **Service Structure**:
    - Cleaned up `InterTerminalCommunicationService.ts`:
        - Fixed duplicate imports.
        - Restored missing helper methods (`getTerminalId`, `getBranchId`, `publishService`, `startParentDiscovery`).
        - Ensured proper cleanup and initialization.

## 5. UI Feedback
- [x] **Order Routing Badge**:
    - Verified `OrderRoutingBadge.tsx` component logic for `via_parent` and `direct_cloud` statuses.
    - Verified integration in `OrderCard.tsx`.

## 6. Verification
- [x] ran `npm run type-check` to confirm zero TypeScript errors.
- [x] Review of relevant files to ensure logic correctness.

## Next Steps
- Deploy updates to terminals.
- Monitor logs for `[InterTerminal]` messages to verify successful discovery and signature verification.
- Test "Via Parent" routing by simulating offline mode on a mobile waiter terminal.
