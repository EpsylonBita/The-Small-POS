// Enhanced Error Handling Utilities for POS System
import { ERROR_MESSAGES } from '../constants';

// Error types for better categorization
export enum ErrorType {
  VALIDATION = 'VALIDATION',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  NETWORK = 'NETWORK',
  DATABASE = 'DATABASE',
  BUSINESS_LOGIC = 'BUSINESS_LOGIC',
  SYSTEM = 'SYSTEM',
  UNKNOWN = 'UNKNOWN',
}

// Error severity levels
export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// Enhanced error interface
export interface POSError {
  type: ErrorType;
  severity: ErrorSeverity;
  code: string;
  message: string;
  details?: any;
  timestamp: string;
  context?: {
    userId?: string;
    orderId?: string;
    action?: string;
    component?: string;
  };
  stack?: string;
}

// Error factory class
export class ErrorFactory {
  static create(
    type: ErrorType,
    severity: ErrorSeverity,
    code: string,
    message: string,
    details?: any,
    context?: POSError['context']
  ): POSError {
    return {
      type,
      severity,
      code,
      message,
      details,
      context,
      timestamp: new Date().toISOString(),
      stack: new Error().stack,
    };
  }

  static validation(message: string, details?: any): POSError {
    return this.create(
      ErrorType.VALIDATION,
      ErrorSeverity.MEDIUM,
      'VALIDATION_ERROR',
      message,
      details
    );
  }

  static authentication(message: string = ERROR_MESSAGES.INVALID_CREDENTIALS): POSError {
    return this.create(
      ErrorType.AUTHENTICATION,
      ErrorSeverity.HIGH,
      'AUTH_ERROR',
      message
    );
  }

  static network(message: string = ERROR_MESSAGES.NETWORK_ERROR): POSError {
    return this.create(
      ErrorType.NETWORK,
      ErrorSeverity.MEDIUM,
      'NETWORK_ERROR',
      message
    );
  }

  static database(message: string, details?: any): POSError {
    return this.create(
      ErrorType.DATABASE,
      ErrorSeverity.HIGH,
      'DATABASE_ERROR',
      message,
      details
    );
  }

  static businessLogic(message: string, details?: any): POSError {
    return this.create(
      ErrorType.BUSINESS_LOGIC,
      ErrorSeverity.MEDIUM,
      'BUSINESS_ERROR',
      message,
      details
    );
  }

  static system(message: string, details?: any): POSError {
    return this.create(
      ErrorType.SYSTEM,
      ErrorSeverity.CRITICAL,
      'SYSTEM_ERROR',
      message,
      details
    );
  }

  static timeout(operation: string, timeoutMs: number): POSError {
    return this.create(
      ErrorType.NETWORK,
      ErrorSeverity.MEDIUM,
      'TIMEOUT_ERROR',
      `${operation} timed out after ${timeoutMs}ms`,
      { operation, timeoutMs }
    );
  }

  static databaseInit(message: string, details?: any): POSError {
    return this.create(
      ErrorType.DATABASE,
      ErrorSeverity.CRITICAL,
      'DATABASE_INIT_ERROR',
      message,
      details
    );
  }

  static databaseQuery(query: string, details?: any): POSError {
    return this.create(
      ErrorType.DATABASE,
      ErrorSeverity.HIGH,
      'DATABASE_QUERY_ERROR',
      'Database query failed',
      { query, ...details }
    );
  }

  static serviceUnavailable(serviceName: string): POSError {
    return this.create(
      ErrorType.SYSTEM,
      ErrorSeverity.HIGH,
      'SERVICE_UNAVAILABLE',
      `${serviceName} is currently unavailable`,
      { serviceName }
    );
  }
}

// Error handler class
export class ErrorHandler {
  private static instance: ErrorHandler;
  private errorLog: POSError[] = [];

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  // Handle and log errors
  handle(error: POSError | Error | unknown): POSError {
    let posError: POSError;

    if (this.isPOSError(error)) {
      posError = error;
    } else if (error instanceof Error) {
      posError = this.convertError(error);
    } else {
      posError = ErrorFactory.create(
        ErrorType.UNKNOWN,
        ErrorSeverity.MEDIUM,
        'UNKNOWN_ERROR',
        ERROR_MESSAGES.UNKNOWN_ERROR,
        error
      );
    }

    this.logError(posError);
    return posError;
  }

  // Convert standard Error to POSError
  private convertError(error: Error): POSError {
    // Detect error type based on message or properties
    let type = ErrorType.UNKNOWN;
    let severity = ErrorSeverity.MEDIUM;

    // Check for timeout errors
    if (error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('timed out')) {
      type = ErrorType.NETWORK;
      severity = ErrorSeverity.MEDIUM;
    }
    // Check for network errors
    else if (error.message.includes('network') || error.message.includes('fetch')) {
      type = ErrorType.NETWORK;
    }
    // Check for authentication errors
    else if (error.message.includes('auth') || error.message.includes('unauthorized')) {
      type = ErrorType.AUTHENTICATION;
      severity = ErrorSeverity.HIGH;
    }
    // Check for validation errors
    else if (error.message.includes('validation') || error.message.includes('invalid')) {
      type = ErrorType.VALIDATION;
    }
    // Check for database errors (SQLite error codes)
    else if (error.message.includes('database') || error.message.includes('sql') ||
             error.message.includes('SQLITE_') || error.message.includes('constraint')) {
      type = ErrorType.DATABASE;
      severity = ErrorSeverity.HIGH;
    }
    // Check for Supabase errors
    else if (error.message.includes('supabase') || error.message.includes('postgrest')) {
      type = ErrorType.DATABASE;
      severity = ErrorSeverity.HIGH;
    }

    return ErrorFactory.create(
      type,
      severity,
      'CONVERTED_ERROR',
      error.message,
      { originalError: error.name },
      undefined
    );
  }

  // Check if error is POSError
  private isPOSError(error: any): error is POSError {
    return error && typeof error === 'object' && 'type' in error && 'severity' in error;
  }

  // Log error to console and storage
  private logError(error: POSError): void {
    // Add to in-memory log
    this.errorLog.push(error);

    // Keep only last 100 errors in memory
    if (this.errorLog.length > 100) {
      this.errorLog = this.errorLog.slice(-100);
    }

    // Log to console based on severity
    const logMessage = `[${error.type}] ${error.message}`;
    
    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        console.error('🚨 CRITICAL:', logMessage, error);
        break;
      case ErrorSeverity.HIGH:
        console.error('❌ ERROR:', logMessage, error);
        break;
      case ErrorSeverity.MEDIUM:
        console.warn('⚠️ WARNING:', logMessage, error);
        break;
      case ErrorSeverity.LOW:
        console.info('ℹ️ INFO:', logMessage, error);
        break;
    }

    // In production, you might want to send critical errors to a logging service
    if (error.severity === ErrorSeverity.CRITICAL) {
      this.reportCriticalError(error);
    }
  }

  // Report critical errors (placeholder for external logging service)
  private reportCriticalError(error: POSError): void {
    // TODO: Implement external error reporting
    // This could send errors to Sentry, LogRocket, or custom logging service
    console.error('Critical error reported:', error);
  }

  // Get recent errors for debugging
  getRecentErrors(count: number = 10): POSError[] {
    return this.errorLog.slice(-count);
  }

  // Clear error log
  clearErrors(): void {
    this.errorLog = [];
  }

  // Get user-friendly error message
  getUserMessage(error: POSError): string {
    // Check for timeout-specific messages
    if (error.code === 'TIMEOUT_ERROR') {
      return 'This operation is taking longer than expected. Please check your connection and try again.';
    }

    // Check for database-specific messages
    if (error.code === 'DATABASE_INIT_ERROR') {
      return 'Unable to access local database. Please restart the application.';
    }

    if (error.code === 'DATABASE_QUERY_ERROR') {
      return 'There was a problem accessing your data. Please try again.';
    }

    // Type-based messages with actionable steps
    switch (error.type) {
      case ErrorType.NETWORK:
        return 'Please check your internet connection and try again. If the problem persists, contact support.';
      case ErrorType.AUTHENTICATION:
        return 'Please log in again to continue.';
      case ErrorType.VALIDATION:
        return error.message; // Validation messages are usually user-friendly
      case ErrorType.DATABASE:
        return 'There was a problem saving your data. Please try again or contact support.';
      case ErrorType.BUSINESS_LOGIC:
        return error.message; // Business logic messages are usually user-friendly
      case ErrorType.SYSTEM:
        return 'A system error occurred. Please restart the application or contact support.';
      default:
        return 'Something went wrong. Please try again or contact support.';
    }
  }
}

// Utility functions for common error scenarios
export const handleAsyncError = async <T>(
  operation: () => Promise<T>,
  context?: POSError['context']
): Promise<{ data?: T; error?: POSError }> => {
  try {
    const data = await operation();
    return { data };
  } catch (error) {
    const posError = ErrorHandler.getInstance().handle(error);
    if (context) {
      posError.context = { ...posError.context, ...context };
    }
    return { error: posError };
  }
};

export const handleSyncError = (error: unknown, operation: string): POSError => {
  const posError = ErrorHandler.getInstance().handle(error);
  posError.context = { ...posError.context, action: operation };
  return posError;
};

export const handleValidationError = (field: string, message: string): POSError => {
  return ErrorFactory.validation(`${field}: ${message}`, { field });
};

// Timeout utility - wraps any promise with timeout handling
export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(ErrorFactory.timeout(operation, timeoutMs));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
};

// Retry utility - adds retry logic with exponential backoff
export const withRetry = async <T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> => {
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === maxAttempts) {
        break;
      }

      // Check if error is retryable
      const posError = ErrorHandler.getInstance().handle(error);
      if (!isRetryableError(posError)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      const delay = delayMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};

// Determine if an error should trigger retry
export const isRetryableError = (error: POSError): boolean => {
  // Retry network errors and timeouts
  if (error.type === ErrorType.NETWORK) {
    return true;
  }

  // Retry timeout errors
  if (error.code === 'TIMEOUT_ERROR') {
    return true;
  }

  // Retry certain database errors (connection issues, not constraint violations)
  if (error.type === ErrorType.DATABASE) {
    const message = error.message.toLowerCase();
    // Don't retry constraint violations or validation errors
    if (message.includes('constraint') || message.includes('unique') || message.includes('foreign key')) {
      return false;
    }
    // Retry connection issues
    if (message.includes('connection') || message.includes('timeout')) {
      return true;
    }
  }

  // Don't retry validation or authentication errors
  if (error.type === ErrorType.VALIDATION || error.type === ErrorType.AUTHENTICATION) {
    return false;
  }

  // Default: don't retry
  return false;
};

// Export singleton instance
export const errorHandler = ErrorHandler.getInstance();
