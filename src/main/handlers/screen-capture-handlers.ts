/**
 * Screen Capture Handlers Module
 *
 * Handles screen capture IPC for live remote viewing.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';

/**
 * Register screen capture IPC handlers
 */
export function registerScreenCaptureHandlers(): void {
  // Screen Capture IPC handlers for live remote viewing
  ipcMain.handle('screen-capture:get-status', async () => {
    try {
      const screenCaptureService = serviceRegistry.screenCaptureService;
      if (!screenCaptureService) {
        return { success: false, error: 'Screen capture service not initialized' };
      }
      const status = screenCaptureService.getStatus();
      return { success: true, status };
    } catch (error) {
      console.error('Error getting screen capture status:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('screen-capture:stop', async () => {
    try {
      const screenCaptureService = serviceRegistry.screenCaptureService;
      if (!screenCaptureService) {
        return { success: false, error: 'Screen capture service not initialized' };
      }
      await screenCaptureService.stopStreaming();
      return { success: true };
    } catch (error) {
      console.error('Error stopping screen capture:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // SECURITY: DISABLED - Remote input injection is a critical security vulnerability
  // This feature allows arbitrary input injection which can lead to:
  // - Opening DevTools and executing malicious code
  // - Navigating to malicious sites
  // - Exfiltrating sensitive data
  // - Modifying system settings
  //
  // If remote support is required, implement specific, validated actions instead:
  // - 'remote-support:click-element' with element ID validation
  // - 'remote-support:navigate-to-page' with page whitelist
  // - Always require explicit user confirmation for remote actions
  // - Implement audit logging for all remote support sessions
  /*
  ipcMain.handle('input:inject', async (_event, inputEvent: any) => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: 'Main window not available' };
      }
      const allowedTypes = new Set([
        'mouseDown',
        'mouseUp',
        'mouseMove',
        'mouseWheel',
        'keyDown',
        'keyUp',
        'char',
      ]);
      if (!inputEvent || !allowedTypes.has(inputEvent.type)) {
        return { success: false, error: 'Invalid input event' };
      }

      // If normalized coordinates provided (0..1), map to window content bounds
      if (
        typeof inputEvent.x === 'number' &&
        typeof inputEvent.y === 'number' &&
        inputEvent.normalized
      ) {
        const bounds = mainWindow.getContentBounds();
        inputEvent.x = Math.round(bounds.width * inputEvent.x);
        inputEvent.y = Math.round(bounds.height * inputEvent.y);
        delete inputEvent.normalized;
      }

      mainWindow.webContents.sendInputEvent(inputEvent as any);
      return { success: true };
    } catch (error) {
      console.error('Error injecting input event:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
  */
}
