# PIN Verification Fix - Staff Check-In Issue

## Problem Summary
Users were unable to check in because the PIN verification was failing with "Incorrect PIN. Please try again." error, even when entering the correct PIN.

## Root Cause
The `StaffShiftModal.tsx` component was comparing the entered PIN directly with the `staff.pin` field from the database:

```typescript
if (enteredPin !== selectedStaff.pin) {
  setError('Incorrect PIN. Please try again.');
}
```

However, the database stores PINs as **bcrypt hashes** (`pin_hash`), not plain text. This meant the comparison would always fail.

## Solution Implemented

### 1. Updated PIN Verification Logic
Changed the `handlePinSubmit` function to use the Supabase `verify_staff_pin` RPC function which properly verifies PINs against bcrypt hashes.

**Key Changes:**
- Made `handlePinSubmit` async
- Calls `verify_staff_pin` RPC function via Supabase REST API
- Properly handles the response (which is an array, not a single object)
- Verifies that the returned `staff_id` matches the selected staff member
- Added comprehensive error handling and loading states

### 2. Security Improvements
- Removed `pin` field from `StaffMember` interface
- Removed `pin` from the staff data query
- PIN hashes are no longer sent to the frontend
- All PIN verification is done server-side

### 3. Added Debug Logging
Added console logging to help diagnose issues:
- Logs the raw verification response
- Logs the parsed result
- Logs detailed failure information
- Logs success confirmation

## How to Test

### Step 1: Set a PIN for a Staff Member

Use the provided script to set a PIN:

```bash
node set-staff-pin.js <staff-email> <pin>
```

Example:
```bash
node set-staff-pin.js john@example.com 1234
```

If you don't know the staff emails, just run:
```bash
node set-staff-pin.js
```

This will list all available staff members.

### Step 2: Test Check-In

1. Open the POS system
2. Click on "Check In" in the Shift Manager
3. Select the staff member you set the PIN for
4. Enter the PIN (e.g., 1234)
5. Click "Continue"

### Step 3: Check Browser Console

Open the browser developer console (F12) and look for:
- "PIN Verification Response:" - Shows the raw API response
- "Parsed Result:" - Shows the extracted result
- "PIN verification successful!" - Confirms successful verification

If verification fails, you'll see detailed debug information about why.

## Common Issues and Solutions

### Issue 1: "Supabase configuration missing"
**Solution:** Make sure your `.env` file has:
```
SUPABASE_URL=https://voiwzwyfnkzvcffuxpwl.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
```

### Issue 2: Staff member has no PIN set
**Solution:** Use the `set-staff-pin.js` script to set a PIN for the staff member.

### Issue 3: PIN verification returns empty array
**Possible causes:**
- Staff member's `can_login_pos` is false
- Staff member's `is_active` is false
- Staff member's `pin_locked_until` is set to a future date
- PIN hash is NULL in the database

**Solution:** Check the staff record in the database:
```sql
SELECT id, first_name, last_name, email, 
       pin_hash IS NOT NULL as has_pin,
       can_login_pos, is_active, pin_locked_until
FROM staff
WHERE email = 'staff@example.com';
```

### Issue 4: Wrong staff_id returned
**Solution:** This means the PIN belongs to a different staff member. Each PIN should be unique to one staff member.

## Database Function Reference

### verify_staff_pin
```sql
CREATE OR REPLACE FUNCTION verify_staff_pin(staff_pin TEXT)
RETURNS TABLE(success BOOLEAN, staff_id UUID, role_name TEXT, branch_id UUID)
```

**Returns:** Array of results (via PostgREST)
- `success`: TRUE if PIN is valid
- `staff_id`: UUID of the staff member
- `role_name`: Role name (e.g., 'cashier', 'manager')
- `branch_id`: Branch UUID

### set_staff_pin
```sql
CREATE OR REPLACE FUNCTION set_staff_pin(staff_uuid UUID, new_pin TEXT)
RETURNS BOOLEAN
```

**Parameters:**
- `staff_uuid`: UUID of the staff member
- `new_pin`: Plain text PIN (will be hashed automatically)

**Returns:** TRUE if successful

## Files Modified

1. `pos-system/src/renderer/components/modals/StaffShiftModal.tsx`
   - Updated `StaffMember` interface (removed `pin` field)
   - Updated `loadStaff` function (removed `pin` from query)
   - Updated `handlePinSubmit` function (now uses RPC verification)
   - Added debug logging

## Helper Scripts Created

1. `pos-system/set-staff-pin.js`
   - Sets a PIN for a staff member
   - Verifies the PIN was set correctly
   - Lists available staff members

2. `pos-system/test-pin-verification.js`
   - Tests PIN verification functionality
   - Checks staff members with PINs
   - Tests various PIN combinations

## Next Steps

1. **Test the fix:** Try checking in with a staff member who has a PIN set
2. **Check console logs:** Look for any errors or unexpected behavior
3. **Set PINs for all staff:** Use the `set-staff-pin.js` script to set PINs for all staff members who need POS access
4. **Remove debug logging:** Once everything works, you can remove the console.log statements from production code

## Security Notes

- PINs are hashed using bcrypt with salt
- PIN hashes are never sent to the frontend
- PIN verification is always done server-side
- Failed PIN attempts could be logged for security auditing (future enhancement)
- Consider implementing PIN lockout after multiple failed attempts (future enhancement)

