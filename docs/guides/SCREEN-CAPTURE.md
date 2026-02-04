# Remote Screen Capture Feature

## Overview

Allows admin dashboard users to view POS terminal screens for remote support and troubleshooting.

---

## Security Model

1. **Consent Required**: User must approve screen capture via dialog
2. **Remote Input Disabled**: Remote keyboard/mouse input is blocked for security
3. **View-Only**: Admin can only observe, not control

---

## Architecture

| Component | Location | Purpose |
|-----------|----------|---------|
| Main Process Handlers | `src/main/handlers/screen-capture-handlers.ts` | IPC handlers with consent dialog |
| Renderer Service | `src/renderer/services/ScreenCaptureHandler.ts` | WebRTC streaming |
| Signaling | Supabase Realtime | `screen_share_requests` table |

---

## Flow

1. **Admin initiates request**
   - Admin dashboard user clicks "View Screen" for a terminal
   - Request is sent via Supabase realtime channel

2. **POS receives request**
   - Terminal listens to `screen_share_requests` realtime channel
   - Request is intercepted by ScreenCaptureHandler

3. **User consent dialog**
   - POS displays consent dialog to the terminal user
   - User must explicitly approve the screen share request

4. **WebRTC connection established**
   - If approved, WebRTC peer connection is created
   - Signaling occurs through Supabase realtime

5. **Screen stream sent**
   - Terminal screen is captured and streamed to admin dashboard
   - Admin can observe the screen in real-time

6. **Session termination**
   - Either party can end the session
   - Connection is cleaned up automatically

---

## Implementation Details

### Consent Dialog

The consent dialog is displayed via Electron's `dialog.showMessageBox()`:

```typescript
const result = await dialog.showMessageBox(mainWindow, {
  type: 'question',
  buttons: ['Approve', 'Deny'],
  defaultId: 1,
  title: 'Screen Share Request',
  message: 'An administrator is requesting to view your screen.',
  detail: 'This is for remote support purposes. Your screen will be view-only - no remote control is allowed.'
});
```

### Security Measures

- **No Remote Input**: The `remoteInputEnabled` flag is always `false`
- **Explicit Consent**: User must click "Approve" to share
- **Session Isolation**: One active session per terminal
- **Network Required**: Requires active network connectivity

---

## Limitations

| Limitation | Description |
|------------|-------------|
| Remote input injection | Disabled for security reasons |
| Network dependency | Requires network connectivity |
| Single session | Only one active session per terminal |
| View-only | Admin cannot control the terminal remotely |

---

## Related Files

- `src/main/handlers/screen-capture-handlers.ts` - Main process IPC handlers
- `src/renderer/services/ScreenCaptureHandler.ts` - Renderer WebRTC service
- `src/preload/index.ts` - IPC bridge for screen capture APIs

---

## Troubleshooting

**Screen share request not received:**
- Check network connectivity
- Verify Supabase realtime connection is active
- Check terminal is registered and online

**Connection fails after approval:**
- Check WebRTC connectivity (firewalls may block)
- Verify Supabase credentials are valid
- Check browser console for WebRTC errors

**Poor video quality:**
- Network bandwidth may be limited
- WebRTC automatically adjusts quality based on bandwidth

---

## Security Considerations

- Screen capture requires explicit user consent every time
- No persistent permissions are stored
- Remote input is never allowed, even if requested
- All signaling occurs through authenticated Supabase channels
- Session data is not stored or logged
