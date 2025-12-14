/**
 * Auto-Updater Service
 *
 * Handles application updates for production builds using electron-updater.
 * Implements channel support (stable/beta), progress tracking, and OTA updates.
 */

import { app, ipcMain } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { serviceRegistry } from './service-registry';
import { logErrorToFile } from './lifecycle/error-logging';

// Update channel types
export type UpdateChannel = 'stable' | 'beta';

// Update state
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  updateInfo?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

export class AutoUpdaterService extends EventEmitter {
  private state: UpdateState = { status: 'idle' };
  private channel: UpdateChannel = 'stable';
  private checkInterval: NodeJS.Timeout | null = null;
  private logger = console;

  constructor() {
    super();
    this.setupAutoUpdater();
    this.setupIPC();
    this.loadConfiguration();
  }

  /**
   * Set up electron-updater configuration
   */
  private setupAutoUpdater(): void {
    // Only available in packaged builds
    if (!app.isPackaged) {
      this.logger.log('[AutoUpdater] Skipped in development mode');
      // For testing in dev, you can uncomment this:
      // autoUpdater.forceDevUpdateConfig = true;
      return;
    }

    // Logger
    autoUpdater.logger = this.logger;

    // Disable auto-download to give user control
    autoUpdater.autoDownload = false;

    // Enable differential updates for faster downloads
    autoUpdater.autoRunAppAfterInstall = true;

    // Event listeners
    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking' });
      this.emitToRenderer('update-checking');
      this.logger.log('[AutoUpdater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.setState({ status: 'available', updateInfo: info });
      this.emitToRenderer('update-available', info);
      this.logger.log(`[AutoUpdater] Update available: ${info.version}`);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.setState({ status: 'not-available', updateInfo: info });
      this.emitToRenderer('update-not-available', info);
      this.logger.log('[AutoUpdater] Update not available');
    });

    autoUpdater.on('error', (err: Error) => {
      this.setState({ status: 'error', error: err.message });
      this.emitToRenderer('update-error', { message: err.message });
      
      // Don't spam logs for common non-critical errors (404 = no releases yet, network issues)
      const isNonCritical = err.message.includes('404') || 
                           err.message.includes('net::') ||
                           err.message.includes('ENOTFOUND');
      if (isNonCritical) {
        this.logger.log('[AutoUpdater] Update check failed (non-critical):', err.message);
      } else {
        this.logger.error('[AutoUpdater] Error:', err);
        logErrorToFile(err);
      }
    });

    autoUpdater.on('download-progress', (progressObj: ProgressInfo) => {
      this.setState({ status: 'downloading', progress: progressObj });
      this.emitToRenderer('download-progress', progressObj);
      this.logger.log(`[AutoUpdater] Download progress: ${progressObj.percent.toFixed(2)}%`);
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.setState({ status: 'downloaded', updateInfo: info });
      this.emitToRenderer('update-downloaded', info);
      this.logger.log(`[AutoUpdater] Update downloaded: ${info.version}`);
    });
  }

  /**
   * Set up IPC handlers
   */
  private setupIPC(): void {
    ipcMain.handle('update:check', () => this.checkForUpdates());
    ipcMain.handle('update:download', () => this.downloadUpdate());
    ipcMain.handle('update:cancel-download', () => this.cancelDownload());
    ipcMain.handle('update:install', () => this.installUpdate());
    ipcMain.handle('update:get-state', () => this.state);
    ipcMain.handle('update:set-channel', (_, channel: UpdateChannel) => this.setChannel(channel));
  }

  /**
   * Load configuration from env or settings
   */
  private loadConfiguration(): void {
    // Default to stable, but allow override via env
    const envChannel = process.env.UPDATE_CHANNEL as UpdateChannel;
    if (envChannel && ['stable', 'beta'].includes(envChannel)) {
      this.setChannel(envChannel);
    }
  }

  /**
   * Set update channel (stable/beta)
   */
  public setChannel(channel: UpdateChannel): void {
    if (this.channel === channel) return;

    this.channel = channel;
    this.logger.log(`[AutoUpdater] Channel set to: ${channel}`);

    // Configure electron-updater channel
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel === 'beta';

    // Persist if needed (implied by service pattern)
  }

  private cancellationToken: any = null;

  /**
   * Check for updates
   */
  public async checkForUpdates(): Promise<UpdateInfo | null> {
    if (!app.isPackaged && !autoUpdater.forceDevUpdateConfig) {
      this.logger.log('[AutoUpdater] Skipping check in dev mode');
      return null;
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      this.cancellationToken = result?.cancellationToken;
      return result?.updateInfo || null;
    } catch (error) {
      this.logger.error('[AutoUpdater] Check failed:', error);
      throw error;
    }
  }

  /**
   * Download the update
   */
  public async downloadUpdate(): Promise<void> {
    if (this.state.status !== 'available') {
      throw new Error('No update available to download');
    }

    this.logger.log('[AutoUpdater] Starting download...');
    // We already have the token from check, electron-updater uses it internally if managed properly,
    // or we might need to pass it? 
    // Actually, if we use the same autoUpdater instance, it should handle it?
    // But explicitly: autoUpdater.downloadUpdate(this.cancellationToken) if valid.
    // However, typings might be tricky. Let's try standard call.
    await autoUpdater.downloadUpdate(this.cancellationToken);
  }

  /**
   * Cancel the download
   */
  public cancelDownload(): void {
    if (this.state.status !== 'downloading') {
      this.logger.log('[AutoUpdater] Cancel requested but not downloading');
      return;
    }

    this.logger.log('[AutoUpdater] Cancelling download...');
    if (this.cancellationToken) {
      this.cancellationToken.cancel();
    }
    this.setState({ status: 'available', progress: undefined });
  }


  /**
   * Install the update (quit and install)
   */
  public installUpdate(): void {
    if (this.state.status !== 'downloaded') {
      throw new Error('Update not downloaded');
    }

    this.logger.log('[AutoUpdater] Quitting to install...');
    autoUpdater.quitAndInstall();
  }

  /**
   * Start periodic update checks
   */
  public startPeriodicChecks(intervalMs: number = 4 * 60 * 60 * 1000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    // Initial check after 30 seconds (per Requirement 3.1)
    setTimeout(() => this.checkForUpdates(), 30000);

    // Periodic checks
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, intervalMs);
  }

  /**
   * Helper to update internal state
   */
  private setState(newState: Partial<UpdateState>): void {
    this.state = { ...this.state, ...newState };
  }

  /**
   * Helper to send events to renderer
   */
  private emitToRenderer(channel: string, data?: any): void {
    const mainWindow = serviceRegistry.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.removeAllListeners();
  }
}

// Export a standalone function for initialization if needed by legacy code, 
// but preferred usage is via service registry
export function initializeAutoUpdater(): void {
  // This is kept for backward compatibility if referenced elsewhere,
  // but now creates/starts the service.
  const service = new AutoUpdaterService();
  service.startPeriodicChecks();
  serviceRegistry.register('autoUpdaterService', service);
}
