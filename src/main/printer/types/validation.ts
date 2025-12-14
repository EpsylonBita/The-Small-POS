/**
 * Printer Configuration Validation
 *
 * Functions for validating printer configurations, including IP addresses,
 * MAC addresses, port numbers, and other connection parameters.
 *
 * @module printer/types/validation
 */

import {
  PrinterConfig,
  ConnectionDetails,
  NetworkConnectionDetails,
  BluetoothConnectionDetails,
  USBConnectionDetails,
  isNetworkConnectionDetails,
  isBluetoothConnectionDetails,
  isUSBConnectionDetails,
} from './index';

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Create a successful validation result
 */
function validResult(): ValidationResult {
  return { valid: true, errors: [] };
}

/**
 * Create a failed validation result with errors
 */
function invalidResult(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

// ============================================================================
// IP Address Validation
// ============================================================================

/**
 * Regular expression for validating IPv4 addresses
 */
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

/**
 * Validate an IPv4 address string
 *
 * @param ip - The IP address string to validate
 * @returns true if the IP address is valid, false otherwise
 */
export function isValidIPv4(ip: string): boolean {
  if (!ip || typeof ip !== 'string') {
    return false;
  }

  // Check format with regex
  if (!IPV4_REGEX.test(ip)) {
    return false;
  }

  // Parse and validate each octet
  const octets = ip.split('.').map(Number);

  // Must have exactly 4 octets
  if (octets.length !== 4) {
    return false;
  }

  // Each octet must be a valid number between 0 and 255
  for (const octet of octets) {
    if (isNaN(octet) || octet < 0 || octet > 255) {
      return false;
    }
  }

  return true;
}

/**
 * Validate an IP address for network printer configuration
 * Rejects reserved addresses like 0.0.0.0 and 255.255.255.255
 *
 * @param ip - The IP address string to validate
 * @returns ValidationResult with any errors
 */
export function validateNetworkIP(ip: string): ValidationResult {
  const errors: string[] = [];

  if (!ip || typeof ip !== 'string') {
    return invalidResult(['IP address is required']);
  }

  if (!isValidIPv4(ip)) {
    return invalidResult(['Invalid IPv4 address format']);
  }

  // Check for reserved addresses
  if (ip === '0.0.0.0') {
    errors.push('IP address 0.0.0.0 is not allowed');
  }

  if (ip === '255.255.255.255') {
    errors.push('Broadcast address 255.255.255.255 is not allowed');
  }

  // Check for loopback (127.x.x.x) - may be valid for testing
  // We allow it but could add a warning

  return errors.length > 0 ? invalidResult(errors) : validResult();
}

// ============================================================================
// Port Validation
// ============================================================================

/**
 * Validate a port number
 *
 * @param port - The port number to validate
 * @returns true if the port is valid (1-65535), false otherwise
 */
export function isValidPort(port: number): boolean {
  if (typeof port !== 'number' || isNaN(port)) {
    return false;
  }

  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Validate a port number for network printer configuration
 *
 * @param port - The port number to validate
 * @returns ValidationResult with any errors
 */
export function validatePort(port: number): ValidationResult {
  if (typeof port !== 'number' || isNaN(port)) {
    return invalidResult(['Port must be a number']);
  }

  if (!Number.isInteger(port)) {
    return invalidResult(['Port must be an integer']);
  }

  if (port < 1 || port > 65535) {
    return invalidResult(['Port must be between 1 and 65535']);
  }

  return validResult();
}

// ============================================================================
// MAC Address Validation
// ============================================================================

/**
 * Regular expression for validating MAC addresses
 * Supports formats: XX:XX:XX:XX:XX:XX, XX-XX-XX-XX-XX-XX, XXXXXXXXXXXX
 */
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^([0-9A-Fa-f]{12})$/;

/**
 * Validate a MAC address string
 *
 * @param mac - The MAC address string to validate
 * @returns true if the MAC address is valid, false otherwise
 */
export function isValidMACAddress(mac: string): boolean {
  if (!mac || typeof mac !== 'string') {
    return false;
  }

  return MAC_REGEX.test(mac);
}

/**
 * Normalize a MAC address to uppercase colon-separated format
 *
 * @param mac - The MAC address to normalize
 * @returns Normalized MAC address (XX:XX:XX:XX:XX:XX) or null if invalid
 */
export function normalizeMACAddress(mac: string): string | null {
  if (!isValidMACAddress(mac)) {
    return null;
  }

  // Remove separators and convert to uppercase
  const cleaned = mac.replace(/[:-]/g, '').toUpperCase();

  // Insert colons
  const parts: string[] = [];
  for (let i = 0; i < 12; i += 2) {
    parts.push(cleaned.substring(i, i + 2));
  }

  return parts.join(':');
}

/**
 * Validate a MAC address for Bluetooth printer configuration
 *
 * @param mac - The MAC address string to validate
 * @returns ValidationResult with any errors
 */
export function validateMACAddress(mac: string): ValidationResult {
  if (!mac || typeof mac !== 'string') {
    return invalidResult(['MAC address is required']);
  }

  if (!isValidMACAddress(mac)) {
    return invalidResult(['Invalid MAC address format. Expected format: XX:XX:XX:XX:XX:XX']);
  }

  return validResult();
}

// ============================================================================
// RFCOMM Channel Validation
// ============================================================================

/**
 * Validate an RFCOMM channel number
 *
 * @param channel - The channel number to validate
 * @returns true if the channel is valid (1-30), false otherwise
 */
export function isValidRFCOMMChannel(channel: number): boolean {
  if (typeof channel !== 'number' || isNaN(channel)) {
    return false;
  }

  return Number.isInteger(channel) && channel >= 1 && channel <= 30;
}

/**
 * Validate an RFCOMM channel for Bluetooth printer configuration
 *
 * @param channel - The channel number to validate
 * @returns ValidationResult with any errors
 */
export function validateRFCOMMChannel(channel: number): ValidationResult {
  if (typeof channel !== 'number' || isNaN(channel)) {
    return invalidResult(['RFCOMM channel must be a number']);
  }

  if (!Number.isInteger(channel)) {
    return invalidResult(['RFCOMM channel must be an integer']);
  }

  if (channel < 1 || channel > 30) {
    return invalidResult(['RFCOMM channel must be between 1 and 30']);
  }

  return validResult();
}

// ============================================================================
// USB ID Validation
// ============================================================================

/**
 * Validate a USB vendor or product ID
 *
 * @param id - The USB ID to validate
 * @returns true if the ID is valid (0-65535), false otherwise
 */
export function isValidUSBId(id: number): boolean {
  if (typeof id !== 'number' || isNaN(id)) {
    return false;
  }

  return Number.isInteger(id) && id >= 0 && id <= 65535;
}

/**
 * Validate USB vendor and product IDs
 *
 * @param vendorId - The vendor ID to validate
 * @param productId - The product ID to validate
 * @returns ValidationResult with any errors
 */
export function validateUSBIds(vendorId: number, productId: number): ValidationResult {
  const errors: string[] = [];

  if (!isValidUSBId(vendorId)) {
    errors.push('Vendor ID must be an integer between 0 and 65535');
  }

  if (!isValidUSBId(productId)) {
    errors.push('Product ID must be an integer between 0 and 65535');
  }

  return errors.length > 0 ? invalidResult(errors) : validResult();
}

// ============================================================================
// Connection Details Validation
// ============================================================================

/**
 * Validate network connection details
 */
export function validateNetworkConnectionDetails(
  details: NetworkConnectionDetails
): ValidationResult {
  const errors: string[] = [];

  // Validate IP
  const ipResult = validateNetworkIP(details.ip);
  if (!ipResult.valid) {
    errors.push(...ipResult.errors);
  }

  // Validate port
  const portResult = validatePort(details.port);
  if (!portResult.valid) {
    errors.push(...portResult.errors);
  }

  return errors.length > 0 ? invalidResult(errors) : validResult();
}

/**
 * Validate Bluetooth connection details
 */
export function validateBluetoothConnectionDetails(
  details: BluetoothConnectionDetails
): ValidationResult {
  const errors: string[] = [];

  // Validate MAC address
  const macResult = validateMACAddress(details.address);
  if (!macResult.valid) {
    errors.push(...macResult.errors);
  }

  // Validate RFCOMM channel
  const channelResult = validateRFCOMMChannel(details.channel);
  if (!channelResult.valid) {
    errors.push(...channelResult.errors);
  }

  return errors.length > 0 ? invalidResult(errors) : validResult();
}

/**
 * Validate USB connection details
 */
export function validateUSBConnectionDetails(
  details: USBConnectionDetails
): ValidationResult {
  return validateUSBIds(details.vendorId, details.productId);
}

/**
 * Validate any connection details based on type
 */
export function validateConnectionDetails(
  details: ConnectionDetails
): ValidationResult {
  if (isNetworkConnectionDetails(details)) {
    return validateNetworkConnectionDetails(details);
  }

  if (isBluetoothConnectionDetails(details)) {
    return validateBluetoothConnectionDetails(details);
  }

  if (isUSBConnectionDetails(details)) {
    return validateUSBConnectionDetails(details);
  }

  return invalidResult(['Unknown connection type']);
}

// ============================================================================
// Full Printer Configuration Validation
// ============================================================================

/**
 * Validate a complete printer configuration
 *
 * @param config - The printer configuration to validate
 * @returns ValidationResult with any errors
 */
export function validatePrinterConfig(config: PrinterConfig): ValidationResult {
  const errors: string[] = [];

  // Validate required string fields
  if (!config.id || typeof config.id !== 'string') {
    errors.push('Printer ID is required');
  }

  if (!config.name || typeof config.name !== 'string') {
    errors.push('Printer name is required');
  }

  if (config.name && config.name.length > 100) {
    errors.push('Printer name must be 100 characters or less');
  }

  // Validate connection details
  const connectionResult = validateConnectionDetails(config.connectionDetails);
  if (!connectionResult.valid) {
    errors.push(...connectionResult.errors);
  }

  // Validate fallback printer ID if provided
  if (config.fallbackPrinterId !== undefined && config.fallbackPrinterId !== null) {
    if (typeof config.fallbackPrinterId !== 'string') {
      errors.push('Fallback printer ID must be a string');
    }
    if (config.fallbackPrinterId === config.id) {
      errors.push('Fallback printer cannot be the same as the printer itself');
    }
  }

  return errors.length > 0 ? invalidResult(errors) : validResult();
}
