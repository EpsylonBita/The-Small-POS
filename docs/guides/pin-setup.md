# Quick Start: Setting Up Staff PINs

## TL;DR - Get Staff Check-In Working Now

### 1. List Your Staff Members
```bash
cd pos-system
node set-staff-pin.js
```

This will show you all staff members and their emails.

### 2. Set a PIN for a Staff Member
```bash
node set-staff-pin.js staff@example.com 123456
```

Replace `staff@example.com` with the actual email and `123456` with your desired 6+ digit PIN.

### 3. Test Check-In
1. Open the POS system (it should already be running at http://localhost:3002)
2. Click "Check In" button
3. Select the staff member
4. Enter the PIN you just set
5. Click "Continue"

### 4. If It Still Doesn't Work
Open the browser console (F12) and look for error messages. The console will show:
- What the API returned
- Why the verification failed
- Detailed debug information

## Example: Setting Up Multiple Staff Members

```bash
# Set PIN for cashier
node set-staff-pin.js cashier@restaurant.com 111111

# Set PIN for manager
node set-staff-pin.js manager@restaurant.com 222222

# Set PIN for kitchen staff
node set-staff-pin.js chef@restaurant.com 333333

# Set PIN for driver
node set-staff-pin.js driver@restaurant.com 444444
```

## Troubleshooting

### "No staff member found with email"
- Check the email is correct
- Run `node set-staff-pin.js` to see all available emails
- Make sure the staff member exists in the database

### "Failed to set PIN"
- Check your `.env` file has correct Supabase credentials
- Make sure you have internet connection
- Check if the staff member's account is active

### "PIN verification failed"
- Make sure you're entering the exact PIN you set
- PINs are case-sensitive (though they should be numbers only)
- Try setting the PIN again

## Resetting a Terminal PIN (Admin Dashboard)

If a terminal PIN is forgotten or needs to be rotated:

1. Open **Admin Dashboard → POS → Terminals**.
2. Select the terminal and open **Terminal Settings**.
3. Under **Login PIN**, click **Reset PIN**.
4. Click **Sync to Terminal** (or **Save**) to push the setting.
5. On next login, the POS will require a new 6+ digit PIN and auto-login after it’s set.

### Still Having Issues?
Check the detailed guide in `PIN_VERIFICATION_FIX.md`

## What Changed?

The system now:
- ✅ Uses secure bcrypt hashing for PINs
- ✅ Verifies PINs server-side (more secure)
- ✅ Never sends PIN hashes to the frontend
- ✅ Provides detailed error messages
- ✅ Logs debug information to help troubleshoot

## Security Best Practices

1. **Use unique PINs** - Don't give everyone the same PIN
2. **Use 6+ digit PINs** - Easy enough to remember, harder to guess
3. **Change PINs regularly** - Especially if staff leaves
4. **Don't share PINs** - Each staff member should have their own

## Need Help?

If you're still having issues:
1. Check the browser console (F12) for errors
2. Check the terminal where the POS system is running for server errors
3. Review the `PIN_VERIFICATION_FIX.md` file for detailed information
4. Make sure your Supabase database has the `verify_staff_pin` and `set_staff_pin` functions

