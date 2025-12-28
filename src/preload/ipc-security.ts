/**
 * IPC Security Module
 *
 * Filters out dangerous IPC channels in production builds to prevent
 * accidental or malicious data destruction.
 */

// Dangerous channels that should NEVER be available in production
const DANGEROUS_CHANNELS_PRODUCTION = [
  'database:reset',                    // Nuke entire database
  'database:clear-operational-data',   // Delete business data
  'orders:clear-all',                  // Delete all orders (financial fraud)
  'sync:clear-all-orders',             // Delete all synced orders
  'settings:factory-reset',            // System wipe
  'sync:clear-all',                    // Clear all sync data
  'sync:clear-failed',                 // Might be needed for troubleshooting
  'diagnostic:mark-all-unsynced-earnings', // Data manipulation
];

// Channels that should require elevated permissions
const SENSITIVE_CHANNELS = [
  'sync:force',
  'sync:cleanup-deleted-orders',
  'order:delete',
  'customer:update-ban-status',
  'shift:close-all-active',
];

/**
 * Filter allowed invoke channels based on environment
 */
export function filterAllowedInvokes(channels: string[]): string[] {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // Development: allow all channels
    console.log('[IPC Security] Development mode - all channels enabled');
    return channels;
  }

  // Production: filter out dangerous channels
  const filtered = channels.filter(ch => !DANGEROUS_CHANNELS_PRODUCTION.includes(ch));
  const removed = channels.filter(ch => DANGEROUS_CHANNELS_PRODUCTION.includes(ch));

  if (removed.length > 0) {
    console.log('[IPC Security] Production mode - blocked dangerous channels:', removed);
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
