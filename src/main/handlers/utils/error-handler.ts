/**
 * Standardized Error Handling Utility for IPC Handlers
 *
 * Provides consistent error handling and response formatting across all IPC handlers.
 */

export interface IPCResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/**
 * Error codes for common IPC handler errors
 */
export const ErrorCodes = {
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  CONFLICT: 'CONFLICT',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Custom error class for IPC handlers with error code support
 */
export class IPCError extends Error {
  code: ErrorCode;

  constructor(message: string, code: ErrorCode = ErrorCodes.UNKNOWN_ERROR) {
    super(message);
    this.name = 'IPCError';
    this.code = code;
  }
}

/**
 * Wraps an async handler function with standardized error handling.
 * Returns a consistent IPCResponse format for both success and error cases.
 *
 * @param handler - The async function to execute
 * @param context - A descriptive context string for logging (e.g., "order:create")
 * @returns Promise<IPCResponse<T>> - Standardized response object
 *
 * @example
 * ```typescript
 * ipcMain.handle('order:create', async (_event, data) => {
 *   return handleIPCError(async () => {
 *     const order = await orderService.create(data);
 *     return order;
 *   }, 'order:create');
 * });
 * ```
 */
export async function handleIPCError<T>(
  handler: () => Promise<T>,
  context: string
): Promise<IPCResponse<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    console.error(`[${context}] Error:`, error);

    if (error instanceof IPCError) {
      return {
        success: false,
        error: error.message,
        code: error.code,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : ErrorCodes.UNKNOWN_ERROR,
    };
  }
}

/**
 * Synchronous version of handleIPCError for handlers that don't need async.
 *
 * @param handler - The function to execute
 * @param context - A descriptive context string for logging
 * @returns IPCResponse<T> - Standardized response object
 */
export function handleIPCErrorSync<T>(
  handler: () => T,
  context: string
): IPCResponse<T> {
  try {
    const data = handler();
    return { success: true, data };
  } catch (error) {
    console.error(`[${context}] Error:`, error);

    if (error instanceof IPCError) {
      return {
        success: false,
        error: error.message,
        code: error.code,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: error instanceof Error ? error.name : ErrorCodes.UNKNOWN_ERROR,
    };
  }
}

/**
 * Creates a success response with optional data
 */
export function successResponse<T>(data?: T): IPCResponse<T> {
  return { success: true, data };
}

/**
 * Creates an error response with message and optional code
 */
export function errorResponse(
  error: string,
  code: ErrorCode = ErrorCodes.UNKNOWN_ERROR
): IPCResponse<never> {
  return { success: false, error, code };
}

/**
 * Validates that a required service is available, throwing an error if not
 */
export function requireService<T>(service: T | null | undefined, serviceName: string): T {
  if (!service) {
    throw new IPCError(`Required service '${serviceName}' is not available`, ErrorCodes.SERVICE_UNAVAILABLE);
  }
  return service;
}

/**
 * Validates that a required parameter is provided
 */
export function requireParam<T>(param: T | null | undefined, paramName: string): T {
  if (param === null || param === undefined) {
    throw new IPCError(`Required parameter '${paramName}' is missing`, ErrorCodes.VALIDATION_ERROR);
  }
  return param;
}
