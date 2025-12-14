/**
 * Clipboard Handlers Module
 *
 * Handles clipboard IPC operations.
 */

import { clipboard, ipcMain } from 'electron';

/**
 * Register clipboard IPC handlers
 */
export function registerClipboardHandlers(): void {
  // Register clipboard IPC handlers early
  ipcMain.handle('clipboard:read-text', async () => {
    try {
      return clipboard.readText();
    } catch (error) {
      console.error('Failed to read clipboard:', error);
      throw error;
    }
  });

  ipcMain.handle('clipboard:write-text', async (_event, text: string) => {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      console.error('Failed to write clipboard:', error);
      throw error;
    }
  });
}
