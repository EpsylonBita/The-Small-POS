/**
 * Handler Utilities Index
 *
 * Exports all utility functions for IPC handlers.
 */

export {
  handleIPCError,
  handleIPCErrorSync,
  successResponse,
  errorResponse,
  requireService,
  requireParam,
  IPCError,
  ErrorCodes,
} from './error-handler';

export type {
  IPCResponse,
  ErrorCode,
} from './error-handler';
