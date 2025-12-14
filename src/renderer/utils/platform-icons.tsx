/**
 * Platform Icon Helper Utility
 * Provides icons, colors, and names for external delivery/booking platforms
 */

import React, { type ReactElement } from 'react';
import type { OrderPlatform } from '../../shared/types/orders';

/**
 * Known external platforms from the OrderPlatform union.
 * Used to guard isExternalPlatform and ensure type safety.
 */
const KNOWN_EXTERNAL_PLATFORMS: readonly string[] = [
  'wolt',
  'efood',
  'box',
  'uber_eats',
  'booking',
  'tripadvisor',
  'airbnb',
] as const;

/**
 * Known internal platforms (not external)
 */
const KNOWN_INTERNAL_PLATFORMS: readonly string[] = ['pos', 'web', 'android-ios'] as const;

/**
 * All known platforms for type checking
 */
const ALL_KNOWN_PLATFORMS = [...KNOWN_EXTERNAL_PLATFORMS, ...KNOWN_INTERNAL_PLATFORMS] as const;

// Platform brand colors
const PLATFORM_COLORS: Record<OrderPlatform, string> = {
  wolt: '#00C2E8',      // Wolt cyan
  efood: '#FF6B00',     // Efood orange
  box: '#0066FF',       // Box blue
  uber_eats: '#06C167', // Uber Eats green
  booking: '#003580',   // Booking.com blue
  tripadvisor: '#00AF87', // TripAdvisor green
  airbnb: '#FF5A5F',    // Airbnb pink/red
  pos: '#6B7280',       // Gray for internal
  web: '#6B7280',       // Gray for internal
  'android-ios': '#6B7280', // Gray for internal
};

// Platform display names
const PLATFORM_NAMES: Record<OrderPlatform, string> = {
  wolt: 'Wolt',
  efood: 'Efood',
  box: 'Box',
  uber_eats: 'Uber Eats',
  booking: 'Booking.com',
  tripadvisor: 'TripAdvisor',
  airbnb: 'Airbnb',
  pos: 'POS',
  web: 'Web',
  'android-ios': 'Mobile App',
};

// Platform abbreviations for badges
const PLATFORM_ABBREV: Record<OrderPlatform, string> = {
  wolt: 'W',
  efood: 'E',
  box: 'B',
  uber_eats: 'UE',
  booking: 'B.com',
  tripadvisor: 'TA',
  airbnb: 'A',
  pos: 'POS',
  web: 'Web',
  'android-ios': 'App',
};

/**
 * Default color for unknown platforms
 */
const DEFAULT_COLOR = '#6B7280';

/**
 * Check if a platform string is a known OrderPlatform
 */
function isKnownPlatform(platform: string): platform is OrderPlatform {
  return ALL_KNOWN_PLATFORMS.includes(platform as any);
}

/**
 * Check if platform is an external delivery/booking platform.
 * Only returns true for known external platforms defined in OrderPlatform union.
 */
export function isExternalPlatform(platform?: OrderPlatform | string): boolean {
  if (!platform) return false;
  // Only return true for explicitly known external platforms
  return KNOWN_EXTERNAL_PLATFORMS.includes(platform);
}

/**
 * Get the brand color for a platform.
 * Returns default gray for unknown platforms.
 */
export function getPlatformColor(platform?: OrderPlatform | string): string {
  if (!platform) return DEFAULT_COLOR;
  // Only use the map if it's a known platform
  if (isKnownPlatform(platform)) {
    return PLATFORM_COLORS[platform];
  }
  return DEFAULT_COLOR;
}

/**
 * Get the human-readable name for a platform.
 * Returns the platform string itself for unknown platforms, or 'Unknown' if empty.
 */
export function getPlatformName(platform?: OrderPlatform | string): string {
  if (!platform) return 'Unknown';
  // Only use the map if it's a known platform
  if (isKnownPlatform(platform)) {
    return PLATFORM_NAMES[platform];
  }
  // Return the raw platform string for unknown platforms
  return platform;
}

/**
 * Get the abbreviation for a platform (for badges).
 * Returns first 2 characters uppercase for unknown platforms, or '?' if empty.
 */
export function getPlatformAbbrev(platform?: OrderPlatform | string): string {
  if (!platform) return '?';
  // Only use the map if it's a known platform
  if (isKnownPlatform(platform)) {
    return PLATFORM_ABBREV[platform];
  }
  // Fallback: first 2 characters uppercase
  return platform.slice(0, 2).toUpperCase();
}

interface PlatformIconProps {
  platform?: OrderPlatform | string;
  size?: number;
  className?: string;
  showTooltip?: boolean;
}

/**
 * Get a platform badge/icon component
 * Returns null for internal platforms (pos, web, android-ios)
 */
export function PlatformIcon({ platform, size = 32, className = '', showTooltip = true }: PlatformIconProps): ReactElement | null {
  if (!platform || !isExternalPlatform(platform)) {
    return null;
  }

  const color = getPlatformColor(platform);
  const abbrev = getPlatformAbbrev(platform);
  const name = getPlatformName(platform);

  // Determine font size based on abbreviation length
  const fontSize = abbrev.length > 2 ? (size * 0.28) : (size * 0.4);

  return (
    <div
      className={`inline-flex items-center justify-center rounded-full text-white font-bold shadow-lg ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: `${fontSize}px`,
        lineHeight: 1,
      }}
      title={showTooltip ? `Order from ${name}` : undefined}
      aria-label={`Order from ${name}`}
    >
      {abbrev}
    </div>
  );
}

interface PlatformBadgeProps {
  platform?: OrderPlatform | string;
  externalOrderId?: string;
  className?: string;
  showExternalId?: boolean;
}

/**
 * Get a platform badge with name and optional external order ID
 * Returns null for internal platforms (pos, web, android-ios)
 */
export function PlatformBadge({ platform, externalOrderId, className = '', showExternalId = false }: PlatformBadgeProps): ReactElement | null {
  if (!platform || !isExternalPlatform(platform)) {
    return null;
  }

  const color = getPlatformColor(platform);
  const name = getPlatformName(platform);

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm font-medium ${className}`}
      style={{
        backgroundColor: `${color}20`,
        color: color,
        borderColor: `${color}40`,
        borderWidth: 1,
      }}
    >
      <PlatformIcon platform={platform} size={20} showTooltip={false} />
      <span>{name} Order</span>
      {showExternalId && externalOrderId && (
        <span className="opacity-70 text-xs">#{externalOrderId}</span>
      )}
    </div>
  );
}

/**
 * Get a small platform indicator for compact displays
 */
export function PlatformIndicator({ platform, className = '' }: { platform?: OrderPlatform | string; className?: string }): ReactElement | null {
  if (!platform || !isExternalPlatform(platform)) {
    return null;
  }

  const color = getPlatformColor(platform);
  const abbrev = getPlatformAbbrev(platform);
  const name = getPlatformName(platform);

  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded text-xs font-semibold ${className}`}
      style={{
        backgroundColor: color,
        color: 'white',
      }}
      title={`Order from ${name}`}
      aria-label={`Order from ${name}`}
    >
      {abbrev}
    </span>
  );
}

export default {
  PlatformIcon,
  PlatformBadge,
  PlatformIndicator,
  getPlatformColor,
  getPlatformName,
  getPlatformAbbrev,
  isExternalPlatform,
};
