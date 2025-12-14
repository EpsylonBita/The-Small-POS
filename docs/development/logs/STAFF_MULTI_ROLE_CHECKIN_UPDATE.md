# POS System - Staff Multi-Role Check-In Display

## Overview
Updated the POS system staff check-in modal to display **all roles** for each staff member, not just the primary role.

## Changes Made

### 1. Updated StaffMember Interface

**File:** `pos-system/src/renderer/components/modals/StaffShiftModal.tsx`

**Added new interface:**
```typescript
interface StaffRole {
  role_id: string;
  role_name: string;
  role_display_name: string;
  role_color: string;
  is_primary: boolean;
}
```

**Updated StaffMember interface:**
```typescript
interface StaffMember {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  role_id: string;
  role_name: string;
  role_display_name: string;
  roles: StaffRole[]; // NEW: All roles for this staff member
  can_login_pos: boolean;
  is_active: boolean;
}
```

### 2. Added loadStaffRoles Function

**Purpose:** Fetch all roles from the `staff_roles` junction table for each staff member.

**Implementation:**
```typescript
const loadStaffRoles = async (staffList: StaffMember[]) => {
  // Uses supabaseUrl and supabaseKey from parent scope (loadStaff function)

  // Fetch from staff_roles table with role details
  const rolesRes = await fetch(
    `${supabaseUrl}/rest/v1/staff_roles?staff_id=in.(${staffIds.join(',')})&select=staff_id,role_id,is_primary,role:roles(id,name,display_name,color)`,
    { headers: { apikey, Authorization } }
  );

  // Group roles by staff_id
  // Assign to staff members
  // Fallback to primary role if no roles in junction table
}
```

**Features:**
- Fetches all roles for all staff members in one query
- Groups roles by staff_id
- Assigns roles to each staff member
- **Fallback:** If no roles in `staff_roles` table, uses primary role from `staff` table
- **Error handling:** On failure, falls back to primary role

### 3. Updated Staff List UI to Display All Roles

**Location:** Step 1 - Select Staff

**Before:**
```tsx
<div className="liquid-glass-modal-text-muted text-sm">
  {staffMember.role_display_name}
</div>
```

**After:**
```tsx
<div className="flex flex-wrap gap-1.5">
  {staffMember.roles && staffMember.roles.length > 0 ? (
    staffMember.roles
      .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)) // Primary first
      .map((role, idx) => (
        <span
          key={idx}
          className="text-xs px-2 py-0.5 rounded-full border flex items-center gap-1"
          style={{
            backgroundColor: `${role.role_color}20`,
            borderColor: `${role.role_color}40`,
            color: role.role_color
          }}
        >
          {role.is_primary && (
            <span className="text-yellow-400">★</span>
          )}
          {role.role_display_name}
        </span>
      ))
  ) : (
    <span className="liquid-glass-modal-text-muted text-sm">
      {staffMember.role_display_name}
    </span>
  )}
</div>
```

## Visual Design

### Role Badges
- **Color-coded** using role color from database
- **Semi-transparent background** (`${color}20`)
- **Colored border** (`${color}40`)
- **Colored text** (role color)
- **Primary role indicator:** Yellow star (★) before role name
- **Sorted:** Primary role appears first

### Example Display
```
John Doe
★ Cashier  Kitchen  Server
```

Where:
- "Cashier" has a yellow star (primary role)
- Each badge has its own color from the database
- Badges wrap to multiple lines if needed

## Integration with Existing Flow

1. **Staff List Load:**
   - Fetches staff via `pos_list_staff_for_checkin` RPC
   - Calls `loadStaffRoles()` to fetch all roles
   - Displays staff with all role badges

2. **Check-In Flow:**
   - User selects staff member (sees all roles)
   - Enters PIN
   - Selects role (from available roles)
   - Completes check-in

3. **Backward Compatibility:**
   - If `staff_roles` table is empty, falls back to primary role
   - If API fails, uses primary role from `staff` table
   - Existing check-in logic unchanged

## Database Query

**Endpoint:** `GET /rest/v1/staff_roles`

**Query:**
```
?staff_id=in.(uuid1,uuid2,...)
&select=staff_id,role_id,is_primary,role:roles(id,name,display_name,color)
```

**Response:**
```json
[
  {
    "staff_id": "uuid1",
    "role_id": "role-uuid-1",
    "is_primary": true,
    "role": {
      "id": "role-uuid-1",
      "name": "cashier",
      "display_name": "Cashier",
      "color": "#3B82F6"
    }
  },
  {
    "staff_id": "uuid1",
    "role_id": "role-uuid-2",
    "is_primary": false,
    "role": {
      "id": "role-uuid-2",
      "name": "kitchen",
      "display_name": "Kitchen",
      "color": "#EF4444"
    }
  }
]
```

## Benefits

1. **Full Visibility:** Staff can see all their assigned roles at check-in
2. **Better Context:** Managers know which roles each staff member can perform
3. **Accurate Representation:** Matches the Admin Dashboard multi-role system
4. **Visual Clarity:** Color-coded badges make roles easy to identify
5. **Primary Role Highlighted:** Star indicator shows which role is primary

## Testing Checklist

- [ ] Staff with single role displays correctly
- [ ] Staff with multiple roles displays all badges
- [ ] Primary role shows star indicator
- [ ] Primary role appears first in list
- [ ] Role colors display correctly
- [ ] Badges wrap properly on small screens
- [ ] Fallback to primary role works if staff_roles is empty
- [ ] Error handling works if API fails
- [ ] Check-in flow still works correctly
- [ ] Active shift indicator still shows

## Files Modified

1. `pos-system/src/renderer/components/modals/StaffShiftModal.tsx`
   - Added `StaffRole` interface
   - Updated `StaffMember` interface
   - Added `loadStaffRoles()` function
   - Updated staff list UI to display role badges
   - **Updated role selection screen to show all roles**

2. `pos-system/src/locales/en.json`
   - Added `primaryRole` translation
   - Added `secondaryRole` translation

3. `pos-system/src/locales/el.json`
   - Added `primaryRole` translation (Greek)
   - Added `secondaryRole` translation (Greek)

## Compatibility

- ✅ **Backward Compatible:** Works with existing single-role staff
- ✅ **Graceful Degradation:** Falls back to primary role on error
- ✅ **Database Agnostic:** Works whether staff_roles table is populated or not
- ✅ **No Breaking Changes:** Existing check-in flow unchanged

## Future Enhancements

- [ ] Allow filtering staff by role in check-in modal
- [ ] Show role-specific permissions or capabilities
- [ ] Add role selection based on available roles (not just primary)
- [ ] Display role-specific shift history

