import { BrowserWindow } from 'electron';
import { DatabaseManager } from '../../database';

export class NetworkMonitor {
    private isOnline: boolean = true;
    private checkInterval: NodeJS.Timeout | null = null;
    private mainWindow: BrowserWindow | null = null;

    constructor(private dbManager: DatabaseManager) { }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public startMonitoring(intervalMs: number = 30000) {
        if (this.checkInterval) return;

        // Initial check
        this.checkNetworkStatus();

        this.checkInterval = setInterval(() => {
            this.checkNetworkStatus();
        }, intervalMs);
    }

    public stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    public getIsOnline(): boolean {
        return this.isOnline;
    }

    private async checkNetworkStatus() {
        try {
            // Simple connectivity check
            const response = await fetch('https://www.google.com/favicon.ico', {
                method: 'HEAD',
                cache: 'no-cache',
                signal: AbortSignal.timeout(5000)
            });

            const currentlyOnline = response.ok;
            this.updateStatus(currentlyOnline);
        } catch (error) {
            this.updateStatus(false);
        }
    }

    private updateStatus(online: boolean) {
        if (this.isOnline !== online) {
            this.isOnline = online;
            console.log(`[NetworkMonitor] Network status changed: ${online ? 'ONLINE' : 'OFFLINE'}`);

            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('network-status-change', { online });
            }
        }
    }
}
