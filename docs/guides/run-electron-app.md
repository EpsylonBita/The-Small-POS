# Running the POS System in Electron Mode

## Quick Start

### Option 1: Run Everything Together (Recommended)
This command starts the dev server and Electron app automatically:

```bash
npm run dev:electron
```

This will:
1. Start the webpack dev server on http://localhost:3002
2. Build the main process
3. Wait for the dev server to be ready
4. Launch the Electron app

### Option 2: Manual Start (Two Terminals)

**Terminal 1 - Start Dev Server:**
```bash
npm run dev
```

Wait until you see:
```
webpack 5.x.x compiled successfully
```

**Terminal 2 - Start Electron:**
```bash
npm start
```

## Testing Check-In with PIN

Once the Electron app is running:

1. **Click "Check In"** button in the sidebar
2. **Select a staff member** (e.g., Antoine Rousseau)
3. **Enter PIN** (e.g., 5678 for Antoine)
4. **Select role** (e.g., Kitchen)
5. **Complete check-in** ✅

### Staff Members with PINs Set

Currently configured:
- **Antoine Rousseau**: PIN `5678`
- **Development Admin**: PIN `1234` (if set)

### Setting PINs for Other Staff

Use the helper script:
```bash
node set-staff-pin.js staff@example.com 1234
```

Or list all staff:
```bash
node set-staff-pin.js
```

## Troubleshooting

### Error: "ERR_CONNECTION_REFUSED"
**Problem:** Electron is trying to load before the dev server is ready.

**Solution:** Use `npm run dev:electron` which waits for the server, or manually start the dev server first.

### Error: "Failed to perform initial health check"
**Problem:** Database health check function is missing (non-critical).

**Solution:** This is a warning and doesn't prevent the app from working. The app will continue to function normally.

### Error: "Heartbeat failed: Not Found"
**Problem:** Terminal heartbeat endpoint not found (non-critical).

**Solution:** This is a warning for the terminal registration system. The app will continue to function normally.

### Port 3002 Already in Use
**Problem:** Another process is using port 3002.

**Solution:** 
1. Stop the other process
2. Or change the port in `webpack.renderer.config.js`

## Development vs Production

### Development Mode (Current)
- Hot reload enabled
- Dev tools available
- Loads from http://localhost:3002
- Run with: `npm run dev:electron`

### Production Build
To create a production build:

```bash
# Build the app
npm run build

# Create installer
npm run dist
```

The installer will be in the `release` folder.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server only (browser mode) |
| `npm run dev:electron` | Start dev server + Electron app |
| `npm start` | Start Electron app (requires dev server running) |
| `npm run build` | Build for production |
| `npm run dist` | Create installer |

## Features Available in Electron Mode

✅ **Full POS Functionality:**
- Staff check-in/check-out with PIN
- Shift management
- Order processing
- Offline mode
- Local database
- Receipt printing
- Cash drawer integration

❌ **Not Available in Browser Mode:**
- Shift management (requires Electron API)
- Local database access
- Hardware integration
- Offline capabilities

## Next Steps

1. **Run the app:**
   ```bash
   npm run dev:electron
   ```

2. **Test check-in:**
   - Use Antoine Rousseau with PIN 5678
   - Or set PINs for other staff members

3. **Verify functionality:**
   - Check-in should complete successfully
   - Shift should be created
   - Staff member should be logged in

## System Requirements

- Node.js 18+ 
- Windows 10/11 (or macOS/Linux)
- 4GB RAM minimum
- 500MB disk space

## Support

If you encounter issues:
1. Check the console for error messages
2. Review the troubleshooting section above
3. Check the documentation files:
   - `CHECK_IN_FIX_COMPLETE.md`
   - `PIN_VERIFICATION_FIX.md`
   - `QUICK_START_PIN_SETUP.md`

## Important Notes

⚠️ **Always run the dev server before starting Electron** (or use `npm run dev:electron`)

✅ **PIN verification is working perfectly** - The database function has been fixed

🎯 **Use Electron mode for full functionality** - Browser mode is limited to testing UI only

