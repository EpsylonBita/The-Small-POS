/**
 * Lifecycle Module Index
 *
 * Re-exports all lifecycle-related functions.
 */

export { logErrorToFile, showErrorDialog, showInfoDialog, showConfirmDialog } from './error-logging';

export {
  gracefulShutdown,
  gracefulRestart,
  handlePosControlCommand,
  handleBeforeQuit,
} from './shutdown';

export {
  initializeDatabase,
  initializeServices,
  createMainWindow,
  setupServiceCallbacks,
  startSync,
  normalizeLegacyStatuses,
  startHealthChecks,
  performInitialHealthCheck,
} from './initialization';
