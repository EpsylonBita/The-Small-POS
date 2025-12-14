/**
 * ErrorHandlingService (POS-local stub)
 */

export interface ErrorDetails {
  message: string;
  code?: string;
  context?: string;
  timestamp: string;
  stack?: string;
  retryable?: boolean;
  [key: string]: any;
}

export interface ErrorHandlerOptions {
  silent?: boolean;
  retry?: boolean;
  fallback?: any;
  showToast?: boolean;
  maxRetries?: number;
  retryCallback?: () => void;
  [key: string]: any;
}

class ErrorHandlerService {
  async handleError(error: any, context: string, options?: ErrorHandlerOptions): Promise<ErrorDetails> {
    const details: ErrorDetails = {
      message: error?.message || String(error),
      code: error?.code,
      context,
      timestamp: new Date().toISOString(),
      stack: error?.stack,
      retryable: false,
    };
    
    if (!options?.silent) {
      console.error(`[${context}]`, details.message);
    }
    
    return details;
  }

  async handleApiError(error: any, context: string, options?: ErrorHandlerOptions): Promise<ErrorDetails> {
    return this.handleError(error, context, options);
  }
}

export const errorHandler = new ErrorHandlerService();
