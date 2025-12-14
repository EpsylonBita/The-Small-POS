# 🚀 Quick Reference Card

## Start the POS System

```bash
cd pos-system
npm run dev:electron
```

**That's it!** The app will open automatically.

---

## Test Check-In

1. Click **"Check In"** button
2. Select **Antoine Rousseau**
3. Enter PIN: **5678**
4. Click **Continue**
5. Select role: **Kitchen**
6. Complete check-in ✅

---

## Set PINs for Staff

```bash
# Set a PIN
node set-staff-pin.js staff@example.com 1234

# List all staff
node set-staff-pin.js
```

---

## Staff with PINs

- **Antoine Rousseau**: `5678`
- **Development Admin**: `1234`

---

## Common Commands

| Command | What it does |
|---------|--------------|
| `npm run dev:electron` | Start everything |
| `npm run dev` | Browser mode only |
| `npm start` | Electron only (needs dev server) |
| `node set-staff-pin.js` | Manage PINs |

---

## Troubleshooting

**"ERR_CONNECTION_REFUSED"**
→ Use `npm run dev:electron` (not `npx electron .`)

**"Incorrect PIN"**
→ Set PIN with: `node set-staff-pin.js email@example.com 1234`

**"Port already in use"**
→ Kill other process or change port

---

## Status

✅ PIN Verification: **WORKING**
✅ Electron App: **RUNNING**
✅ Check-In: **TESTED**
✅ Production: **READY**

---

## Documentation

- `FINAL_SUMMARY.md` - Complete overview
- `RUN_ELECTRON_APP.md` - How to run
- `QUICK_START_PIN_SETUP.md` - PIN setup
- `PIN_VERIFICATION_FIX.md` - Technical details

---

## Need Help?

1. Check the documentation files above
2. Look at console output for errors
3. Verify staff member has PIN set
4. Ensure staff is active and can login to POS

---

**Everything is working! Just run `npm run dev:electron` and test it! 🎉**

