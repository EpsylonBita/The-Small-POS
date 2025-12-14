# Check-In Button Behavior Fix

## Issue
The Check-in button was automatically redirecting to the checkout screen when exactly one staff member was already checked in, instead of showing the staff list first.

## User Requirement
The Check-in button should **always** display the staff list first. Only when a user clicks on a staff member who is already checked in should it show the checkout option for that specific staff member.

## Root Cause

The issue had two parts:

1. **NavigationSidebar.tsx**: The Check-in button was conditionally rendering as either "Check In" or "End Shift" based on `isShiftActive`. When a shift was active, it became an "End Shift" button that called `onEndShift` instead of showing the staff list.

2. **StaffShiftModal.tsx**: When the modal opened, it was automatically redirecting to checkout mode if exactly one staff member was already checked in, instead of showing the staff list first.

## Changes Made

### File 1: `pos-system/src/renderer/components/NavigationSidebar.tsx`

#### Removed Conditional Button Rendering (Line 196-215)
**Before:**
```typescript
{/* Check In / End Shift Button */}
{isShiftActive && activeShift ? (
  <button
    onClick={onEndShift}
    data-testid="end-shift-btn"
    className={`w-12 h-12 flex items-center justify-center transition-colors ${resolvedTheme==='dark' ? 'text-white hover:text-red-300' : 'text-black hover:text-red-600'}`}
    title={t('navigation.endShift')}
  >
    <Clock className={`${resolvedTheme==='dark' ? 'w-5 h-5' : 'w-5 h-5 text-black'}`} strokeWidth={2} />
  </button>
) : (
  <button
    onClick={onStartShift}
    data-testid="check-in-btn"
    className={`w-12 h-12 flex items-center justify-center transition-colors ${resolvedTheme==='dark' ? 'text-white hover:text-blue-300' : 'text-black hover:text-blue-600'}`}
    title={t('navigation.checkIn')}
  >
    <Clock className={`${resolvedTheme==='dark' ? 'w-5 h-5' : 'w-5 h-5 text-black'}`} strokeWidth={2} />
  </button>
)}
```

**After:**
```typescript
{/* Check In Button - Always shows staff list */}
<button
  onClick={onStartShift}
  data-testid="check-in-btn"
  className={`w-12 h-12 flex items-center justify-center transition-colors ${resolvedTheme==='dark' ? 'text-white hover:text-blue-300' : 'text-black hover:text-blue-600'}`}
  title={t('navigation.checkIn')}
>
  <Clock className={`${resolvedTheme==='dark' ? 'w-5 h-5' : 'w-5 h-5 text-black'}`} strokeWidth={2} />
</button>
```

**Impact:** The button now **always** shows as "Check In" and **always** calls `onStartShift` to open the staff list modal, regardless of whether there's an active shift.

### File 2: `pos-system/src/renderer/components/modals/StaffShiftModal.tsx`

#### 1. Removed Auto-Redirect Reference (Line 51-54)
**Before:**
```typescript
// Track active shifts per staff
const [staffActiveShifts, setStaffActiveShifts] = useState<Map<string, any>>(new Map());
// Ensure we only auto-redirect to checkout once per modal open
const autoCheckoutTriggeredRef = useRef(false);
```

**After:**
```typescript
// Track active shifts per staff
const [staffActiveShifts, setStaffActiveShifts] = useState<Map<string, any>>(new Map());
```

#### 2. Removed Auto-Redirect Reset (Line 90-95)
**Before:**
```typescript
setStaffPayment('');
setError('');
setSuccess('');
// Allow auto-redirect on this open
autoCheckoutTriggeredRef.current = false;
```

**After:**
```typescript
setStaffPayment('');
setError('');
setSuccess('');
```

#### 3. Removed Auto-Redirect Logic from loadActiveShiftsForStaff (Line 115-143)
**Before:**
```typescript
const loadActiveShiftsForStaff = async (staffList: StaffMember[]) => {
  const map = new Map<string, any>();
  for (const s of staffList) {
    try {
      const shift = await (window as any).electronAPI?.getActiveShift?.(s.id);
      if (shift) map.set(s.id, shift);
    } catch (e) {
      console.warn('Failed to fetch active shift for', s.id, e);
    }
  }
  setStaffActiveShifts(map);

  // If exactly one staff is already checked in, jump straight to checkout for that staff
  try {
    if (isOpen && (mode === 'checkin') && map.size === 1 && !autoCheckoutTriggeredRef.current) {
      autoCheckoutTriggeredRef.current = true;
      const onlyShift = Array.from(map.values())[0];
      console.log('[StaffShiftModal] Auto-switching to checkout for single active shift', { shiftId: onlyShift?.id, staffId: onlyShift?.staff_id });
      setLocalMode('checkout');
      setCheckoutShift(onlyShift);
      setShowExpenseForm(false);
      setClosingCash('');
      await loadExpenses(onlyShift.id);
    }
  } catch (e) {
    console.warn('[StaffShiftModal] Auto-checkout redirect failed (non-fatal):', e);
  }
};
```

**After:**
```typescript
const loadActiveShiftsForStaff = async (staffList: StaffMember[]) => {
  const map = new Map<string, any>();
  for (const s of staffList) {
    try {
      const shift = await (window as any).electronAPI?.getActiveShift?.(s.id);
      if (shift) map.set(s.id, shift);
    } catch (e) {
      console.warn('Failed to fetch active shift for', s.id, e);
    }
  }
  setStaffActiveShifts(map);
};
```

## Expected Behavior After Fix

### Scenario 1: No Staff Checked In
1. User clicks the Check-in button
2. Modal opens showing the **staff list**
3. User selects a staff member
4. User enters PIN and completes check-in flow

### Scenario 2: One or More Staff Already Checked In
1. User clicks the Check-in button
2. Modal opens showing the **staff list** (with indicators showing which staff are already checked in)
3. User can:
   - Click on a staff member who is **NOT** checked in → proceeds to check-in flow
   - Click on a staff member who **IS** checked in → switches to checkout view for that staff

## How to Test in Electron App

1. **Build the app:**
   ```bash
   npm run -w pos-system build
   ```

2. **Start the Electron app:**
   ```bash
   npm run -w pos-system start:debug
   ```

3. **Test Case 1 - No Active Shifts:**
   - Click the Check-in button (Clock icon in sidebar)
   - Verify: Staff list is displayed
   - Select a staff member and complete check-in

4. **Test Case 2 - One Staff Already Checked In:**
   - With one staff already checked in, click the Check-in button again
   - Verify: Staff list is displayed (NOT auto-redirected to checkout)
   - Click on the checked-in staff member
   - Verify: Now switches to checkout view for that staff

5. **Test Case 3 - Multiple Staff Checked In:**
   - With multiple staff checked in, click the Check-in button
   - Verify: Staff list is displayed showing all staff
   - Click on any checked-in staff member
   - Verify: Switches to checkout view for the selected staff

## Files Modified
- `pos-system/src/renderer/components/modals/StaffShiftModal.tsx`
- `pos-system/src/renderer/components/NavigationSidebar.tsx`

## Build Status
✅ Build completed successfully
✅ TypeScript compilation passed (except unrelated DeliveryZoneValidator errors)

## Notes
- The existing behavior where clicking on a staff member with an active shift switches to checkout mode is **preserved** (see line 346-350 in StaffShiftModal.tsx)
- This fix only removes the automatic redirect that happened when the modal first opened
- The staff list now always shows first, giving users full control over which action to take

