/**
 * IPC Handler Wrapper with Rate Limiting
 *
 * Provides a wrapper for ipcMain.handle that automatically applies rate limiting.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { rateLimiter } from './ipc-rate-limiter';

type IPCHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any;

/**
 * Wrap an IPC handler with rate limiting
 */
export function handleWithRateLimit(
  channel: string,
  handler: IPCHandler,
  options?: {
    cost?: number; // Token cost (default 1)
    skipRateLimit?: boolean; // Skip rate limiting for this channel
  }
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    // Skip rate limiting if explicitly disabled
    if (options?.skipRateLimit) {
      return handler(event, ...args);
    }

    // Check rate limit
    const cost = options?.cost || 1;
    const result = rateLimiter.check(channel, cost);

    if (!result.allowed) {
      console.warn(`[IPC] Rate limit exceeded for ${channel}, retry after ${result.retryAfter}ms`);
      throw new Error(`Rate limit exceeded. Please try again in ${Math.ceil((result.retryAfter || 0) / 1000)} seconds.`);
    }

    // Execute handler
    try {
      return await handler(event, ...args);
    } catch (error) {
      // Don't count failed requests against rate limit for critical errors
      // (but do count validation errors)
      throw error;
    }
  });
}

/**
 * Export original ipcMain.handle for handlers that don't need rate limiting
 * (like simple getters that don't touch database)
 */
export function handleWithoutRateLimit(channel: string, handler: IPCHandler): void {
  ipcMain.handle(channel, handler);
}
