/**
 * Printer Types Module
 *
 * Contains all TypeScript interfaces, types, and enums for the printer system.
 * 
 * @module printer/types
 */

// Re-export serialization functions
export * from './serialization';

// Re-export validation functions
export * from './validation';

// ============================================================================
// Enums
// ============================================================================

/**
 * Types of printer connections supported by the system
 */
export enum PrinterType {
  NETWORK = 'network',
  BLUETOOTH = 'bluetooth',
  USB = 'usb',
  WIFI = 'wifi',
  SYSTEM = 'system',
}

/**
 * Roles that printers can be assigned to for job routing
 */
export enum PrinterRole {
  RECEIPT = 'receipt',
  KITCHEN = 'kitchen',
  BAR = 'bar',
  LABEL = 'label',
}

/**
 * Current operational state of a printer
 */
export enum PrinterState {
  ONLINE = 'online',
  OFFLINE = 'offline',
  ERROR = 'error',
  BUSY = 'busy',
}

/**
 * Error codes that can be reported by printers
 */
export enum PrinterErrorCode {
  PAPER_OUT = 'PAPER_OUT',
  COVER_OPEN = 'COVER_OPEN',
  PAPER_JAM = 'PAPER_JAM',
  CUTTER_ERROR = 'CUTTER_ERROR',
  OVERHEATED = 'OVERHEATED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Types of print jobs that can be submitted
 */
export enum PrintJobType {
  RECEIPT = 'receipt',
  KITCHEN_TICKET = 'kitchen_ticket',
  LABEL = 'label',
  REPORT = 'report',
  TEST = 'test',
}

/**
 * Status of a queued print job
 */
export enum QueuedJobStatus {
  PENDING = 'pending',
  PRINTING = 'printing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Supported paper sizes for thermal printers
 */
export enum PaperSize {
  MM_58 = '58mm',
  MM_80 = '80mm',
  MM_112 = '112mm',
}

/**
 * Greek text rendering mode for printers
 * - 'text': Use printer's built-in Greek fonts (faster, requires printer support)
 * - 'bitmap': Render Greek as images (slower, works on all printers)
 */
export type GreekRenderMode = 'text' | 'bitmap';

/**
 * Receipt template style
 * - 'classic': Simple text-based layout (left image)
 * - 'modern': Styled layout with pillow-shaped headers (right image)
 */
export type ReceiptTemplate = 'classic' | 'modern';

// ============================================================================
// Receipt Template Configuration
// ============================================================================

/**
 * Configuration for receipt templates
 * Used by all checkout and report templates for consistent formatting
 */
export interface ReceiptTemplateConfig {
  paperSize: PaperSize;
  language: 'en' | 'el';
  currency: string;
  terminalName?: string;
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  receiptTemplate?: ReceiptTemplate;
}

// ============================================================================
// Connection Details Types
// ============================================================================

/**
 * Connection details for network/WiFi printers
 */
export interface NetworkConnectionDetails {
  type: 'network' | 'wifi';
  ip: string;
  port: number; // default 9100
  hostname?: string; // for mDNS resolution
}

/**
 * Connection details for Bluetooth printers
 */
export interface BluetoothConnectionDetails {
  type: 'bluetooth';
  address: string; // MAC address
  channel: number; // RFCOMM channel
  deviceName?: string;
}

/**
 * Connection details for USB printers
 */
export interface USBConnectionDetails {
  type: 'usb';
  vendorId: number;
  productId: number;
  systemName?: string; // OS printer name for spooler
  path?: string; // Device path
}

/**
 * Connection details for System (Windows) printers
 * Uses the Windows print spooler for printing
 */
export interface SystemConnectionDetails {
  type: 'system';
  systemName: string; // Windows printer name as shown in Printers & Scanners
}

/**
 * Union type for all connection details
 */
export type ConnectionDetails =
  | NetworkConnectionDetails
  | BluetoothConnectionDetails
  | USBConnectionDetails
  | SystemConnectionDetails;

// ============================================================================
// Printer Configuration
// ============================================================================

/**
 * Complete printer configuration stored in the database
 */
export interface PrinterConfig {
  id: string; // UUID
  name: string; // User-friendly name
  type: PrinterType;
  connectionDetails: ConnectionDetails;
  paperSize: PaperSize;
  characterSet: string; // 'PC437_USA', 'CP66_GREEK', etc.
  greekRenderMode?: GreekRenderMode; // 'text' or 'bitmap' for Greek printing
  receiptTemplate?: ReceiptTemplate; // 'classic' or 'modern' receipt style
  role: PrinterRole;
  isDefault: boolean;
  fallbackPrinterId?: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Print Job Types
// ============================================================================

/**
 * Order item for receipt/kitchen ticket printing
 */
export interface PrintOrderItemModifier {
  name: string;
  price?: number;
  quantity?: number;
  isWithout?: boolean; // Flag for "without" - ingredient removed, show as "ΧΩΡΙΣ:" in receipt
  isLittle?: boolean; // Flag for "little" portion - show "(λίγο)" suffix in receipt
}

export interface PrintOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  modifiers?: string[] | PrintOrderItemModifier[]; // Support both formats
  specialInstructions?: string;
  category?: string; // For routing to category-specific printers
  categoryName?: string; // Display name of the category (e.g., "Crepes", "Waffles")
}

/**
 * Receipt data for customer receipts
 */
export interface ReceiptData {
  orderNumber: string;
  orderType: 'dine-in' | 'pickup' | 'delivery';
  timestamp: Date;
  items: PrintOrderItem[];
  subtotal: number;
  tax: number;
  tip?: number;
  deliveryFee?: number;
  discount?: number; // Discount amount applied to the order
  discountPercentage?: number; // Discount percentage (for display purposes)
  total: number;
  paymentMethod: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string; // Combined address (fallback)
  streetAddress?: string;   // Road name with number
  postalCode?: string;      // Postal code number
  city?: string;            // Name of the city
  floorNumber?: string;     // Number of the floor
  deliveryNotes?: string;
  ringerName?: string;
  tableName?: string;
  driverName?: string; // Assigned driver name for delivery orders
}

/**
 * Kitchen ticket data for kitchen printers
 */
export interface KitchenTicketData {
  orderNumber: string;
  orderType: 'dine-in' | 'pickup' | 'delivery';
  timestamp: Date;
  items: PrintOrderItem[];
  customerName?: string;
  tableName?: string;
  specialInstructions?: string;
  station: string; // e.g., 'Grill', 'Fryer', 'Prep'
}

/**
 * Label data for label printers
 */
export interface LabelData {
  text: string;
  barcode?: string;
  qrCode?: string;
}

/**
 * Raw ESC/POS data for direct printing
 */
export interface RawEscPosData {
  buffer: Buffer;
}

/**
 * Union type for all print job data types
 */
export type PrintJobData =
  | ReceiptData
  | KitchenTicketData
  | LabelData
  | RawEscPosData;

/**
 * Print job submitted to the system
 */
export interface PrintJob {
  id: string; // UUID
  type: PrintJobType;
  data: PrintJobData;
  priority: number; // Higher = more urgent
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Print job in the queue with additional tracking information
 */
export interface QueuedJob extends PrintJob {
  printerId: string;
  status: QueuedJobStatus;
  retryCount: number;
  lastError?: string;
  startedAt?: Date;
  completedAt?: Date;
}

// ============================================================================
// Printer Status
// ============================================================================

/**
 * Current status of a printer
 */
export interface PrinterStatus {
  printerId: string;
  state: PrinterState;
  errorCode?: PrinterErrorCode;
  errorMessage?: string;
  lastSeen: Date;
  queueLength: number;
}

// ============================================================================
// Discovery Types
// ============================================================================

/**
 * Printer discovered during scanning
 */
export interface DiscoveredPrinter {
  name: string;
  type: PrinterType;
  address: string; // IP, MAC, or device path
  port?: number;
  model?: string;
  manufacturer?: string;
  isConfigured: boolean; // Already in our config
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of a print job submission
 */
export interface PrintJobResult {
  success: boolean;
  jobId: string;
  printerId?: string;
  error?: string;
}

/**
 * Result of a test print operation
 */
export interface TestPrintResult {
  success: boolean;
  printerId: string;
  latencyMs?: number;
  error?: string;
}

/**
 * Diagnostic information for a printer
 */
export interface PrinterDiagnostics {
  printerId: string;
  connectionType: PrinterType;
  connectionLatencyMs?: number;
  signalStrength?: number; // For wireless/Bluetooth
  model?: string;
  firmwareVersion?: string;
  recentJobs: {
    total: number;
    successful: number;
    failed: number;
  };
}

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Status of a transport connection
 */
export interface TransportStatus {
  connected: boolean;
  lastConnected?: Date;
  lastError?: string;
}

/**
 * Callback type for status change events
 */
export type StatusChangeCallback = (
  printerId: string,
  status: PrinterStatus
) => void;

// ============================================================================
// Serialization Types (for database storage)
// ============================================================================

/**
 * Serialized printer configuration for database storage
 */
export interface SerializedPrinterConfig {
  id: string;
  name: string;
  type: string;
  connectionDetails: string; // JSON string
  paperSize: string;
  characterSet: string;
  greekRenderMode: string | null; // 'text' or 'bitmap'
  receiptTemplate: string | null; // 'classic' or 'modern'
  role: string;
  isDefault: number; // SQLite boolean
  fallbackPrinterId: string | null;
  enabled: number; // SQLite boolean
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

/**
 * Serialized queued job for database storage
 */
export interface SerializedQueuedJob {
  id: string;
  printerId: string;
  type: string;
  data: string; // JSON string
  priority: number;
  status: string;
  retryCount: number;
  lastError: string | null;
  createdAt: string; // ISO string
  startedAt: string | null; // ISO string
  completedAt: string | null; // ISO string
  metadata: string | null; // JSON string
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for NetworkConnectionDetails
 */
export function isNetworkConnectionDetails(
  details: ConnectionDetails
): details is NetworkConnectionDetails {
  return details.type === 'network' || details.type === 'wifi';
}

/**
 * Type guard for BluetoothConnectionDetails
 */
export function isBluetoothConnectionDetails(
  details: ConnectionDetails
): details is BluetoothConnectionDetails {
  return details.type === 'bluetooth';
}

/**
 * Type guard for USBConnectionDetails
 */
export function isUSBConnectionDetails(
  details: ConnectionDetails
): details is USBConnectionDetails {
  return details.type === 'usb';
}

/**
 * Type guard for SystemConnectionDetails
 */
export function isSystemConnectionDetails(
  details: ConnectionDetails
): details is SystemConnectionDetails {
  return details.type === 'system';
}

/**
 * Type guard for ReceiptData
 */
export function isReceiptData(data: PrintJobData): data is ReceiptData {
  return 'orderNumber' in data && 'subtotal' in data && 'total' in data;
}

/**
 * Type guard for KitchenTicketData
 */
export function isKitchenTicketData(data: PrintJobData): data is KitchenTicketData {
  return 'orderNumber' in data && 'station' in data && !('subtotal' in data);
}

/**
 * Type guard for LabelData
 */
export function isLabelData(data: PrintJobData): data is LabelData {
  return 'text' in data && !('orderNumber' in data);
}

/**
 * Type guard for RawEscPosData
 */
export function isRawEscPosData(data: PrintJobData): data is RawEscPosData {
  return 'buffer' in data && Buffer.isBuffer((data as RawEscPosData).buffer);
}
