/**
 * Plugin Icon Helper Utility
 * Provides icons, colors, and names for external delivery/booking plugins
 */

import React, { type ReactElement, useState } from 'react';
import woltLogo from '../assets/plugins/wolt.png';
import efoodLogo from '../assets/plugins/efood.png';
import boxLogo from '../assets/plugins/box.png';
import uberEatsLogo from '../assets/plugins/uber_eats.png';
import bookingLogo from '../assets/plugins/booking.png';
import airbnbLogo from '../assets/plugins/airbnb.png';
import expediaLogo from '../assets/plugins/expedia.png';
import tripadvisorLogo from '../assets/plugins/tripadvisor.png';
import stripeLogo from '../assets/plugins/stripe.png';
import vivaLogo from '../assets/plugins/viva.png';
import googleAnalyticsLogo from '../assets/plugins/google_analytics.png';
import woocommerceLogo from '../assets/plugins/woocommerce.png';
import shopifyLogo from '../assets/plugins/shopify.png';
import mydataLogo from '../assets/plugins/mydata.jpg';
import type { OrderPlugin } from '../../shared/types/orders';

/**
 * Known external plugins from the OrderPlugin union.
 * Used to guard isExternalPlugin and ensure type safety.
 */
const KNOWN_EXTERNAL_PLUGINS: readonly string[] = [
  'wolt',
  'efood',
  'box',
  'uber_eats',
  'booking',
  'tripadvisor',
  'airbnb',
] as const;

/**
 * Known internal plugins (not external)
 */
const KNOWN_INTERNAL_PLUGINS: readonly string[] = ['pos', 'web', 'android-ios'] as const;

/**
 * All known plugins for type checking
 */
const ALL_KNOWN_PLUGINS = [...KNOWN_EXTERNAL_PLUGINS, ...KNOWN_INTERNAL_PLUGINS] as const;

// Plugin brand colors
const PLUGIN_COLORS: Record<OrderPlugin, string> = {
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

// Plugin display names
const PLUGIN_NAMES: Record<OrderPlugin, string> = {
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

// Plugin abbreviations for badges
const PLUGIN_ABBREV: Record<OrderPlugin, string> = {
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

type PluginLogoKind = 'mark' | 'wordmark';

const PLUGIN_LOGOS: Record<string, { url: string; label: string; kind: PluginLogoKind }> = {
  wolt: {
    url: woltLogo,
    label: 'Wolt',
    kind: 'mark',
  },
  efood: {
    url: efoodLogo,
    label: 'efood',
    kind: 'wordmark',
  },
  box: {
    url: boxLogo,
    label: 'Box',
    kind: 'mark',
  },
  uber_eats: {
    url: uberEatsLogo,
    label: 'Uber Eats',
    kind: 'wordmark',
  },
  booking: {
    url: bookingLogo,
    label: 'Booking.com',
    kind: 'wordmark',
  },
  tripadvisor: {
    url: tripadvisorLogo,
    label: 'TripAdvisor',
    kind: 'wordmark',
  },
  airbnb: {
    url: airbnbLogo,
    label: 'Airbnb',
    kind: 'mark',
  },
  expedia: {
    url: expediaLogo,
    label: 'Expedia',
    kind: 'wordmark',
  },
  stripe: {
    url: stripeLogo,
    label: 'Stripe',
    kind: 'wordmark',
  },
  viva: {
    url: vivaLogo,
    label: 'Viva Wallet',
    kind: 'wordmark',
  },
  google_analytics: {
    url: googleAnalyticsLogo,
    label: 'Google Analytics',
    kind: 'wordmark',
  },
  woocommerce: {
    url: woocommerceLogo,
    label: 'WooCommerce',
    kind: 'wordmark',
  },
  shopify: {
    url: shopifyLogo,
    label: 'Shopify',
    kind: 'wordmark',
  },
  mydata: {
    url: mydataLogo,
    label: 'myDATA',
    kind: 'mark',
  },
};

const PLUGIN_LOGO_ALIASES: Record<string, string> = {
  googleanalytics: 'google_analytics',
  viva_wallet: 'viva',
  ubereats: 'uber_eats',
  e_food: 'efood',
  box_gr: 'box',
  boxgr: 'box',
  booking_com: 'booking',
  trip_advisor: 'tripadvisor',
  my_data: 'mydata',
  android_ios: 'android-ios',
};

/**
 * Default color for unknown plugins
 */
const DEFAULT_COLOR = '#6B7280';

/**
 * Check if a plugin string is a known OrderPlugin
 */
function normalizePluginKey(plugin: string): string {
  const normalized = plugin.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return PLUGIN_LOGO_ALIASES[normalized] || normalized;
}

function resolvePluginKey(plugin?: OrderPlugin | string): OrderPlugin | null {
  if (!plugin) return null;
  const normalized = normalizePluginKey(String(plugin));
  return ALL_KNOWN_PLUGINS.includes(normalized as OrderPlugin) ? (normalized as OrderPlugin) : null;
}

function getPluginLogo(plugin?: OrderPlugin | string) {
  if (!plugin) return null;
  const key = normalizePluginKey(String(plugin));
  return PLUGIN_LOGOS[key] || null;
}

function getLogoDimensions(kind: PluginLogoKind, size: number) {
  if (kind === 'wordmark') {
    return { width: Math.round(size * 2.2), height: size, radius: Math.round(size * 0.32) };
  }
  return { width: size, height: size, radius: Math.round(size / 2) };
}

/**
 * Check if plugin is an external delivery/booking plugin.
 * Only returns true for known external plugins defined in OrderPlugin union.
 */
export function isExternalPlugin(plugin?: OrderPlugin | string): boolean {
  const resolved = resolvePluginKey(plugin);
  if (!resolved) return false;
  // Only return true for explicitly known external plugins
  return KNOWN_EXTERNAL_PLUGINS.includes(resolved);
}

/**
 * Get the brand color for a plugin.
 * Returns default gray for unknown plugins.
 */
export function getPluginColor(plugin?: OrderPlugin | string): string {
  const resolved = resolvePluginKey(plugin);
  return resolved ? PLUGIN_COLORS[resolved] : DEFAULT_COLOR;
}

/**
 * Get the human-readable name for a plugin.
 * Returns the plugin string itself for unknown plugins, or 'Unknown' if empty.
 */
export function getPluginName(plugin?: OrderPlugin | string): string {
  const resolved = resolvePluginKey(plugin);
  if (resolved) {
    return PLUGIN_NAMES[resolved];
  }
  return plugin ? String(plugin) : 'Unknown';
}

/**
 * Get the abbreviation for a plugin (for badges).
 * Returns first 2 characters uppercase for unknown plugins, or '?' if empty.
 */
export function getPluginAbbrev(plugin?: OrderPlugin | string): string {
  const resolved = resolvePluginKey(plugin);
  if (resolved) {
    return PLUGIN_ABBREV[resolved];
  }
  if (!plugin) return '?';
  return String(plugin).slice(0, 2).toUpperCase();
}

interface PluginIconProps {
  plugin?: OrderPlugin | string;
  size?: number;
  className?: string;
  showTooltip?: boolean;
}

/**
 * Get a plugin badge/icon component
 * Returns null for internal plugins (pos, web, android-ios)
 */
export function PluginIcon({ plugin, size = 32, className = '', showTooltip = true }: PluginIconProps): ReactElement | null {
  if (!plugin || !isExternalPlugin(plugin)) {
    return null;
  }

  const logo = getPluginLogo(plugin);
  const [logoError, setLogoError] = useState(false);
  const color = getPluginColor(plugin);
  const abbrev = getPluginAbbrev(plugin);
  const name = getPluginName(plugin);

  // Determine font size based on abbreviation length
  const fontSize = abbrev.length > 2 ? (size * 0.28) : (size * 0.4);

  if (logo && !logoError) {
    const { width, height, radius } = getLogoDimensions(logo.kind, size);
    return (
      <div
        className={`inline-flex items-center justify-center shadow-sm ${className}`}
        style={{
          width,
          height,
          borderRadius: radius,
          backgroundColor: '#ffffff',
          border: '1px solid rgba(0,0,0,0.08)',
        }}
        title={showTooltip ? `Order from ${name}` : undefined}
        aria-label={`Order from ${name}`}
      >
        <img
          src={logo.url}
          alt={logo.label}
          style={{ width: '86%', height: '86%', objectFit: 'contain' }}
          onError={() => setLogoError(true)}
        />
      </div>
    );
  }

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

interface PluginBadgeProps {
  plugin?: OrderPlugin | string;
  externalOrderId?: string;
  className?: string;
  showExternalId?: boolean;
}

/**
 * Get a plugin badge with name and optional external order ID
 * Returns null for internal plugins (pos, web, android-ios)
 */
export function PluginBadge({ plugin, externalOrderId, className = '', showExternalId = false }: PluginBadgeProps): ReactElement | null {
  if (!plugin || !isExternalPlugin(plugin)) {
    return null;
  }

  const color = getPluginColor(plugin);
  const name = getPluginName(plugin);

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
      <PluginIcon plugin={plugin} size={20} showTooltip={false} />
      <span>{name} Order</span>
      {showExternalId && externalOrderId && (
        <span className="opacity-70 text-xs">#{externalOrderId}</span>
      )}
    </div>
  );
}

/**
 * Get a small plugin indicator for compact displays
 */
export function PluginIndicator({ plugin, className = '' }: { plugin?: OrderPlugin | string; className?: string }): ReactElement | null {
  if (!plugin || !isExternalPlugin(plugin)) {
    return null;
  }

  return <PluginIcon plugin={plugin} size={18} className={className} />;
}

// ============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// These are deprecated and will be removed in future versions.
// ============================================================================

/**
 * @deprecated Use OrderPlugin instead
 */
export type OrderPlatform = OrderPlugin;

/**
 * @deprecated Use isExternalPlugin instead
 */
export const isExternalPlatform = isExternalPlugin;

/**
 * @deprecated Use getPluginColor instead
 */
export const getPlatformColor = getPluginColor;

/**
 * @deprecated Use getPluginName instead
 */
export const getPlatformName = getPluginName;

/**
 * @deprecated Use getPluginAbbrev instead
 */
export const getPlatformAbbrev = getPluginAbbrev;

/**
 * @deprecated Use PluginIcon instead
 */
export const PlatformIcon = PluginIcon;

/**
 * @deprecated Use PluginBadge instead
 */
export const PlatformBadge = PluginBadge;

/**
 * @deprecated Use PluginIndicator instead
 */
export const PlatformIndicator = PluginIndicator;

export default {
  PluginIcon,
  PluginBadge,
  PluginIndicator,
  getPluginColor,
  getPluginName,
  getPluginAbbrev,
  isExternalPlugin,
  // Deprecated exports for backward compatibility
  PlatformIcon,
  PlatformBadge,
  PlatformIndicator,
  getPlatformColor,
  getPlatformName,
  getPlatformAbbrev,
  isExternalPlatform,
};
