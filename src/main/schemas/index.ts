/**
 * Zod Validation Schemas
 *
 * SECURITY: Input validation prevents:
 * - SQL injection attacks
 * - Type confusion exploits
 * - Buffer overflow attempts
 * - Data corruption from malformed inputs
 *
 * All IPC handlers should validate inputs using these schemas
 */

import { z } from 'zod';

// ==================================================================
// ORDER SCHEMAS
// ==================================================================

export const OrderItemSchema = z.object({
  id: z.string().uuid('Invalid item ID format'),
  name: z.string().min(1, 'Item name required').max(200, 'Item name too long'),
  quantity: z.number().int('Quantity must be integer').positive('Quantity must be positive').max(1000, 'Quantity too large'),
  price: z.number().positive('Price must be positive').max(100000, 'Price too large'),
  notes: z.string().max(500, 'Notes too long').optional(),
});

export const OrderCreateSchema = z.object({
  items: z.array(OrderItemSchema).min(1, 'At least one item required').max(100, 'Too many items'),
  customerId: z.string().uuid('Invalid customer ID').optional(),
  orderType: z.enum(['dine-in', 'takeaway', 'delivery'] as const),
  total: z.number().positive('Total must be positive').max(1000000, 'Total too large'),
  payment_method: z.enum(['cash', 'card', 'online'] as const),
  delivery_address: z.string().max(500, 'Address too long').optional(),
  customer_phone: z.string().max(20, 'Phone number too long').optional(),
  notes: z.string().max(1000, 'Notes too long').optional(),
});

export const OrderUpdateSchema = z.object({
  id: z.string().uuid('Invalid order ID'),
  status: z.enum(['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'] as const).optional(),
  items: z.array(OrderItemSchema).max(100, 'Too many items').optional(),
  payment_status: z.enum(['pending', 'paid', 'refunded'] as const).optional(),
});

// ==================================================================
// CUSTOMER SCHEMAS
// ==================================================================

export const CustomerAddressSchema = z.object({
  address_line1: z.string().min(1, 'Address required').max(200, 'Address too long'),
  address_line2: z.string().max(200, 'Address line 2 too long').optional(),
  city: z.string().max(100, 'City name too long').optional(),
  postal_code: z.string().max(20, 'Postal code too long').optional(),
  notes: z.string().max(500, 'Notes too long').optional(),
  is_default: z.boolean().default(false),
});

export const CustomerCreateSchema = z.object({
  name: z.string().min(1, 'Name required').max(200, 'Name too long'),
  phone: z.string().min(10, 'Valid phone required').max(20, 'Phone too long'),
  email: z.string().email('Invalid email').max(200, 'Email too long').optional(),
  addresses: z.array(CustomerAddressSchema).max(10, 'Too many addresses').optional(),
  notes: z.string().max(1000, 'Notes too long').optional(),
});

export const CustomerUpdateSchema = z.object({
  id: z.string().uuid('Invalid customer ID'),
  name: z.string().min(1, 'Name required').max(200, 'Name too long').optional(),
  email: z.string().email('Invalid email').max(200, 'Email too long').optional(),
  notes: z.string().max(1000, 'Notes too long').optional(),
  is_banned: z.boolean().optional(),
  current_version: z.number().int('Version must be integer').min(0, 'Invalid version'),
});

// ==================================================================
// PAYMENT SCHEMAS
// ==================================================================

export const PaymentSchema = z.object({
  orderId: z.string().uuid('Invalid order ID'),
  amount: z.number().positive('Amount must be positive').max(1000000, 'Amount too large'),
  payment_method: z.enum(['cash', 'card', 'online'] as const),
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded'] as const),
});

// ==================================================================
// SHIFT SCHEMAS
// ==================================================================

export const ShiftOpenSchema = z.object({
  staffId: z.string().uuid('Invalid staff ID'),
  openingCash: z.number().min(0, 'Opening cash cannot be negative').max(1000000, 'Opening cash too large'),
  branchId: z.string().uuid('Invalid branch ID'),
  terminalId: z.string().min(1, 'Terminal ID required').max(100, 'Terminal ID too long'),
  roleType: z.enum(['cashier', 'waiter', 'driver'] as const),
  startingAmount: z.number().min(0, 'Starting amount cannot be negative').max(1000000, 'Starting amount too large').optional(),
});

export const ShiftCloseSchema = z.object({
  shiftId: z.string().uuid('Invalid shift ID'),
  closingCash: z.number().min(0, 'Closing cash cannot be negative').max(1000000, 'Closing cash too large'),
  closedBy: z.string().uuid('Invalid staff ID'),
  paymentAmount: z.number().min(0, 'Payment cannot be negative').max(1000000, 'Payment too large').optional(),
});

export const ExpenseSchema = z.object({
  shiftId: z.string().uuid('Invalid shift ID'),
  amount: z.number().positive('Amount must be positive').max(1000000, 'Amount too large'),
  expenseType: z.string().min(1, 'Expense type required').max(100, 'Expense type too long'),
  description: z.string().max(500, 'Description too long').optional(),
  receiptNumber: z.string().max(100, 'Receipt number too long').optional(),
});

// ==================================================================
// SETTINGS SCHEMAS
// ==================================================================

export const SettingsUpdateSchema = z.object({
  category: z.string().min(1, 'Category required').max(50, 'Category too long'),
  key: z.string().min(1, 'Key required').max(100, 'Key too long'),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export const TerminalCredentialsSchema = z.object({
  branchId: z.string().uuid('Invalid branch ID'),
  terminalId: z.string().min(1, 'Terminal ID required').max(100, 'Terminal ID too long'),
  posApiKey: z.string().min(10, 'Invalid API key').max(500, 'API key too long'),
});

// ==================================================================
// AUTH SCHEMAS
// ==================================================================

export const AuthLoginSchema = z.object({
  pin: z.string().min(6, 'PIN must be at least 6 characters').max(20, 'PIN too long'),
  staffId: z.string().uuid('Invalid staff ID').optional(),
});

export const PinSetupSchema = z.object({
  pin: z.string().min(6, 'PIN must be at least 6 characters').max(20, 'PIN too long'),
  role: z.enum(['admin', 'staff'] as const),
});

// ==================================================================
// UTILITY FUNCTIONS
// ==================================================================

/**
 * Validate data against a schema and return typed result
 * Throws detailed error if validation fails
 */
export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Validation failed: ${messages}`);
    }
    throw error;
  }
}

/**
 * Validate data and return safe result (doesn't throw)
 */
export function safeValidate<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    const messages = result.error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return { success: false, error: `Validation failed: ${messages}` };
  }
}
