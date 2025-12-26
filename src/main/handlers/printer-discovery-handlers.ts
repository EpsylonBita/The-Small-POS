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

  // Scan Bluetooth - detects paired Windows Bluetooth devices
  ipcMain.removeHandler('printer:scan-bluetooth');
  ipcMain.handle('printer:scan-bluetooth', async () => {
    try {
      console.log('[Bluetooth] Scanning for paired Bluetooth devices...');

      // On Windows, use PowerShell to list paired Bluetooth devices
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');

        try {
          // Get paired Bluetooth devices
          const output = execSync(
            'powershell -Command "Get-PnpDevice -Class Bluetooth | Where-Object { $_.Status -eq \'OK\' -and $_.FriendlyName -notlike \'*Adapter*\' -and $_.FriendlyName -notlike \'*Enumerator*\' -and $_.FriendlyName -notlike \'*Protocol*\' -and $_.FriendlyName -notlike \'*Transport*\' } | Select-Object FriendlyName, InstanceId | ConvertTo-Json"',
            { encoding: 'utf8', timeout: 10000 }
          ).toString();

          console.log('[Bluetooth] PowerShell output:', output);

          if (!output || output.trim() === '') {
            return { success: true, devices: [] };
          }

          let devices;
          try {
            const parsed = JSON.parse(output);
            devices = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return { success: true, devices: [] };
          }

          // Extract MAC addresses from InstanceId and filter for printer-like devices
          const printers = devices
            .filter((dev: any) => {
              const name = dev.FriendlyName || '';
              return /printer|thermal|receipt|pos|epson|star|bixolon|citizen|zebra|brother/i.test(name);
            })
            .map((dev: any) => {
              // Extract MAC address from InstanceId (format: BTHENUM\DEV_AABBCCDDEEFF\...)
              const instanceId = dev.InstanceId || '';
              const macMatch = instanceId.match(/DEV_([0-9A-F]{12})/i);
              let macAddress = '';

              if (macMatch) {
                const mac = macMatch[1];
                // Convert AABBCCDDEEFF to AA:BB:CC:DD:EE:FF
                macAddress = mac.match(/.{2}/g)?.join(':') || '';
              }

              return {
                name: dev.FriendlyName || 'Unknown Bluetooth Device',
                address: macAddress,
                type: 'bluetooth',
                status: 'paired',
                isPaired: true,
              };
            })
            .filter((dev: any) => dev.address); // Only include devices with valid MAC

          console.log('[Bluetooth] Found', printers.length, 'paired Bluetooth printers');
          return { success: true, devices: printers };

        } catch (execError: any) {
          console.error('[Bluetooth] PowerShell command failed:', execError.message);
          return { success: true, devices: [] };
        }
      }

      // On other platforms, return empty for now
      return { success: true, devices: [] };

    } catch (error) {
      console.error('printer:scan-bluetooth failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
