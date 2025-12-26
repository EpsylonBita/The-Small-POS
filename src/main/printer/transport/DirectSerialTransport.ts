/**
 * Direct Serial Transport Implementation
 *
 * Sends raw ESC/POS data directly to a COM port, bypassing the Windows print spooler.
 * This is useful for printers that don't properly handle code page switching through
 * the Windows spooler.
 *
 * @module printer/transport/DirectSerialTransport
 */

import {
  BasePrinterTransport,
  TransportOptions,
  TransportState,
  TransportError,
  TransportEvent,
} from './PrinterTransport';
import { PrinterErrorCode } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

/**
 * Direct serial transport options
 */
export interface DirectSerialTransportOptions extends TransportOptions {
  /** Baud rate (default: 9600) */
  baudRate?: number;
  /** Data bits (default: 8) */
  dataBits?: number;
  /** Stop bits (default: 1) */
  stopBits?: number;
  /** Parity (default: 'none') */
  parity?: 'none' | 'odd' | 'even';
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: DirectSerialTransportOptions = {
  connectionTimeout: 5000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  autoReconnect: false,
  reconnectTimeout: 30000,
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

/**
 * DirectSerialTransport - Sends raw data directly to COM port
 */
export class DirectSerialTransport extends BasePrinterTransport {
  private portName: string;
  private serialOptions: Required<DirectSerialTransportOptions>;
  private tempDir: string;
  private isAvailable: boolean = false;

  constructor(portName: string, options?: DirectSerialTransportOptions) {
    super(options);
    this.portName = portName;
    this.serialOptions = { 
      connectionTimeout: options?.connectionTimeout ?? 5000,
      maxRetries: options?.maxRetries ?? 3,
      retryBaseDelay: options?.retryBaseDelay ?? 1000,
      autoReconnect: options?.autoReconnect ?? false,
      reconnectTimeout: options?.reconnectTimeout ?? 30000,
      baudRate: options?.baudRate ?? 9600,
      dataBits: options?.dataBits ?? 8,
      stopBits: options?.stopBits ?? 1,
      parity: options?.parity ?? 'none',
    };
    this.tempDir = path.join(os.tmpdir(), 'pos-serial-' + Date.now());
  }

  /**
   * Get the port name
   */
  getPortName(): string {
    return this.portName;
  }

  /**
   * Initialize the serial port connection
   */
  protected async doConnect(): Promise<void> {
    try {
      // Configure the COM port using mode command
      const modeCmd = `mode ${this.portName} baud=${this.serialOptions.baudRate} parity=${this.serialOptions.parity?.[0] || 'n'} data=${this.serialOptions.dataBits} stop=${this.serialOptions.stopBits}`;
      
      console.log(`[DirectSerialTransport] Configuring port: ${modeCmd}`);
      await execAsync(modeCmd);

      // Create temp directory
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      this.isAvailable = true;
      console.log(`[DirectSerialTransport] Connected to ${this.portName}`);
    } catch (error: any) {
      console.error(`[DirectSerialTransport] Failed to connect:`, error);
      throw new Error(`Failed to initialize ${this.portName}: ${error.message}`);
    }
  }

  /**
   * Disconnect from the serial port
   */
  protected async doDisconnect(): Promise<void> {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.tempDir, file));
        }
        fs.rmdirSync(this.tempDir);
      }
    } catch (error) {
      console.warn('[DirectSerialTransport] Error cleaning up:', error);
    }
    this.isAvailable = false;
    console.log(`[DirectSerialTransport] Disconnected from ${this.portName}`);
  }

  /**
   * Send data directly to the COM port
   */
  protected async doSend(data: Buffer): Promise<void> {
    if (!this.isAvailable) {
      throw new Error('Serial port not initialized');
    }

    try {
      // Write data to temp file
      const tempFile = path.join(this.tempDir, `print-${Date.now()}.bin`);
      fs.writeFileSync(tempFile, data);

      console.log(`[DirectSerialTransport] Sending ${data.length} bytes to ${this.portName}`);

      // Use PowerShell to write directly to COM port
      const psScript = `
$port = [System.IO.Ports.SerialPort]::new('${this.portName}', ${this.serialOptions.baudRate})
$port.DataBits = ${this.serialOptions.dataBits}
$port.StopBits = [System.IO.Ports.StopBits]::One
$port.Parity = [System.IO.Ports.Parity]::None
$port.Handshake = [System.IO.Ports.Handshake]::None
$port.WriteTimeout = 5000

try {
    $port.Open()
    $bytes = [System.IO.File]::ReadAllBytes('${tempFile.replace(/\\/g, '\\\\')}')
    $port.Write($bytes, 0, $bytes.Length)
    $port.Close()
    Write-Host "Sent $($bytes.Length) bytes successfully"
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($port.IsOpen) { $port.Close() }
    $port.Dispose()
}
`;

      const psScriptFile = path.join(this.tempDir, `serial-${Date.now()}.ps1`);
      fs.writeFileSync(psScriptFile, psScript);

      const { stdout } = await execAsync(
        `powershell -ExecutionPolicy Bypass -File "${psScriptFile}"`,
        { timeout: 10000 }
      );

      console.log(`[DirectSerialTransport] ${stdout.trim()}`);

      // Cleanup
      setTimeout(() => {
        try {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          if (fs.existsSync(psScriptFile)) fs.unlinkSync(psScriptFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }, 2000);

    } catch (error: any) {
      console.error(`[DirectSerialTransport] Send failed:`, error);
      const transportError: TransportError = {
        code: PrinterErrorCode.UNKNOWN,
        message: `Failed to send to ${this.portName}: ${error.message}`,
        originalError: error,
        recoverable: true,
      };
      this.emit(TransportEvent.ERROR, transportError);
      throw error;
    }
  }

  isWritable(): boolean {
    return this.isAvailable && this.state === TransportState.CONNECTED;
  }

  destroy(): void {
    this.isAvailable = false;
    super.destroy();
  }
}

/**
 * Send raw bytes directly to a COM port (standalone function)
 * This can be used for quick testing without setting up a full transport
 */
export async function sendRawToComPort(
  portName: string,
  data: Buffer,
  baudRate: number = 9600
): Promise<{ success: boolean; error?: string }> {
  const tempDir = path.join(os.tmpdir(), 'pos-serial-test');
  
  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `test-${Date.now()}.bin`);
    fs.writeFileSync(tempFile, data);

    const psScript = `
$port = [System.IO.Ports.SerialPort]::new('${portName}', ${baudRate})
$port.DataBits = 8
$port.StopBits = [System.IO.Ports.StopBits]::One
$port.Parity = [System.IO.Ports.Parity]::None
$port.Handshake = [System.IO.Ports.Handshake]::None
$port.WriteTimeout = 5000

try {
    $port.Open()
    $bytes = [System.IO.File]::ReadAllBytes('${tempFile.replace(/\\/g, '\\\\')}')
    $port.Write($bytes, 0, $bytes.Length)
    $port.Close()
    Write-Host "SUCCESS"
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($port.IsOpen) { $port.Close() }
    $port.Dispose()
}
`;

    const psScriptFile = path.join(tempDir, `test-script-${Date.now()}.ps1`);
    fs.writeFileSync(psScriptFile, psScript);

    const { stdout } = await execAsync(
      `powershell -ExecutionPolicy Bypass -File "${psScriptFile}"`,
      { timeout: 10000 }
    );

    // Cleanup
    try {
      fs.unlinkSync(tempFile);
      fs.unlinkSync(psScriptFile);
    } catch (e) {
      // Ignore
    }

    return { success: stdout.includes('SUCCESS') };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
