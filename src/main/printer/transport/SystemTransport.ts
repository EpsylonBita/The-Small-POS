/**
 * System Transport Implementation
 *
 * Handles printing through the Windows print spooler using system-installed printers.
 * This transport uses the Windows print spooler directly via command-line tools.
 *
 * @module printer/transport/SystemTransport
 *
 * Requirements: 2.2, 2.4
 */

import {
  BasePrinterTransport,
  TransportOptions,
  TransportState,
  TransportError,
  TransportEvent,
} from './PrinterTransport';
import { PrinterErrorCode, SystemConnectionDetails } from '../types';
import {
  validatePrinterName,
  sanitizeForPowerShellSingleQuote,
  sanitizeForPowerShellDoubleQuote,
} from './validation';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

/**
 * System-specific transport options
 */
export interface SystemTransportOptions extends TransportOptions {
  /** Print timeout in ms (default: 30000) */
  printTimeout?: number;
}

/**
 * Default system transport options
 */
const DEFAULT_SYSTEM_OPTIONS: SystemTransportOptions = {
  connectionTimeout: 5000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  autoReconnect: false, // System printers don't need reconnection
  reconnectTimeout: 30000,
  printTimeout: 30000,
};

/**
 * SystemTransport - Windows print spooler transport for system printers
 *
 * Requirements: 2.2, 2.4
 */
export class SystemTransport extends BasePrinterTransport {
  private systemName: string;
  private systemOptions: SystemTransportOptions;
  private tempDir: string;
  private isAvailable: boolean = false;

  /**
   * Create a new SystemTransport
   *
   * @param connectionDetails - System connection details (printer name)
   * @param options - Transport options
   */
  constructor(
    connectionDetails: SystemConnectionDetails,
    options?: SystemTransportOptions
  ) {
    super(options);

    // SECURITY: Validate printer name to prevent command injection
    validatePrinterName(connectionDetails.systemName);
    this.systemName = connectionDetails.systemName.trim();

    this.systemOptions = { ...DEFAULT_SYSTEM_OPTIONS, ...options };
    this.tempDir = path.join(os.tmpdir(), 'pos-printer-' + Date.now());
  }

  /**
   * Get the system printer name
   */
  getSystemName(): string {
    return this.systemName;
  }

  /**
   * Initialize the system printer connection
   * For system printers, "connecting" means verifying the printer exists
   *
   * Requirements: 2.2
   */
  protected async doConnect(): Promise<void> {
    try {
      // SECURITY: Printer name was validated in constructor
      // Use proper escaping for PowerShell single-quoted strings
      const safePrinterName = sanitizeForPowerShellSingleQuote(this.systemName);

      // Verify the printer exists by querying the Windows print spooler
      const { stdout } = await execAsync(
        `powershell -Command "Get-Printer -Name '${safePrinterName}'"`
      );

      if (!stdout || stdout.includes('cannot find')) {
        throw new Error(`Printer "${this.systemName}" not found in system`);
      }

      // Create temp directory for print jobs
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      this.isAvailable = true;
      console.log(`[SystemTransport] Connected to system printer: ${this.systemName}`);
    } catch (error: any) {
      console.error(`[SystemTransport] Failed to connect to system printer:`, error);
      throw new Error(`Failed to initialize system printer "${this.systemName}": ${error.message}`);
    }
  }

  /**
   * Disconnect from the system printer
   * For system printers, this just cleans up the temp directory
   *
   * Requirements: 2.2
   */
  protected async doDisconnect(): Promise<void> {
    try {
      // Clean up temp directory
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.tempDir, file));
        }
        fs.rmdirSync(this.tempDir);
      }
    } catch (error) {
      console.warn('[SystemTransport] Error cleaning up temp directory:', error);
    }
    this.isAvailable = false;
    console.log(`[SystemTransport] Disconnected from system printer: ${this.systemName}`);
  }

  /**
   * Send data to the system printer
   * This sends raw ESC/POS data through the Windows print spooler
   *
   * Requirements: 2.4
   */
  protected async doSend(data: Buffer): Promise<void> {
    if (!this.isAvailable) {
      throw new Error('System printer not initialized');
    }

    try {
      // Write raw data to a temporary file
      const tempFile = path.join(this.tempDir, `print-${Date.now()}.prn`);
      fs.writeFileSync(tempFile, data);

      console.log(`[SystemTransport] Wrote ${data.length} bytes to temp file: ${tempFile}`);

      // SECURITY: Printer name was validated in constructor
      // Use proper escaping for PowerShell double-quoted strings
      const safePrinterName = sanitizeForPowerShellDoubleQuote(this.systemName);
      const safeFilePath = tempFile.replace(/\\/g, '\\\\').replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
      const psScriptFile = path.join(this.tempDir, `print-script-${Date.now()}.ps1`);

      const rawPrintScript = `
Add-Type -AssemblyName System.Drawing
$printerName = "${safePrinterName}"
$filePath = "${safeFilePath}"

# Read the raw data
$rawData = [System.IO.File]::ReadAllBytes($filePath)

# Use Win32 API to send raw data
$pinvokeCode = @"
using System;
using System.Runtime.InteropServices;

public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes) {
    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
    Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);

    IntPtr hPrinter;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "RAW Document";
    di.pDataType = "RAW";

    bool bSuccess = false;
    if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
      if (StartDocPrinter(hPrinter, 1, di)) {
        if (StartPagePrinter(hPrinter)) {
          int dwWritten;
          bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);
          EndPagePrinter(hPrinter);
        }
        EndDocPrinter(hPrinter);
      }
      ClosePrinter(hPrinter);
    }

    Marshal.FreeCoTaskMem(pUnmanagedBytes);
    return bSuccess;
  }
}
"@

Add-Type -TypeDefinition $pinvokeCode
$result = [RawPrinter]::SendBytesToPrinter($printerName, $rawData)
if ($result) {
  Write-Host "Print successful"
} else {
  Write-Error "Print failed"
  exit 1
}
`;

      fs.writeFileSync(psScriptFile, rawPrintScript);

      // Execute PowerShell script with timeout
      const { stdout: psOutput } = await execAsync(
        `powershell -ExecutionPolicy Bypass -File "${psScriptFile}"`,
        { timeout: this.systemOptions.printTimeout }
      );

      console.log(`[SystemTransport] PowerShell output: ${psOutput}`);
      console.log(`[SystemTransport] Sent ${data.length} bytes via RawPrn to ${this.systemName}`);

      // Clean up PS script
      setTimeout(() => {
        try {
          if (fs.existsSync(psScriptFile)) {
            fs.unlinkSync(psScriptFile);
          }
        } catch (err) {
          console.warn('[SystemTransport] Failed to delete PS script:', err);
        }
      }, 5000);

      // Clean up the temp file after a short delay
      setTimeout(() => {
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch (err) {
          console.warn('[SystemTransport] Failed to delete temp file:', err);
        }
      }, 5000);
    } catch (error: any) {
      console.error(`[SystemTransport] Failed to send data:`, error);

      const transportError: TransportError = {
        code: PrinterErrorCode.UNKNOWN,
        message: `Failed to print to "${this.systemName}": ${error.message}`,
        originalError: error,
        recoverable: true,
      };
      this.emit(TransportEvent.ERROR, transportError);
      throw error;
    }
  }

  /**
   * Check if the transport is ready to send
   */
  isWritable(): boolean {
    return this.isAvailable && this.state === TransportState.CONNECTED;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.isAvailable = false;
    super.destroy();
  }
}
