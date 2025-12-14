// Debug Logging Utility for POS System
// Centralized logging with environment-aware output

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  data?: any;
  timestamp: string;
  component?: string;
  userId?: string;
  orderId?: string;
}

class DebugLogger {
  private static instance: DebugLogger;
  private currentLevel: LogLevel = LogLevel.INFO;
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }

  constructor() {
    // Set log level based on environment
    this.setLogLevel(this.getEnvironmentLogLevel());
  }

  private getEnvironmentLogLevel(): LogLevel {
    const env = process.env.NODE_ENV;
    const debugMode = process.env.DEBUG_LOGGING === 'true';
    
    if (debugMode) return LogLevel.DEBUG;
    if (env === 'development') return LogLevel.DEBUG;
    if (env === 'test') return LogLevel.WARN;
    return LogLevel.ERROR; // Production
  }

  setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.currentLevel;
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    data?: any,
    component?: string,
    context?: { userId?: string; orderId?: string }
  ): LogEntry {
    return {
      level,
      message,
      data,
      timestamp: new Date().toISOString(),
      component,
      userId: context?.userId,
      orderId: context?.orderId,
    };
  }

  private addToLog(entry: LogEntry): void {
    this.logs.push(entry);
    
    // Keep only the most recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  private formatMessage(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    const component = entry.component ? `[${entry.component}]` : '';
    const context = entry.userId ? `[User:${entry.userId}]` : '';
    const order = entry.orderId ? `[Order:${entry.orderId}]` : '';
    
    return `${timestamp} ${component}${context}${order} ${entry.message}`;
  }

  debug(message: string, data?: any, component?: string, context?: { userId?: string; orderId?: string }): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;

    const entry = this.createLogEntry(LogLevel.DEBUG, message, data, component, context);
    this.addToLog(entry);
    
    console.debug(`🐛 ${this.formatMessage(entry)}`, data || '');
  }

  info(message: string, data?: any, component?: string, context?: { userId?: string; orderId?: string }): void {
    if (!this.shouldLog(LogLevel.INFO)) return;

    const entry = this.createLogEntry(LogLevel.INFO, message, data, component, context);
    this.addToLog(entry);
    
    console.info(`ℹ️ ${this.formatMessage(entry)}`, data || '');
  }

  warn(message: string, data?: any, component?: string, context?: { userId?: string; orderId?: string }): void {
    if (!this.shouldLog(LogLevel.WARN)) return;

    const entry = this.createLogEntry(LogLevel.WARN, message, data, component, context);
    this.addToLog(entry);
    
    console.warn(`⚠️ ${this.formatMessage(entry)}`, data || '');
  }

  error(message: string, data?: any, component?: string, context?: { userId?: string; orderId?: string }): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;

    const entry = this.createLogEntry(LogLevel.ERROR, message, data, component, context);
    this.addToLog(entry);
    
    console.error(`❌ ${this.formatMessage(entry)}`, data || '');
  }

  // Specialized logging methods for common POS operations
  orderOperation(operation: string, orderId: string, data?: any, userId?: string): void {
    this.info(`Order ${operation}`, data, 'OrderService', { userId, orderId });
  }

  paymentOperation(operation: string, orderId: string, data?: any, userId?: string): void {
    this.info(`Payment ${operation}`, data, 'PaymentService', { userId, orderId });
  }

  syncOperation(operation: string, data?: any): void {
    this.info(`Sync ${operation}`, data, 'SyncService');
  }

  authOperation(operation: string, userId?: string, data?: any): void {
    this.info(`Auth ${operation}`, data, 'AuthService', { userId });
  }

  databaseOperation(operation: string, table: string, data?: any): void {
    this.debug(`Database ${operation} on ${table}`, data, 'DatabaseService');
  }

  // Performance logging
  performance(operation: string, duration: number, component?: string): void {
    const message = `${operation} completed in ${duration}ms`;
    if (duration > 1000) {
      this.warn(`Slow operation: ${message}`, { duration }, component);
    } else {
      this.debug(message, { duration }, component);
    }
  }

  // Get logs for debugging
  getLogs(level?: LogLevel, component?: string, limit?: number): LogEntry[] {
    let filteredLogs = this.logs;

    if (level !== undefined) {
      filteredLogs = filteredLogs.filter(log => log.level >= level);
    }

    if (component) {
      filteredLogs = filteredLogs.filter(log => log.component === component);
    }

    if (limit) {
      filteredLogs = filteredLogs.slice(-limit);
    }

    return filteredLogs;
  }

  // Clear logs
  clearLogs(): void {
    this.logs = [];
  }

  // Export logs for debugging
  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}

// Create and export singleton instance
export const debugLogger = DebugLogger.getInstance();

// Convenience function to check if debug logging is enabled
export const shouldDebugLog = (): boolean => {
  return process.env.NODE_ENV === 'development' || process.env.DEBUG_LOGGING === 'true';
};

// Performance measurement utility
export const measurePerformance = async <T>(
  operation: string,
  fn: () => Promise<T>,
  component?: string
): Promise<T> => {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    debugLogger.performance(operation, duration, component);
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    debugLogger.error(`${operation} failed after ${duration}ms`, error, component);
    throw error;
  }
};

// Sync performance measurement
export const measureSync = <T>(
  operation: string,
  fn: () => T,
  component?: string
): T => {
  const start = performance.now();
  try {
    const result = fn();
    const duration = performance.now() - start;
    debugLogger.performance(operation, duration, component);
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    debugLogger.error(`${operation} failed after ${duration}ms`, error, component);
    throw error;
  }
};
