/**
 * Error Handler Utilities (POS-local stub)
 */

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ErrorType = 'network' | 'validation' | 'database' | 'auth' | 'unknown' | 'system' | 'business';

// Export as values for runtime use
export const ErrorSeverity = {
  LOW: 'low' as ErrorSeverity,
  MEDIUM: 'medium' as ErrorSeverity,
  HIGH: 'high' as ErrorSeverity,
  CRITICAL: 'critical' as ErrorSeverity,
};

export const ErrorType = {
  NETWORK: 'network' as ErrorType,
  VALIDATION: 'validation' as ErrorType,
  DATABASE: 'database' as ErrorType,
  AUTH: 'auth' as ErrorType,
  UNKNOWN: 'unknown' as ErrorType,
  SYSTEM: 'system' as ErrorType,
  BUSINESS: 'business' as ErrorType,
};

export interface POSError extends Error {
  code?: string;
  severity?: ErrorSeverity;
  type?: ErrorType;
  context?: string | Record<string, any>;
  retryable?: boolean;
  originalError?: Error;
  errors?: any[];
  dbPath?: string;
  timestamp?: string;
  details?: any;
  componentStack?: string;
  stack?: string;
  [key: string]: any;
}

export class ErrorFactory {
  static create(message: string, options?: Partial<POSError>): POSError {
    const error = new Error(message) as POSError;
    Object.assign(error, options);
    return error;
  }

  static network(message: string, originalError?: Error): POSError {
    return this.create(message, {
      type: 'network',
      severity: 'medium',
      retryable: true,
      originalError,
    });
  }

  static validation(message: string): POSError {
    return this.create(message, {
      type: 'validation',
      severity: 'low',
      retryable: false,
    });
  }

  static database(message: string, details?: any): POSError {
    const error = this.create(message, {
      type: 'database',
      severity: 'high',
      retryable: true,
    });
    if (details) {
      Object.assign(error, details);
    }
    return error;
  }

  static databaseInit(message: string, details?: any): POSError {
    const error = this.create(message, {
      type: 'database',
      severity: 'critical',
      retryable: false,
    });
    if (details) {
      Object.assign(error, details);
    }
    return error;
  }

  static system(message: string, details?: any): POSError {
    const options: Partial<POSError> = {
      type: 'system',
      severity: 'high',
      retryable: false,
    };
    // Support both Error object and details object
    if (details instanceof Error) {
      options.originalError = details;
      options.stack = details.stack;
    } else if (details) {
      options.details = details;
      if (details.componentStack) options.componentStack = details.componentStack;
      if (details.stack) options.stack = details.stack;
      if (details.name) options.name = details.name;
    }
    return this.create(message, options);
  }

  static businessLogic(message: string, details?: any): POSError {
    return this.create(message, {
      type: 'business',
      severity: 'medium',
      retryable: false,
      details,
    });
  }

  static authentication(message: string): POSError {
    return this.create(message, {
      type: 'auth',
      severity: 'high',
      retryable: false,
    });
  }
}

export class ErrorHandler {
  private static instance: ErrorHandler;

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  handleError(error: any, context?: string): void {
    console.error(`[ErrorHandler${context ? ` - ${context}` : ''}]`, error?.message || error);
  }

  handle(error: any, context?: string): POSError {
    this.handleError(error, context);
    // If already a POSError, return as-is
    if (error && typeof error === 'object' && 'type' in error) {
      return error as POSError;
    }
    // Convert to POSError
    const posError = new Error(error?.message || String(error)) as POSError;
    posError.code = error?.code;
    posError.type = error?.type || 'unknown';
    posError.severity = error?.severity || 'medium';
    posError.timestamp = new Date().toISOString();
    posError.context = context;
    return posError;
  }

  getUserMessage(error: any): string {
    return error?.message || 'An unexpected error occurred';
  }

  async handleApiError(error: any, context?: string): Promise<void> {
    this.handleError(error, context);
  }
}

/**
 * Wrap a promise with a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  throw lastError;
}

export const errorHandler = ErrorHandler.getInstance();
