/**
 * IPC Security Module
 *
 * Filters out dangerous IPC channels in production builds to prevent
 * accidental or malicious data destruction.
 */

// Dangerous channels that should NEVER be available in production
// Note: database:clear-operational-data is allowed because the UI has a confirmation dialog
// and it preserves settings/menu data (not a full wipe)
const DANGEROUS_CHANNELS_PRODUCTION = [
  'database:reset',                    // Nuke entire database
  'orders:clear-all',                  // Delete all orders (financial fraud)
  'sync:clear-all-orders',             // Delete all synced orders
  'sync:clear-all',                    // Clear all sync data
  'sync:clear-failed',                 // Might be needed for troubleshooting
  'diagnostic:mark-all-unsynced-earnings', // Data manipulation
  'printer:test-greek-direct',         // SECURITY: Dev-only test handler - potential command injection via printerNameArg
];

// Channels that should require elevated permissions
// Note: settings:factory-reset moved here from DANGEROUS_CHANNELS_PRODUCTION
// to allow legitimate admin-triggered factory resets while still marking as sensitive
const SENSITIVE_CHANNELS = [
  'sync:force',
  'sync:cleanup-deleted-orders',
  'order:delete',
  'customer:update-ban-status',
  'shift:close-all-active',
  'settings:factory-reset',            // System wipe (admin-only operation)
];

// Track if we've already logged the mode message (to avoid log spam)
let hasLoggedMode = false;

/**
 * Filter allowed invoke channels based on environment
 */
export function filterAllowedInvokes(channels: string[]): string[] {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // Development: allow all channels (only log once)
    if (!hasLoggedMode) {
      console.log('[IPC Security] Development mode - all channels enabled');
      hasLoggedMode = true;
    }
    return channels;
  }

  // Production: filter out dangerous channels
  const filtered = channels.filter(ch => !DANGEROUS_CHANNELS_PRODUCTION.includes(ch));
  const removed = channels.filter(ch => DANGEROUS_CHANNELS_PRODUCTION.includes(ch));

  // Only log once in production mode
  if (!hasLoggedMode && removed.length > 0) {
    console.log('[IPC Security] Production mode - blocked dangerous channels:', removed);
    hasLoggedMode = true;
  }

  return filtered;
}

/**
 * Check if a channel is sensitive and might require additional validation
 */
export function isSensitiveChannel(channel: string): boolean {
  return SENSITIVE_CHANNELS.includes(channel) ||
         DANGEROUS_CHANNELS_PRODUCTION.includes(channel);
}

/**
 * Get list of dangerous channels (for logging/audit purposes)
 */
export function getDangerousChannels(): string[] {
  return [...DANGEROUS_CHANNELS_PRODUCTION];
}
