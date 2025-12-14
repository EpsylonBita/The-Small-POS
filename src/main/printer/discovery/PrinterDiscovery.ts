/**
 * Printer Discovery Base Interface
 * 
 * Defines the common interface for all printer discovery services.
 * 
 * @module printer/discovery
 */

import { DiscoveredPrinter } from '../types';

/**
 * Callback type for when a printer is discovered
 */
export type PrinterFoundCallback = (printer: DiscoveredPrinter) => void;

/**
 * Base interface for all printer discovery services
 */
export interface PrinterDiscovery {
  /**
   * Start discovering printers
   * @param timeout - Discovery timeout in milliseconds (default: 10000)
   * @returns Promise resolving to array of discovered printers
   */
  discover(timeout?: number): Promise<DiscoveredPrinter[]>;

  /**
   * Stop any ongoing discovery process
   */
  stopDiscovery(): void;

  /**
   * Register a callback for when a printer is found during discovery
   * @param callback - Function to call when a printer is discovered
   */
  onPrinterFound(callback: PrinterFoundCallback): void;

  /**
   * Check if discovery is currently in progress
   */
  isDiscovering(): boolean;
}

/**
 * Format a discovered printer for display
 * Ensures all discovered printers have consistent formatting with name, type, and address
 * 
 * @param printer - The discovered printer to format
 * @returns Formatted display string
 */
export function formatDiscoveredPrinter(printer: DiscoveredPrinter): string {
  const parts: string[] = [];
  
  // Always include name
  parts.push(printer.name);
  
  // Always include connection type
  parts.push(`[${printer.type.toUpperCase()}]`);
  
  // Always include address
  if (printer.port) {
    parts.push(`${printer.address}:${printer.port}`);
  } else {
    parts.push(printer.address);
  }
  
  // Optionally include model/manufacturer
  if (printer.model) {
    parts.push(`(${printer.model})`);
  } else if (printer.manufacturer) {
    parts.push(`(${printer.manufacturer})`);
  }
  
  return parts.join(' ');
}
