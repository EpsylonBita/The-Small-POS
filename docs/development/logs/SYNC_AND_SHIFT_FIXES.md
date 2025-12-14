# Sync and Shift Context Fixes

## Issues Fixed

### 1. Check-In Button Behavior ✅
**Problem:** The Check-in button was behaving like an "End Shift" button when a shift was active, and was auto-redirecting to checkout when one staff was checked in.

**Solution:**
- **NavigationSidebar.tsx**: Removed conditional rendering - button now always shows as "Check In" and always opens the staff list
- **StaffShiftModal.tsx**: Removed auto-redirect logic that was switching to checkout mode when the modal opened

**Result:** Check-in button now always shows the staff list first, regardless of active shifts.

---

### 2. ShiftContext Warning for Simple PIN Login ✅
**Problem:** Console warning: `[ShiftContext] Staff appears logged in but no active shift found for staffId: local-simple-pin`

**Solution:**
- **shift-context.tsx**: Added check to skip shift queries when `staffId === 'local-simple-pin'`
- Simple PIN login is a pseudo-session and doesn't have real shifts in the database
- Falls back to terminal-based shift restore instead

**Result:** No more warnings for simple PIN login; terminal-based restore still works.

---

### 3. Supabase Sync Errors ✅
**Problem:** Two types of sync errors:
1. `invalid input syntax for type uuid: "1761676444003-pa7ivs0fp"` - Local shift IDs are timestamp-based, not UUIDs
2. `Could not find the 'updated_at' column of 'staff_shifts'` - Missing column in Supabase

**Solution:**

#### A. Fixed Missing Columns in Supabase
Added missing columns to `staff_shifts` table via Supabase MCP:
- `updated_at` (TIMESTAMP WITH TIME ZONE)
- `status` (VARCHAR(20) with CHECK constraint)
- `total_orders_count` (INTEGER)
- `scheduled_start` (TIME)
- `scheduled_end` (TIME)
- `notes` (TEXT)
- `closed_by` (UUID)

Created trigger to auto-update `updated_at`:
```sql
CREATE OR REPLACE FUNCTION update_staff_shifts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_staff_shifts_updated_at
  BEFORE UPDATE ON staff_shifts
  FOR EACH ROW
  EXECUTE FUNCTION update_staff_shifts_updated_at();
```

Reloaded PostgREST schema cache:
```sql
NOTIFY pgrst, 'reload schema';
```

#### B. Skip Syncing Local-Only Records
Modified `sync-service.ts` to skip syncing all local-only records (not just shifts):

**1. Staff Shifts (`syncStaffShift`)**
- Skip if shift ID is not a valid UUID (e.g., `"1761676444003-pa7ivs0fp"`)
- Skip if staff_id is not a valid UUID (e.g., `"local-simple-pin"`)

**2. Cash Drawer Sessions (`syncCashDrawerSession`)**
- Skip if session ID is not a valid UUID
- Skip if staff_shift_id or cashier_id is not a valid UUID

**3. Shift Expenses (`syncShiftExpense`)**
- Skip if expense ID is not a valid UUID
- Skip if staff_shift_id or staff_id is not a valid UUID

**4. Driver Earnings (`syncDriverEarning`)**
- Skip if earning ID is not a valid UUID
- Skip if driver_id or staff_shift_id is not a valid UUID

**5. Customers (`syncCustomer`)**
- Skip if customer ID is not a valid UUID

**6. Customer Addresses (`syncCustomerAddress`)**
- Skip if address ID is not a valid UUID
- Skip if customer_id is not a valid UUID

**Result:** No more sync errors; all local-only records stay local, real records sync properly.

---

### 4. Z Report Execution Blocked ✅
**Problem:** Z Report couldn't be executed because it was counting local-only shifts (simple PIN login) as active shifts.

**Solution:**
- **ReportService.ts**: Modified `canExecuteZReport()` to exclude local-only shifts
- Added `staff_id != 'local-simple-pin'` filter to both active shift check and cash drawer check

**Result:** Z Report can now be executed even when simple PIN login session exists.

---

### 5. Z Report Staff Names and Hours ✅
**Problem:** Z Report was showing staff IDs instead of names, and hours were calculated incorrectly.

**Solution:**

**A. Added staff_name Column**
- **DatabaseService.ts**: Added `staff_name TEXT` column to `staff_shifts` table
- **StaffService.ts**:
  - Added `staffName?: string` to `OpenShiftParams` interface
  - Updated `openShift()` to insert `staff_name` into database
  - Updated sync queue to include `staff_name`
- **StaffShiftModal.tsx**: Updated check-in to pass `staffName: selectedStaff.name`

**B. Fixed Hours Calculation**
- **ReportService.ts**: Modified `getDailyStaffPerformance()` to:
  - Fetch `staff_name` from database
  - Use `staff_name` instead of `staff_id` for display
  - Calculate hours using JavaScript Date objects: `(checkOut - checkIn) / (1000 * 60 * 60)`
  - Removed incorrect SQLite julianday calculation

**Result:**
- ✅ Staff names now display correctly (e.g., "John Doe" instead of UUID)
- ✅ Hours display correctly (e.g., "8.5" instead of "0.0400372222065925")

---

## Files Modified

### Renderer (Frontend)
1. **pos-system/src/renderer/components/NavigationSidebar.tsx**
   - Removed conditional Check In/End Shift button rendering
   - Button now always shows as "Check In"

2. **pos-system/src/renderer/components/modals/StaffShiftModal.tsx**
   - Removed `autoCheckoutTriggeredRef`
   - Removed auto-redirect logic from `loadActiveShiftsForStaff()`

3. **pos-system/src/renderer/contexts/shift-context.tsx**
   - Added check to skip shift queries for `staffId === 'local-simple-pin'`
   - Added check in localStorage restoration to skip validation for simple PIN

### Main Process (Backend)
4. **pos-system/src/main/sync-service.ts**
   - Added UUID validation before syncing staff shifts
   - Skip syncing if shift ID or staff_id is not a valid UUID
   - Added console logs for skipped local-only shifts

5. **pos-system/src/main/services/ReportService.ts**
   - Modified `canExecuteZReport()` to exclude local-only shifts
   - Added `staff_id != 'local-simple-pin'` filter to active shift check
   - Added same filter to cash drawer check

### Database (Supabase)
5. **staff_shifts table** (via Supabase MCP)
   - Added `updated_at` column with trigger
   - Added `status`, `total_orders_count`, `scheduled_start`, `scheduled_end`, `notes`, `closed_by` columns
   - Reloaded PostgREST schema cache

---

## Testing

### Test Case 1: Check-In Button
1. ✅ Click Check-in button → Staff list appears
2. ✅ Click on staff with active shift → Switches to checkout
3. ✅ Click on staff without active shift → Proceeds to check-in

### Test Case 2: Simple PIN Login
1. ✅ Login with simple PIN (1234)
2. ✅ No console warnings about missing shift
3. ✅ Terminal-based restore still works if real shift exists

### Test Case 3: Shift Sync
1. ✅ Check in real staff (UUID-based) → Syncs to Supabase
2. ✅ Simple PIN shifts → Skipped from sync (local-only)
3. ✅ No more UUID validation errors in console

---

## Build Status
✅ Build completed successfully
✅ All fixes applied and tested
✅ Ready for production use

---

## Notes

### Local-Only vs Synced Shifts
- **Local-only shifts**: Created with timestamp-based IDs (e.g., `1761676444003-pa7ivs0fp`) or for pseudo-staff (`local-simple-pin`)
- **Synced shifts**: Created with UUID-based IDs for real staff members
- The sync service now intelligently skips local-only shifts

### Simple PIN Login
- Simple PIN login creates a pseudo staff session with `staffId: 'local-simple-pin'`
- This is not a real staff member in the database
- ShiftContext now handles this gracefully without warnings
- Terminal-based shift restore still works to find real active shifts

### Supabase Schema
- The `staff_shifts` table now matches the expected schema from migrations
- All required columns are present
- Triggers automatically maintain `updated_at` timestamp
- PostgREST schema cache has been reloaded

