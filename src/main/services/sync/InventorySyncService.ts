import { BrowserWindow } from 'electron';

export class InventorySyncService {
    private mainWindow: BrowserWindow | null = null;

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public async handleMenuAvailabilitySync(data: any): Promise<void> {
        // Update local menu availability
        this.notifyRenderer('menu:availability-update', data);
    }

    public async handleInventoryUpdateSync(data: any): Promise<void> {
        // Update local inventory
        this.notifyRenderer('inventory:update', data);
    }

    private notifyRenderer(channel: string, data: any) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
}
