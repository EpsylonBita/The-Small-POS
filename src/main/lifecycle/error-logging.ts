/**
 * Error Logging Module
 *
 * Provides centralized error logging to files and error dialog display.
 */

import { app, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { POSError } from '../../shared/utils/error-handler';

/**
 * Log an error to a file with automatic rotation (keeps last 7 days)
 */
export function logErrorToFile(error: POSError | Error | unknown): void {
  try {
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');

    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, `error-${new Date().toISOString().split('T')[0]}.log`);
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';

    const logEntry = `[${timestamp}] ${errorMessage}\n${errorStack}\n\n`;

    fs.appendFileSync(logFile, logEntry);

    // Rotate log files (keep only last 7 days)
    rotateLogFiles(logsDir, 7);
  } catch (logError) {
    console.error('Failed to log error to file:', logError);
  }
}

/**
 * Rotate log files, keeping only files newer than specified days
 */
function rotateLogFiles(logsDir: string, daysToKeep: number): void {
  try {
    const files = fs.readdirSync(logsDir);
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    files.forEach((file) => {
      const filePath = path.join(logsDir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < cutoffTime) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (err) {
    console.error('Failed to rotate log files:', err);
  }
}

/**
 * Show an error dialog to the user
 */
export async function showErrorDialog(
  title: string,
  message: string,
  buttons: string[]
): Promise<number> {
  const result = await dialog.showMessageBox({
    type: 'error',
    title,
    message,
    detail: message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });

  return result.response;
}

/**
 * Show an info dialog to the user
 */
export async function showInfoDialog(title: string, message: string): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    title,
    message,
    buttons: ['OK'],
  });
}

/**
 * Show a confirmation dialog
 */
export async function showConfirmDialog(
  title: string,
  message: string,
  confirmButton = 'OK',
  cancelButton = 'Cancel'
): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'question',
    title,
    message,
    buttons: [confirmButton, cancelButton],
    defaultId: 0,
    cancelId: 1,
  });

  return result.response === 0;
}
