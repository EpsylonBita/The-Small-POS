/**
 * Printer Transport Input Validation
 *
 * SECURITY: Validates port and printer names to prevent command injection attacks.
 * These validations must be applied before any shell command execution.
 *
 * @module printer/transport/validation
 */

/**
 * Valid COM port pattern (e.g., COM1, COM10, COM255)
 * Only allows alphanumeric COM port names in standard Windows format
 */
const SAFE_PORT_PATTERN = /^COM[0-9]{1,3}$/i;

/**
 * Valid printer name pattern
 * Allows alphanumeric, spaces, hyphens, underscores, and periods
 * Maximum 128 characters
 */
const SAFE_PRINTER_NAME_PATTERN = /^[a-zA-Z0-9\s\-_.()]{1,128}$/;

/**
 * Characters that could be used for shell/PowerShell injection
 */
const DANGEROUS_CHARS_PATTERN = /[`$"';|&<>{}[\]\\\/\r\n]/;

/**
 * Validate a COM port name
 *
 * @param portName - The port name to validate
 * @returns true if the port name is valid and safe
 * @throws Error if the port name is invalid or potentially malicious
 */
export function validatePortName(portName: string): boolean {
  if (!portName || typeof portName !== 'string') {
    throw new Error('Port name is required');
  }

  const trimmed = portName.trim();

  if (!SAFE_PORT_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid port name "${trimmed}". Port name must be in format COM1-COM999 (e.g., COM1, COM3, COM10)`
    );
  }

  return true;
}

/**
 * Validate a printer name
 *
 * @param printerName - The printer name to validate
 * @returns true if the printer name is valid and safe
 * @throws Error if the printer name is invalid or potentially malicious
 */
export function validatePrinterName(printerName: string): boolean {
  if (!printerName || typeof printerName !== 'string') {
    throw new Error('Printer name is required');
  }

  const trimmed = printerName.trim();

  if (trimmed.length === 0) {
    throw new Error('Printer name cannot be empty');
  }

  if (trimmed.length > 128) {
    throw new Error('Printer name is too long (maximum 128 characters)');
  }

  // Check for dangerous characters that could enable injection
  if (DANGEROUS_CHARS_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid printer name "${trimmed}". Printer name contains potentially dangerous characters`
    );
  }

  if (!SAFE_PRINTER_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid printer name "${trimmed}". Only alphanumeric characters, spaces, hyphens, underscores, periods, and parentheses are allowed`
    );
  }

  return true;
}

/**
 * Sanitize a string for safe use in PowerShell single-quoted strings
 * This escapes single quotes by doubling them
 *
 * @param input - The string to sanitize
 * @returns The sanitized string safe for single-quoted PowerShell context
 */
export function sanitizeForPowerShellSingleQuote(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  // In PowerShell single-quoted strings, only single quotes need escaping (doubled)
  return input.replace(/'/g, "''");
}

/**
 * Sanitize a string for safe use in PowerShell double-quoted strings
 * This escapes backticks, dollar signs, and double quotes
 *
 * @param input - The string to sanitize
 * @returns The sanitized string safe for double-quoted PowerShell context
 */
export function sanitizeForPowerShellDoubleQuote(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  // Escape backticks first (as they're the escape character)
  // Then escape dollar signs (variable expansion)
  // Then escape double quotes
  return input
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"');
}

/**
 * Validate and return a safe baud rate
 *
 * @param baudRate - The baud rate to validate
 * @returns The validated baud rate
 * @throws Error if the baud rate is invalid
 */
export function validateBaudRate(baudRate: number): number {
  const validBaudRates = [110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 128000, 256000];

  if (!Number.isInteger(baudRate) || !validBaudRates.includes(baudRate)) {
    throw new Error(
      `Invalid baud rate ${baudRate}. Valid rates are: ${validBaudRates.join(', ')}`
    );
  }

  return baudRate;
}

/**
 * Validate data bits
 *
 * @param dataBits - The data bits value to validate
 * @returns The validated data bits
 * @throws Error if the value is invalid
 */
export function validateDataBits(dataBits: number): number {
  const validDataBits = [5, 6, 7, 8];

  if (!Number.isInteger(dataBits) || !validDataBits.includes(dataBits)) {
    throw new Error(
      `Invalid data bits ${dataBits}. Valid values are: ${validDataBits.join(', ')}`
    );
  }

  return dataBits;
}

/**
 * Validate stop bits
 *
 * @param stopBits - The stop bits value to validate
 * @returns The validated stop bits
 * @throws Error if the value is invalid
 */
export function validateStopBits(stopBits: number): number {
  const validStopBits = [1, 1.5, 2];

  if (!validStopBits.includes(stopBits)) {
    throw new Error(
      `Invalid stop bits ${stopBits}. Valid values are: ${validStopBits.join(', ')}`
    );
  }

  return stopBits;
}

/**
 * Validate parity setting
 *
 * @param parity - The parity setting to validate
 * @returns The validated parity
 * @throws Error if the value is invalid
 */
export function validateParity(parity: string): string {
  const validParity = ['none', 'odd', 'even', 'mark', 'space'];
  const normalized = parity.toLowerCase();

  if (!validParity.includes(normalized)) {
    throw new Error(
      `Invalid parity "${parity}". Valid values are: ${validParity.join(', ')}`
    );
  }

  return normalized;
}
