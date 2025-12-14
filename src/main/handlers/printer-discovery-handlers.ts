/**
 * Printer Discovery Handlers Module
 *
 * Handles printer discovery IPC operations including system printers,
 * network scanning, and Bluetooth scanning.
 *
 * Migrated from ipc-router.ts to domain-specific handler.
 */

import { ipcMain } from 'electron';
import * as os from 'os';
import * as net from 'net';
import { serviceRegistry } from '../service-registry';

/**
 * Get local subnet prefix for network scanning
 */
function getLocalSubnetPrefix(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || [];
    for (const addr of addrs) {
      const a = addr as any;
      if (a.family === 'IPv4' && !a.internal) {
        const parts = a.address.split('.');
        if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return null;
}

/**
 * Try to connect to a host:port with timeout
 */
function tryConnect(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // Ignore cleanup errors
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Register printer discovery IPC handlers
 */
export function registerPrinterDiscoveryHandlers(): void {
  // List system printers
  ipcMain.removeHandler('printer:list-system-printers');
  ipcMain.handle('printer:list-system-printers', async () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const printers = await (mainWindow.webContents as any).getPrintersAsync?.();
        return { success: true, printers: printers || [] };
      }
      return { success: true, printers: [] };
    } catch (error) {
      console.error('printer:list-system-printers failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Scan network for printers
  ipcMain.removeHandler('printer:scan-network');
  ipcMain.handle(
    'printer:scan-network',
    async (_event, opts: { port?: number; limit?: number } = {}) => {
      try {
        const port = opts.port ?? 9100;
        const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
        const prefix = getLocalSubnetPrefix();
        if (!prefix) return { success: true, devices: [] };
        const targets: string[] = [];
        for (let i = 1; i <= limit; i++) targets.push(`${prefix}.${i}`);
        const results: string[] = [];
        await Promise.all(
          targets.map(async (host) => {
            const ok = await tryConnect(host, port, 400);
            if (ok) results.push(host);
          })
        );
        return {
          success: true,
          devices: results.map((ip) => ({
            name: `Network Printer (${ip})`,
            address: ip,
            type: 'network',
            status: 'online',
          })),
        };
      } catch (error) {
        console.error('printer:scan-network failed:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Scan Bluetooth (Mock/Placeholder)
  ipcMain.removeHandler('printer:scan-bluetooth');
  ipcMain.handle('printer:scan-bluetooth', async () => {
    try {
      // In a real app, use navigator.bluetooth or noble in main process
      // For now, return empty or mock
      return { success: true, devices: [] };
    } catch (error) {
      console.error('printer:scan-bluetooth failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
