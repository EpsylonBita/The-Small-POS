# Set POS Terminal API Key

## Terminal Information
- **Terminal ID:** `terminal-f261acaf`
- **Terminal Name:** POS Terminal 001
- **Branch:** To Mikro Parisi (Konstantinoupoleos)
- **API Key:** `SU-NtBGz4gBJPeAnQt0f6iAL9waoLjeO`

## Quick Method: Use Browser Console

1. **Open the POS app**
2. **Press `F12`** to open DevTools
3. **Go to Console tab**
4. **Paste this command:**

```javascript
// Set the per-terminal API key for terminal-f261acaf
window.electronAPI.ipcRenderer.invoke('settings:set', {
  category: 'terminal',
  key: 'pos_api_key',
  value: 'SU-NtBGz4gBJPeAnQt0f6iAL9waoLjeO'
}).then(result => {
  console.log('✅ API key set successfully!');
  console.log('Result:', result);
  console.log('⚠️  IMPORTANT: Restart the POS app for changes to take effect!');
}).catch(error => {
  console.error('❌ Failed to set API key:', error);
});
```

5. **Press Enter**
6. **Wait for confirmation** - You should see:
   - `✅ API key set successfully!`
   
7. **Restart the POS app completely** to load the new API key

---

## What This Does:

- Stores the per-terminal API key in local settings
- The API key is unique to this terminal (POS Terminal 001)
- Used for authenticating with Admin Dashboard
- Required for heartbeat, sync, and Z-Report submission

---

## Security Note:

Each terminal has its own unique API key. This ensures:
- Multi-terminal support (multiple POS systems in same branch)
- Security isolation between terminals
- Ability to revoke individual terminal access

---

## Verify It Works:

After restarting, check the console for:

```
🔑 [Heartbeat] Auth debug: {
  hasApiKey: true,
  apiKeySource: 'terminal_settings',
  apiKeyLength: 33,
  apiKeyLast4: 'LjeO',
  terminalId: 'terminal-f261acaf'
}
✅ Heartbeat sent successfully for terminal: terminal-f261acaf
```

If you see `hasApiKey: false`, the API key was not saved correctly. Try the command again.

