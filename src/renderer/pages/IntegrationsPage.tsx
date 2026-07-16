/**
 * IntegrationsPage - Plugin integrations management for Desktop POS
 *
 * Features:
 * - Available integrations list with module-based filtering
 * - Connection status indicators
 * - Enable/disable toggles
 * - Configuration panels per integration
 * - Sync status display
 *
 * @since 2.4.0
 */

import React, { useState, useEffect, useMemo, useCallback, memo, useRef } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useAcquiredModules, MODULE_IDS } from '../hooks/useAcquiredModules';
import { LiquidGlassModal, POSGlassButton, POSGlassInput } from '../components/ui/pos-glass-components';
import { formatTime } from '../utils/format';
import {
  Plug,
  CheckCircle,
  XCircle,
  AlertCircle,
  RefreshCw,
  Settings,
  Truck,
  Building2,
  FileText,
  Wifi,
  WifiOff,
  Loader2,
  ChevronDown,
  ChevronUp,
  Pizza,
  Bike,
  Package,
  Home,
  Plane,
  Receipt,
  Lock,
  CreditCard,
  BarChart3,
  ShoppingCart,
  Phone,
  ExternalLink,
} from 'lucide-react';
import { posApiGet, posApiPost } from '../utils/api-helpers';
import { openExternalUrl } from '../utils/external-url';
import { normalizeAdminDashboardUrl } from '../utils/connection-code';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { getOfflineActionState } from '../services/offline-page-capabilities';
import { getPluginLogo } from '../utils/plugin-icons';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';

// ============================================================
// TYPES
// ============================================================

type IntegrationCategory = 'delivery' | 'hotel' | 'government' | 'payment' | 'analytics' | 'ecommerce' | 'communications' | 'other';

interface Integration {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  category: IntegrationCategory;
  requiredModule?: string;
  requiresPartnerCredentials?: boolean;
}

interface IntegrationWithStatus extends Integration {
  status: 'connected' | 'disconnected' | 'pending';
  lastSyncedAt?: string;
  settings?: {
    auto_accept_orders?: boolean;
    auto_accept_prep_minutes?: number;
    store_status_override?: string;
    target_terminal_id?: string | null;
  };
}

interface RemoteIntegrationPayload {
  id?: string;
  plugin_id?: string | null;
  provider?: string | null;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  is_purchased?: boolean;
  is_active?: boolean;
  status?: string | null;
  requires_partner_credentials?: boolean;
  settings?: IntegrationWithStatus['settings'];
  last_sync_at?: string | null;
}

interface IntegrationStats {
  total: number;
  connected: number;
  disconnected: number;
  pending: number;
}

// ============================================================
// CONSTANTS
// ============================================================

const ALL_INTEGRATIONS: Integration[] = [
  // Delivery plugins - require 'delivery' module
  {
    id: 'efood',
    name: 'e-food',
    description: 'Greece\'s leading food delivery platform',
    icon: <Pizza className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'wolt',
    name: 'Wolt',
    description: 'Food delivery and discovery platform',
    icon: <Bike className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'box',
    name: 'Box',
    description: 'Delivery platform for restaurants',
    icon: <Package className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
    requiresPartnerCredentials: true,
  },
  {
    id: 'glovo',
    name: 'Glovo',
    description: 'Glovo ordering and menu integration',
    icon: <Truck className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'bolt_food',
    name: 'Bolt Food',
    description: 'Bolt Food ordering and status integration',
    icon: <Bike className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'uber_eats',
    name: 'Uber Eats',
    description: 'Uber Eats ordering and menu integration',
    icon: <Truck className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'just_eat_takeaway',
    name: 'Just Eat / Takeaway.com',
    description: 'Just Eat and Takeaway.com ordering integration',
    icon: <Package className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'deliveroo',
    name: 'Deliveroo',
    description: 'Deliveroo order and menu integration',
    icon: <Bike className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'foodora',
    name: 'foodora',
    description: 'foodora order and menu integration',
    icon: <Pizza className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'smood',
    name: 'Smood',
    description: 'Swiss Smood food delivery integration',
    icon: <Truck className="w-6 h-6" />,
    category: 'delivery',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  // Hotel plugins - require 'rooms' module
  {
    id: 'booking',
    name: 'Booking.com',
    description: 'World\'s leading hotel booking platform',
    icon: <Building2 className="w-6 h-6" />,
    category: 'hotel',
    requiredModule: MODULE_IDS.ROOMS,
  },
  {
    id: 'airbnb',
    name: 'Airbnb',
    description: 'Vacation rentals and experiences',
    icon: <Home className="w-6 h-6" />,
    category: 'hotel',
    requiredModule: MODULE_IDS.ROOMS,
  },
  {
    id: 'expedia',
    name: 'Expedia',
    description: 'Travel booking and hotel reservations',
    icon: <Plane className="w-6 h-6" />,
    category: 'hotel',
    requiredModule: MODULE_IDS.ROOMS,
  },
  {
    id: 'tripadvisor',
    name: 'TripAdvisor',
    description: 'Travel reviews and hotel booking',
    icon: <Building2 className="w-6 h-6" />,
    category: 'hotel',
    requiredModule: MODULE_IDS.ROOMS,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Online payment processing',
    icon: <CreditCard className="w-6 h-6" />,
    category: 'payment',
  },
  {
    id: 'viva',
    name: 'Viva Wallet',
    description: 'European payment processing',
    icon: <CreditCard className="w-6 h-6" />,
    category: 'payment',
  },
  {
    id: 'google_analytics',
    name: 'Google Analytics',
    description: 'Website and app analytics',
    icon: <BarChart3 className="w-6 h-6" />,
    category: 'analytics',
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    description: 'WooCommerce product and order sync',
    icon: <ShoppingCart className="w-6 h-6" />,
    category: 'ecommerce',
    requiredModule: MODULE_IDS.PRODUCT_CATALOG,
  },
  {
    id: 'shopify',
    name: 'Shopify',
    description: 'Shopify product and order sync',
    icon: <ShoppingCart className="w-6 h-6" />,
    category: 'ecommerce',
    requiredModule: MODULE_IDS.PRODUCT_CATALOG,
  },
  {
    id: 'caller_id',
    name: 'Caller ID (VoIP/SIP)',
    description: 'Caller ID recognition and customer lookup',
    icon: <Phone className="w-6 h-6" />,
    category: 'communications',
  },
  {
    id: 'mydata',
    name: 'MyData',
    description: 'Greek AADE e-invoicing compliance',
    icon: <Receipt className="w-6 h-6" />,
    category: 'government',
  },
  {
    id: 'ergani_digital_schedule',
    name: 'ERGANI/Epsilon Digital Schedule',
    description: 'Greek digital work-card and weekly schedule compliance',
    icon: <FileText className="w-6 h-6" />,
    category: 'government',
    requiredModule: MODULE_IDS.STAFF_SCHEDULE,
  },
];

const CATEGORY_CONFIG: Record<IntegrationCategory, { label: string; icon: typeof Plug }> = {
  delivery: { label: 'Delivery Platforms', icon: Truck },
  hotel: { label: 'Hotel Platforms', icon: Building2 },
  government: { label: 'Government & Compliance', icon: FileText },
  payment: { label: 'Payment Gateways', icon: CreditCard },
  analytics: { label: 'Analytics', icon: BarChart3 },
  ecommerce: { label: 'E-commerce', icon: ShoppingCart },
  communications: { label: 'Communications', icon: Phone },
  other: { label: 'Other Plugins', icon: Plug },
};

type PluginFieldKey = 'api_key' | 'api_secret' | 'merchant_id' | 'store_id' | 'store_url' | 'chain_id' | 'webhook_secret';

const PLUGIN_FORM_CONFIG: Record<string, { requiredFields: PluginFieldKey[]; supportsCommission?: boolean; supportsAutoAccept?: boolean; supportsPrepMinutes?: boolean; supportsMenuSync?: boolean; supportsAvailabilitySync?: boolean; supportsProductSync?: boolean; supportsOrderSync?: boolean; supportsInventorySync?: boolean; }> = {
  efood: { requiredFields: ['api_key', 'api_secret', 'store_id', 'chain_id', 'webhook_secret'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  wolt: { requiredFields: ['api_key', 'api_secret', 'merchant_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  box: { requiredFields: ['api_key', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  glovo: { requiredFields: ['api_key', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  bolt_food: { requiredFields: ['api_key', 'api_secret', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  uber_eats: { requiredFields: ['api_key', 'api_secret', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  just_eat_takeaway: { requiredFields: ['api_key', 'api_secret', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  deliveroo: { requiredFields: ['api_key', 'api_secret', 'merchant_id', 'store_id', 'webhook_secret'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  foodora: { requiredFields: ['api_key', 'api_secret', 'store_id', 'chain_id', 'webhook_secret'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  smood: { requiredFields: ['api_key', 'api_secret', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  booking: { requiredFields: ['api_key', 'api_secret', 'merchant_id'], supportsCommission: true },
  airbnb: { requiredFields: ['api_key', 'api_secret'], supportsCommission: true },
  expedia: { requiredFields: ['api_key', 'api_secret', 'merchant_id'], supportsCommission: true },
  tripadvisor: { requiredFields: ['api_key', 'api_secret'], supportsCommission: true },
  stripe: { requiredFields: ['api_key', 'api_secret'] },
  viva: { requiredFields: ['api_key', 'api_secret', 'merchant_id'] },
  google_analytics: { requiredFields: ['api_key'] },
  woocommerce: { requiredFields: ['store_url', 'api_key', 'api_secret'], supportsProductSync: true, supportsOrderSync: true, supportsInventorySync: true },
  shopify: { requiredFields: ['store_url', 'api_key', 'api_secret'], supportsProductSync: true, supportsOrderSync: true, supportsInventorySync: true },
  ergani_digital_schedule: { requiredFields: ['api_key', 'api_secret', 'merchant_id'] },
  caller_id: { requiredFields: [] },
};

const PLUGIN_FIELD_LABELS: Record<string, Partial<Record<PluginFieldKey, string>>> = {
  bolt_food: {
    api_key: 'Bolt Food Integrator ID',
    api_secret: 'Bolt Food Secret Key',
    store_id: 'Bolt Food Provider ID',
  },
  uber_eats: {
    api_key: 'Uber Eats OAuth Client ID',
    api_secret: 'Uber Eats OAuth Client Secret',
    store_id: 'Uber Eats Store ID',
  },
  just_eat_takeaway: {
    api_key: 'JET Connect API Key',
    api_secret: 'JET Webhook Secret',
    store_id: 'JET Restaurant Reference',
  },
  deliveroo: {
    api_key: 'Deliveroo OAuth Client ID',
    api_secret: 'Deliveroo OAuth Client Secret',
    merchant_id: 'Deliveroo Brand ID',
    store_id: 'Deliveroo Site ID',
    webhook_secret: 'Deliveroo Webhook Secret',
  },
  foodora: {
    api_key: 'Foodora OAuth Client ID',
    api_secret: 'Foodora OAuth Client Secret',
    store_id: 'Foodora Vendor ID',
    chain_id: 'Foodora Chain ID',
    webhook_secret: 'Foodora Webhook Secret',
  },
  smood: {
    api_key: 'Smood API Key',
    api_secret: 'Smood API/Webhook Secret',
    store_id: 'Smood Store ID',
  },
};

interface PluginFormState {
  api_key: string;
  api_secret: string;
  merchant_id: string;
  store_id: string;
  store_url: string;
  chain_id: string;
  webhook_secret: string;
  commission_pct: number;
  auto_accept_orders: boolean;
  auto_accept_prep_minutes: number;
  sync_menu: boolean;
  sync_availability: boolean;
  sync_products: boolean;
  sync_orders: boolean;
  sync_inventory: boolean;
  target_terminal_id: string | null;
}

interface TerminalOption {
  id: string;
  name?: string | null;
  location?: string | null;
}

interface MyDataConfigFetchResult {
  ok: boolean;
  status: number;
  config?: Record<string, any>;
  error?: string;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const calculateStats = (integrations: IntegrationWithStatus[]): IntegrationStats => ({
  total: integrations.length,
  connected: integrations.filter(i => i.status === 'connected').length,
  disconnected: integrations.filter(i => i.status === 'disconnected').length,
  pending: integrations.filter(i => i.status === 'pending').length,
});

const normalizeProviderId = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const INTEGRATION_CATALOG_BY_ID = new Map(
  ALL_INTEGRATIONS.map((integration) => [normalizeProviderId(integration.id), integration])
);

const normalizeIntegrationCategory = (
  value: unknown,
  fallback: IntegrationCategory = 'other'
): IntegrationCategory => {
  if (typeof value !== 'string') return fallback;
  const normalized = normalizeProviderId(value);
  return normalized in CATEGORY_CONFIG ? normalized as IntegrationCategory : fallback;
};

const getRemoteIntegrationId = (integration: RemoteIntegrationPayload) =>
  normalizeProviderId(
    integration.plugin_id ||
    integration.provider ||
    integration.name ||
    integration.id ||
    ''
  );

const mapRemoteStatus = (integration: RemoteIntegrationPayload): IntegrationWithStatus['status'] => {
  if (integration.status === 'connected') return 'connected';
  if (integration.status === 'pending' || integration.status === 'error') return 'pending';
  if (integration.status === 'inactive') return 'disconnected';
  return integration.is_active ? 'connected' : 'disconnected';
};

const mapPurchasedIntegration = (remote: RemoteIntegrationPayload): IntegrationWithStatus | null => {
  const id = getRemoteIntegrationId(remote);
  if (!id) return null;

  const fallback = INTEGRATION_CATALOG_BY_ID.get(id);
  const requiresPartnerCredentials = Boolean(
    remote.requires_partner_credentials ?? fallback?.requiresPartnerCredentials
  );

  return {
    id,
    name: remote.name || fallback?.name || id.replace(/_/g, ' '),
    description: remote.description || fallback?.description || '',
    icon: fallback?.icon || <Plug className="w-6 h-6" />,
    category: normalizeIntegrationCategory(remote.category, fallback?.category || 'other'),
    requiredModule: fallback?.requiredModule,
    requiresPartnerCredentials,
    status: requiresPartnerCredentials ? 'pending' : mapRemoteStatus(remote),
    lastSyncedAt: typeof remote.last_sync_at === 'string' ? remote.last_sync_at : undefined,
    settings: remote.settings || undefined,
  };
};

async function fetchMyDataConfigQuietly(): Promise<MyDataConfigFetchResult> {
  try {
    const result = await posApiGet<{ config?: Record<string, any> }>('/pos/mydata/config');
    if (!result.success) {
      return {
        ok: false,
        status: result.status ?? 0,
        error: result.error || `HTTP ${result.status ?? 0}`,
      };
    }

    return {
      ok: true,
      status: result.status ?? 200,
      config: result.data?.config,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Network error',
    };
  }
}

// ============================================================
// INTEGRATION CARD COMPONENT
// ============================================================

interface IntegrationLogoProps {
  integration: Integration;
  isDark: boolean;
}

const IntegrationLogo: React.FC<IntegrationLogoProps> = ({ integration, isDark }) => {
  const logo = getPluginLogo(integration.id);

  return (
    <div
      className={`w-14 h-12 shrink-0 rounded-xl flex items-center justify-center overflow-hidden ${
        logo
          ? 'bg-white border border-gray-200'
          : isDark
          ? 'bg-zinc-900 border border-zinc-800 text-zinc-100'
          : 'bg-gray-100 text-gray-700'
      }`}
      aria-label={logo ? `${logo.label} logo` : integration.name}
    >
      {logo ? (
        <img
          src={logo.url}
          alt={logo.label}
          className="max-h-8 max-w-[44px] object-contain"
        />
      ) : (
        integration.icon
      )}
    </div>
  );
};

interface IntegrationCardProps {
  integration: IntegrationWithStatus;
  isDark: boolean;
  toggleDisabledMessage?: string | null;
  onToggle: (id: string) => void;
  onConfigure: (integration: IntegrationWithStatus) => void;
}

const IntegrationCard = memo<IntegrationCardProps>(({
  integration,
  isDark,
  toggleDisabledMessage,
  onToggle,
  onConfigure,
}) => {
  const { t } = useTranslation();
  const isLocked = integration.requiresPartnerCredentials;

  const getStatusColor = (status: IntegrationWithStatus['status']) => {
    switch (status) {
      case 'connected': return '#22c55e';
      case 'pending': return '#f59e0b';
      case 'disconnected': return '#6b7280';
    }
  };

  const getStatusIcon = (status: IntegrationWithStatus['status']) => {
    switch (status) {
      case 'connected': return CheckCircle;
      case 'pending': return AlertCircle;
      case 'disconnected': return XCircle;
    }
  };

  const StatusIcon = isLocked ? AlertCircle : getStatusIcon(integration.status);
  const statusColor = isLocked ? '#f59e0b' : getStatusColor(integration.status);
  const isToggleDisabled =
    isLocked ||
    integration.status === 'pending' ||
    Boolean(toggleDisabledMessage);
  const isEnabled = integration.status === 'connected';

  return (
    <motion.div
      variants={pageMotionItem}
      className={`relative p-4 rounded-2xl border transition-all duration-200 ${
        isDark
          ? 'bg-zinc-950 border-zinc-800 active:border-zinc-600'
          : 'bg-white border-gray-200 active:border-gray-300'
      }`}
    >
      <div className="flex items-start gap-4">
        {/* Icon */}
        <IntegrationLogo integration={integration} isDark={isDark} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h3 className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {integration.name}
          </h3>
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t(`integrations.plugins.${integration.id}.description`, integration.description)}
          </p>

          {/* Status Badge */}
          <div className="flex items-center gap-2 mt-3">
            <div
              className="flex items-center gap-1.5 text-xs font-medium"
              style={{
                color: statusColor,
              }}
            >
              <StatusIcon size={12} />
              <span>
                {isLocked && t('integrations.status.partnerRequired', 'Partner credentials required')}
                {!isLocked && integration.status === 'connected' && t('integrations.status.connected', 'Connected')}
                {!isLocked && integration.status === 'pending' && t('integrations.status.pending', 'Pending')}
                {!isLocked && integration.status === 'disconnected' && t('integrations.status.disconnected', 'Not Connected')}
              </span>
            </div>
            {integration.lastSyncedAt && integration.status === 'connected' && (
              <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {t('integrations.lastSync', 'Synced')}: {formatTime(integration.lastSyncedAt)}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col items-end gap-2">
          {(integration.status === 'connected' || integration.status === 'pending') && !isLocked ? (
            <button
              onClick={() => onConfigure(integration)}
              className={`p-2 rounded-2xl inline-flex items-center justify-center transition-transform duration-150 active:scale-95 ${
                isDark
                  ? 'active:bg-white/10 text-gray-400 active:text-white'
                  : 'active:bg-gray-100 text-gray-500 active:text-gray-700'
              }`}
              aria-label={t('integrations.configure', 'Configure')}
            >
              <Settings size={18} />
            </button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            aria-label={isToggleDisabled && toggleDisabledMessage ? toggleDisabledMessage : t('integrations.togglePlugin', 'Toggle plugin')}
            onClick={() => !isToggleDisabled && onToggle(integration.id)}
            disabled={isToggleDisabled}
            className={`relative inline-flex h-6 w-14 shrink-0 items-center rounded-full border transition-all duration-200 ${
              isEnabled
                ? 'bg-[#67d75f] border-[#67d75f] shadow-[0_0_12px_rgba(103,215,95,0.45)]'
                : 'bg-[#d7d7d9] border-[#d7d7d9]'
            } ${isToggleDisabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] transition-all duration-200 ${
                isEnabled
                  ? 'translate-x-8'
                  : 'translate-x-0.5'
              }`}
            />
          </button>
          <span className={`text-[10px] font-medium ${isEnabled ? 'text-emerald-400' : isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
            {isLocked
              ? t('integrations.partnerRequired', 'Partner Required')
              : integration.status === 'pending'
              ? t('common.pending', 'Pending')
              : isEnabled
              ? t('common.on', 'On')
              : t('common.off', 'Off')}
          </span>
        </div>
      </div>
    </motion.div>
  );
});

IntegrationCard.displayName = 'IntegrationCard';

// ============================================================
// CATEGORY SECTION COMPONENT
// ============================================================

interface CategorySectionProps {
  category: IntegrationCategory;
  integrations: IntegrationWithStatus[];
  isDark: boolean;
  toggleDisabledMessage?: string | null;
  onToggle: (id: string) => void;
  onConfigure: (integration: IntegrationWithStatus) => void;
}

const CategorySection = memo<CategorySectionProps>(({
  category,
  integrations,
  isDark,
  toggleDisabledMessage,
  onToggle,
  onConfigure,
}) => {
  const { t } = useTranslation();
  
  const [isExpanded, setIsExpanded] = useState(true);
  const config = CATEGORY_CONFIG[category];
  const Icon = config.icon;

  const connectedCount = integrations.filter(i => i.status === 'connected').length;

  return (
    <motion.section variants={pageMotionItem} className="mb-6">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center justify-between p-3 rounded-2xl mb-3 transition-transform active:scale-[0.99] ${
          isDark ? 'active:bg-zinc-900/80' : 'active:bg-gray-50'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-8 h-8 rounded-2xl flex items-center justify-center ${
              isDark ? 'bg-zinc-900 border border-zinc-800' : 'bg-gray-100'
            }`}
          >
            <Icon size={16} className={isDark ? 'text-zinc-300' : 'text-gray-600'} />
          </div>
          <div className="text-left">
            <h2 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t(`integrations.category.${category}`, config.label)}
            </h2>
            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
              {connectedCount}/{integrations.length} {t('integrations.connected', 'connected')}
            </p>
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp size={20} className={isDark ? 'text-zinc-400' : 'text-gray-500'} />
        ) : (
          <ChevronDown size={20} className={isDark ? 'text-zinc-400' : 'text-gray-500'} />
        )}
      </button>

      {isExpanded && (
        <motion.div variants={pageMotionContainer} className="grid gap-3 sm:grid-cols-1 lg:grid-cols-2">
          {integrations.map(integration => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              isDark={isDark}
              toggleDisabledMessage={toggleDisabledMessage}
              onToggle={onToggle}
              onConfigure={onConfigure}
            />
          ))}
        </motion.div>
      )}
    </motion.section>
  );
});

CategorySection.displayName = 'CategorySection';

// ============================================================
// STATS CARD COMPONENT
// ============================================================

interface StatsCardProps {
  label: string;
  value: number;
  icon: typeof Plug;
  color: string;
  isDark: boolean;
}

const StatsCard = memo<StatsCardProps>(({ label, value, icon: Icon, color, isDark }) => (
  <motion.div
    variants={pageMotionItem}
    className={`p-4 rounded-2xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}
  >
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
        <Icon size={20} style={{ color }} />
      </div>
      <div>
        <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {value}
        </p>
        <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          {label}
        </p>
      </div>
    </div>
  </motion.div>
));

StatsCard.displayName = 'StatsCard';

// ============================================================
// MAIN PAGE COMPONENT
// ============================================================

export const IntegrationsPage: React.FC = () => {
  const { t } = useTranslation();
  
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const { isLoading: modulesLoading, refetch: refetchModules } = useAcquiredModules();
  const { getSetting } = useTerminalSettings();
  // State
  const [integrations, setIntegrations] = useState<IntegrationWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedIntegrations, setHasLoadedIntegrations] = useState(false);
  const hasLoadedIntegrationsRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [myDataConfig, setMyDataConfig] = useState<Record<string, any> | null>(null);
  const [myDataConfigError, setMyDataConfigError] = useState<string | null>(null);
  const [myDataModalOpen, setMyDataModalOpen] = useState(false);
  const [myDataSaving, setMyDataSaving] = useState(false);
  const [myDataConnectionType, setMyDataConnectionType] = useState<'usb_serial' | 'bluetooth'>('usb_serial');
  const [myDataSerialPort, setMyDataSerialPort] = useState('');
  const [myDataBaudRate, setMyDataBaudRate] = useState('9600');
  const [myDataBluetoothAddress, setMyDataBluetoothAddress] = useState('');
  const [pluginModalOpen, setPluginModalOpen] = useState(false);
  const [activePlugin, setActivePlugin] = useState<IntegrationWithStatus | null>(null);
  const [pluginSaving, setPluginSaving] = useState(false);
  const [pluginForm, setPluginForm] = useState<PluginFormState>({
    api_key: '',
    api_secret: '',
    merchant_id: '',
    store_id: '',
    store_url: '',
    chain_id: '',
    webhook_secret: '',
    commission_pct: 20,
    auto_accept_orders: false,
    auto_accept_prep_minutes: 20,
    sync_menu: true,
    sync_availability: true,
    sync_products: true,
    sync_orders: true,
    sync_inventory: true,
    target_terminal_id: null,
  });
  const [availableTerminals, setAvailableTerminals] = useState<TerminalOption[]>([]);
  const [terminalsLoading, setTerminalsLoading] = useState(false);
  const [terminalsError, setTerminalsError] = useState<string | null>(null);
  const isMyDataMissing = myDataConfigError === 'MyData not configured';
  const canSaveMyData = !myDataSaving && (!myDataConfigError || isMyDataMissing);
  const toggleAction = getOfflineActionState('integrations', 'toggle', isOnline);
  const saveAction = getOfflineActionState('integrations', 'save', isOnline);
  const saveMyDataAction = getOfflineActionState('integrations', 'mydata.save', isOnline);

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!myDataConfig?.device_connection) return;
    const connection = myDataConfig.device_connection as Record<string, any>;
    if (connection.type === 'bluetooth') {
      setMyDataConnectionType('bluetooth');
      setMyDataBluetoothAddress(connection.address || '');
    } else if (connection.type === 'usb_serial') {
      setMyDataConnectionType('usb_serial');
      setMyDataSerialPort(connection.port || '');
      setMyDataBaudRate(String(connection.baud_rate || '9600'));
    }
  }, [myDataConfig]);

  const fetchMyDataConfig = useCallback(async () => {
    try {
      const myDataResult = await fetchMyDataConfigQuietly();
      if (myDataResult.ok && myDataResult.config) {
        setMyDataConfig(myDataResult.config);
        setMyDataConfigError(null);
        return;
      }

      if (myDataResult.status === 404) {
        setMyDataConfig({});
        setMyDataConfigError('MyData not configured');
        return;
      }

      setMyDataConfigError(myDataResult.error || 'Failed to fetch MyData config');
    } catch (err) {
      console.warn('Failed to fetch MyData config:', err);
      setMyDataConfigError('Failed to fetch MyData config');
    }
  }, []);

  // Fetch integration statuses
  const fetchIntegrations = useCallback(async () => {
    const shouldShowLoading = !hasLoadedIntegrationsRef.current;

    try {
      if (shouldShowLoading) {
        setLoading(true);
      }
      setError(null);

      const integrationsResult = await posApiGet<{ integrations?: RemoteIntegrationPayload[] }>('/pos/integrations');
      if (!integrationsResult.success) {
        throw new Error(integrationsResult.error || 'Failed to fetch integrations');
      }

      const seenIds = new Set<string>();
      const integrationsWithStatus = (integrationsResult.data?.integrations || [])
        .filter((integration) => integration.is_purchased === true)
        .map(mapPurchasedIntegration)
        .filter((integration): integration is IntegrationWithStatus => {
          if (!integration || seenIds.has(integration.id)) return false;
          seenIds.add(integration.id);
          return true;
        });

      setIntegrations(integrationsWithStatus);
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch integrations');
      setIntegrations([]);
    } finally {
      hasLoadedIntegrationsRef.current = true;
      setHasLoadedIntegrations(true);
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  // Lazy-load MyData config only when MyData modal is open.
  useEffect(() => {
    if (!myDataModalOpen) return;
    const myDataIntegration = integrations.find((item) => item.id === 'mydata');
    if (!myDataIntegration || myDataIntegration.status === 'disconnected') {
      setMyDataConfig({});
      setMyDataConfigError('MyData not configured');
      return;
    }
    fetchMyDataConfig();
  }, [myDataModalOpen, fetchMyDataConfig, integrations]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refetchModules();
      await fetchIntegrations();
      toast.success(t('integrations.refreshSuccess', 'Plugins refreshed'));
    } catch (err) {
      toast.error(t('integrations.refreshError', 'Failed to refresh plugins'));
    } finally {
      setIsRefreshing(false);
    }
  }, [refetchModules, fetchIntegrations, t]);

  const loadTerminals = useCallback(async () => {
    try {
      setTerminalsLoading(true);
      setTerminalsError(null);
      const branchId = getSetting('terminal', 'branch_id') as string | undefined;
      const endpoint = branchId ? `/pos/terminals?branchId=${branchId}` : '/pos/terminals';
      const result = await posApiGet<{ terminals?: any[] }>(endpoint);
      if (!result.success) {
        throw new Error(result.error || 'Failed to load terminals');
      }
      const terminals = (result.data?.terminals || []).map((terminal: any) => ({
        id: terminal.id || terminal.terminal_id,
        name: terminal.name || terminal.terminal_id,
        location: terminal.location || null,
      }));
      setAvailableTerminals(terminals);
    } catch (err: any) {
      setTerminalsError(err?.message || 'Failed to load terminals');
      setAvailableTerminals([]);
    } finally {
      setTerminalsLoading(false);
    }
  }, [getSetting]);

  useEffect(() => {
    if (pluginModalOpen) {
      loadTerminals();
    }
  }, [pluginModalOpen, loadTerminals]);

  // Handle toggle
  const handleToggle = useCallback(async (id: string) => {
    if (toggleAction.disabled) {
      toast.error(toggleAction.message || t('common.requiresOnline', 'This action requires an online connection.'));
      return;
    }

    const integration = integrations.find(i => i.id === id);
    if (!integration) return;

    if (integration.requiresPartnerCredentials) {
    toast(t('integrations.partnerRequiredInfo', 'This plugin requires partner credentials. Contact support to enable it.'), {
      icon: <Lock className="w-4 h-4 text-amber-500" />,
    });
      return;
    }

    if (integration.id === 'mydata') {
      if (integration.status === 'connected') {
        try {
          const result = await posApiPost('/pos/mydata/config', { status: 'inactive' });
          if (!result.success) {
            throw new Error(result.error || 'Failed to disable MyData');
          }
          setIntegrations(prev =>
            prev.map(i => i.id === id ? { ...i, status: 'disconnected', lastSyncedAt: undefined } : i)
          );
          toast.success(t('integrations.disconnectSuccess', '{{name}} disconnected', { name: integration.name }));
        } catch (err: any) {
          toast.error(err?.message || t('integrations.disconnectError', 'Failed to disconnect {{name}}', { name: integration.name }));
        }
      } else {
        setMyDataModalOpen(true);
      }
      return;
    }

    if (integration.status === 'connected') {
      try {
        const result = await posApiPost('/pos/integrations', {
          plugin_id: integration.id,
          status: 'inactive',
        });
        if (!result.success) {
          throw new Error(result.error || 'Failed to disable integration');
        }
        setIntegrations(prev =>
          prev.map(i => i.id === id ? { ...i, status: 'disconnected', lastSyncedAt: undefined } : i)
        );
        toast.success(t('integrations.disconnectSuccess', '{{name}} disconnected', { name: integration.name }));
      } catch (err: any) {
        toast.error(err?.message || t('integrations.disconnectError', 'Failed to disconnect {{name}}', { name: integration.name }));
      }
    } else {
      const defaults: PluginFormState = {
        api_key: '',
        api_secret: '',
        merchant_id: '',
        store_id: '',
        store_url: '',
        chain_id: '',
        webhook_secret: '',
        commission_pct: 20,
        auto_accept_orders: integration.settings?.auto_accept_orders ?? false,
        auto_accept_prep_minutes: integration.settings?.auto_accept_prep_minutes ?? 20,
        sync_menu: true,
        sync_availability: true,
        sync_products: true,
        sync_orders: true,
        sync_inventory: true,
        target_terminal_id: integration.settings?.target_terminal_id ?? null,
      };
      setActivePlugin(integration);
      setPluginForm(defaults);
      setPluginModalOpen(true);
    }
  }, [integrations, t, toggleAction.disabled, toggleAction.message]);

  // Handle configure
  const handleConfigure = useCallback((integration: IntegrationWithStatus) => {
    if (integration.requiresPartnerCredentials) {
      toast(t('integrations.partnerRequiredInfo', 'This plugin requires partner credentials. Contact support to enable it.'), {
        icon: <Lock className="w-4 h-4 text-amber-500" />,
      });
      return;
    }
    if (integration.id === 'mydata') {
      setMyDataModalOpen(true);
      return;
    }
    const defaults: PluginFormState = {
      api_key: '',
      api_secret: '',
      merchant_id: '',
      store_id: '',
      store_url: '',
      chain_id: '',
      webhook_secret: '',
      commission_pct: 20,
      auto_accept_orders: integration.settings?.auto_accept_orders ?? false,
      auto_accept_prep_minutes: integration.settings?.auto_accept_prep_minutes ?? 20,
      sync_menu: true,
      sync_availability: true,
      sync_products: true,
      sync_orders: true,
      sync_inventory: true,
      target_terminal_id: integration.settings?.target_terminal_id ?? null,
    };
    setActivePlugin(integration);
    setPluginForm(defaults);
    setPluginModalOpen(true);
  }, [t]);

  const handleSaveMyDataConfig = useCallback(async () => {
    if (saveMyDataAction.disabled) {
      toast.error(saveMyDataAction.message || t('common.requiresOnline', 'This action requires an online connection.'));
      return;
    }

    if (myDataConnectionType === 'usb_serial' && !myDataSerialPort.trim()) {
      toast.error(t('integrations.mydata.serialPortRequired', 'Serial port is required for USB connection'));
      return;
    }

    if (myDataConnectionType === 'bluetooth' && !myDataBluetoothAddress.trim()) {
      toast.error(t('integrations.mydata.bluetoothAddressRequired', 'Bluetooth address is required'));
      return;
    }

    setMyDataSaving(true);
    try {
      const deviceConnection =
        myDataConnectionType === 'bluetooth'
          ? { type: 'bluetooth', address: myDataBluetoothAddress.trim() }
          : { type: 'usb_serial', port: myDataSerialPort.trim(), baud_rate: Number(myDataBaudRate) || 9600 };

      const result = await posApiPost<{ config?: Record<string, any> }>(
        '/pos/mydata/config',
        { device_connection: deviceConnection, status: 'connected' }
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to save MyData configuration');
      }

      setMyDataConfig(result.data?.config || null);
      setMyDataConfigError(null);
      setIntegrations(prev =>
        prev.map(i => i.id === 'mydata'
          ? { ...i, status: 'connected', lastSyncedAt: new Date().toISOString() }
          : i
        )
      );
      toast.success(t('integrations.mydata.configSaved', 'MyData configuration saved'));
      setMyDataModalOpen(false);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save MyData configuration');
    } finally {
      setMyDataSaving(false);
    }
  }, [
    myDataBaudRate,
    myDataBluetoothAddress,
    myDataConnectionType,
    myDataSerialPort,
    saveMyDataAction.disabled,
    saveMyDataAction.message,
    t,
  ]);

  // Full myDATA setup (credentials, VAT info, activation) lives in the web Admin
  // Dashboard under Plugins -> MyData. Recomputed each time the modal opens so a
  // re-pair (which rewrites localStorage) is picked up without a page reload.
  const adminDashboardPluginsUrl = useMemo(() => {
    if (!myDataModalOpen) return '';
    let stored = '';
    try {
      stored = localStorage.getItem('admin_dashboard_url') || '';
    } catch {
      return '';
    }
    const base = normalizeAdminDashboardUrl(stored).replace(/\/+$/, '');
    return base ? `${base}/plugins` : '';
  }, [myDataModalOpen]);

  const handleOpenAdminDashboard = useCallback(async () => {
    if (!adminDashboardPluginsUrl) return;
    const opened = await openExternalUrl(adminDashboardPluginsUrl);
    if (opened) return;
    // Opener unavailable (or host not allowlisted): fall back to copying the link.
    try {
      await navigator.clipboard.writeText(adminDashboardPluginsUrl);
      toast.success(t('integrations.mydata.dashboardBanner.linkCopied', 'Link copied — paste it into a browser to open your Admin Dashboard.'));
    } catch {
      toast.error(t('integrations.mydata.dashboardBanner.openFailed', 'Could not open the browser. Dashboard address: {{url}}', { url: adminDashboardPluginsUrl }));
    }
  }, [adminDashboardPluginsUrl, t]);

  const handleSavePluginConfig = useCallback(async () => {
    if (saveAction.disabled) {
      toast.error(saveAction.message || t('common.requiresOnline', 'This action requires an online connection.'));
      return;
    }

    if (!activePlugin) return;
    const config = PLUGIN_FORM_CONFIG[activePlugin.id] || { requiredFields: [] };
    const missing = config.requiredFields.filter((field) => {
      const value = pluginForm[field as keyof PluginFormState] as string;
      return !value || value.trim().length === 0;
    });

    if (missing.length > 0) {
      toast.error(`Missing required fields: ${missing.join(', ')}`);
      return;
    }

    setPluginSaving(true);
    try {
      const credentials: Record<string, unknown> = {};
      if (pluginForm.api_key.trim()) credentials.api_key = pluginForm.api_key.trim();
      if (pluginForm.api_secret.trim()) credentials.api_secret = pluginForm.api_secret.trim();
      if (pluginForm.merchant_id.trim()) credentials.merchant_id = pluginForm.merchant_id.trim();
      if (pluginForm.store_id.trim()) credentials.store_id = pluginForm.store_id.trim();
      if (pluginForm.store_url.trim()) credentials.store_url = pluginForm.store_url.trim();
      if (pluginForm.chain_id.trim()) credentials.chain_id = pluginForm.chain_id.trim();
      if (pluginForm.webhook_secret.trim()) credentials.webhook_secret = pluginForm.webhook_secret.trim();

      if (config.supportsCommission) {
        credentials.commission_pct = pluginForm.commission_pct;
      }
      if (config.supportsMenuSync) {
        credentials.sync_menu = pluginForm.sync_menu;
      }
      if (config.supportsAvailabilitySync) {
        credentials.sync_availability = pluginForm.sync_availability;
      }
      if (config.supportsProductSync) {
        credentials.sync_products = pluginForm.sync_products;
      }
      if (config.supportsOrderSync) {
        credentials.sync_orders = pluginForm.sync_orders;
      }
      if (config.supportsInventorySync) {
        credentials.sync_inventory = pluginForm.sync_inventory;
      }

      const payload: Record<string, unknown> = {
        plugin_id: activePlugin.id,
        status: 'connected',
        auto_accept_orders: pluginForm.auto_accept_orders,
        auto_accept_prep_minutes: pluginForm.auto_accept_prep_minutes,
        target_terminal_id: pluginForm.target_terminal_id || null,
      };
      if (Object.keys(credentials).length > 0) {
        payload.credentials = credentials;
      }

      const result = await posApiPost('/pos/integrations', payload);
      if (!result.success) {
        throw new Error(result.error || 'Failed to save plugin configuration');
      }

      setIntegrations(prev =>
        prev.map(i => i.id === activePlugin.id
          ? {
              ...i,
              status: 'connected',
              lastSyncedAt: new Date().toISOString(),
              settings: {
                auto_accept_orders: pluginForm.auto_accept_orders,
                auto_accept_prep_minutes: pluginForm.auto_accept_prep_minutes,
                target_terminal_id: pluginForm.target_terminal_id || null,
              },
            }
          : i
        )
      );
      toast.success(t('integrations.saveSuccess', '{{name}} configured', { name: activePlugin.name }));
      setPluginModalOpen(false);
      setActivePlugin(null);
    } catch (err: any) {
      toast.error(err?.message || t('integrations.saveError', 'Failed to save configuration'));
    } finally {
      setPluginSaving(false);
    }
  }, [activePlugin, pluginForm, saveAction.disabled, saveAction.message, t]);

  // Group integrations by category
  const groupedIntegrations = useMemo(() => {
    const groups: Record<IntegrationCategory, IntegrationWithStatus[]> = {
      delivery: [],
      hotel: [],
      government: [],
      payment: [],
      analytics: [],
      ecommerce: [],
      communications: [],
      other: [],
    };

    integrations.forEach(integration => {
      if (groups[integration.category]) {
        groups[integration.category].push(integration);
      }
    });

    // Filter out empty categories
    return Object.entries(groups).filter(([_, items]) => items.length > 0) as [IntegrationCategory, IntegrationWithStatus[]][];
  }, [integrations]);

  // Calculate stats
  const stats = useMemo(() => calculateStats(integrations), [integrations]);
  const isInitialPageLoading = !hasLoadedIntegrations && (loading || modulesLoading);

  // Loading state
  if (isInitialPageLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-black' : 'bg-[#fdfaf5]'}`}>
        <div className="text-center">
          <Loader2 className={`w-8 h-8 animate-spin mx-auto mb-3 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('integrations.loading', 'Loading plugins...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={pageMotionContainer}
      className={`min-h-screen ${isDark ? 'bg-black' : 'bg-[#fdfaf5]'}`}
    >
      {/* Content */}
      <motion.div variants={pageMotionContainer} className="max-w-6xl mx-auto p-4">
        {/* Header + Stats Card */}
        <motion.div
          variants={pageMotionItem}
          className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('integrations.title', 'Plugins')}
              </h1>
              <p className={`mt-1 truncate text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {t('integrations.subtitle', 'Connect third-party plugins')}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3">
              {/* Online Status */}
              <div className={`flex items-center gap-2 ${
                isOnline
                  ? isDark ? 'text-green-400' : 'text-green-600'
                  : isDark ? 'text-red-400' : 'text-red-600'
              }`}>
                {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
                <span className="text-xs font-medium">
                  {isOnline ? t('common.online', 'Online') : t('common.offline', 'Offline')}
                </span>
              </div>

              {/* Refresh Button */}
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isRefreshing || !isOnline}
                aria-label={t('common.refresh', 'Refresh')}
                className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all ${
                  isDark
                    ? 'border border-amber-400/30 bg-amber-500/15 text-amber-300 active:bg-amber-500/25'
                    : 'border border-amber-400/40 bg-amber-50 text-amber-600 active:bg-amber-100'
                } ${isRefreshing || !isOnline ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
              >
                <RefreshCw
                  size={20}
                  className={isRefreshing ? 'animate-spin' : ''}
                />
              </button>
            </div>
          </div>

          {/* Stats */}
          <motion.div variants={pageMotionContainer} className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatsCard
              label={t('integrations.stats.total', 'Total')}
              value={stats.total}
              icon={Plug}
              color="#facc15"
              isDark={isDark}
            />
            <StatsCard
              label={t('integrations.stats.connected', 'Connected')}
              value={stats.connected}
              icon={CheckCircle}
              color="#22c55e"
              isDark={isDark}
            />
            <StatsCard
              label={t('integrations.stats.disconnected', 'Disconnected')}
              value={stats.disconnected}
              icon={XCircle}
              color="#ef4444"
              isDark={isDark}
            />
            <StatsCard
              label={t('integrations.stats.pending', 'Pending')}
              value={stats.pending}
              icon={AlertCircle}
              color="#f59e0b"
              isDark={isDark}
            />
          </motion.div>
        </motion.div>

        {/* Error State */}
        {error && (
          <motion.div variants={pageMotionItem} className={`p-4 rounded-2xl mb-6 ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'}`}>
            <div className="flex items-center gap-3">
              <AlertCircle className="text-red-500" size={20} />
              <div>
                <p className={`font-medium ${isDark ? 'text-red-400' : 'text-red-700'}`}>
              {t('integrations.error', 'Error loading plugins')}
                </p>
                <p className={`text-sm ${isDark ? 'text-red-400/70' : 'text-red-600'}`}>
                  {error}
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {/* Empty State */}
        {groupedIntegrations.length === 0 && !error && (
          <motion.div variants={pageMotionItem} className={`text-center py-12 rounded-2xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
            <Plug size={48} className={`mx-auto mb-4 ${isDark ? 'text-zinc-600' : 'text-gray-400'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('integrations.empty.title', 'No purchased plugins')}
            </h3>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('integrations.empty.description', 'Purchased plugins assigned to this organization will appear here.')}
            </p>
          </motion.div>
        )}

        {/* Integration Categories */}
        <motion.div variants={pageMotionContainer}>
          {groupedIntegrations.map(([category, categoryIntegrations]) => (
            <CategorySection
              key={category}
              category={category}
              integrations={categoryIntegrations}
              isDark={isDark}
              toggleDisabledMessage={toggleAction.message}
              onToggle={handleToggle}
              onConfigure={handleConfigure}
            />
          ))}
        </motion.div>
      </motion.div>

        {/* MyData Configuration Modal */}
        <LiquidGlassModal
          isOpen={myDataModalOpen}
          onClose={() => setMyDataModalOpen(false)}
          title={t('integrations.mydata.title', 'MyData Configuration')}
          size="md"
          className="!max-w-lg"
          closeOnBackdrop={!myDataSaving}
          closeOnEscape={!myDataSaving}
        >
        <div className="space-y-4">
            <div className={`rounded-2xl p-3 text-sm ${isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'}`}>
              <div className="font-medium">
                {t('integrations.mydata.dashboardBanner.title', 'myDATA setup happens in the Admin Dashboard')}
              </div>
              <p className={`mt-1 text-xs ${isDark ? 'text-amber-200/80' : 'text-amber-700/90'}`}>
                {t(
                  'integrations.mydata.dashboardBanner.body',
                  'Receipts are sent to the tax office (AADE) automatically once myDATA is set up. The setup itself (credentials, VAT info, activation) is done in your Admin Dashboard: open Plugins → MyData and follow the steps. This screen is only needed if you connect a fiscal printer (ΦΗΜ) to this till.'
                )}
              </p>
              {adminDashboardPluginsUrl && (
                <div className="mt-2">
                  <POSGlassButton
                    variant="warning"
                    icon={<ExternalLink size={16} />}
                    onClick={handleOpenAdminDashboard}
                  >
                    {t('integrations.mydata.dashboardBanner.openButton', 'Open Admin Dashboard')}
                  </POSGlassButton>
                </div>
              )}
            </div>
            {saveMyDataAction.disabled && (
              <div className={`rounded-2xl p-3 text-sm ${isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'}`}>
                {saveMyDataAction.message}
              </div>
            )}
            {myDataConfigError && (
              <div className={`rounded-2xl p-3 text-sm ${
                isMyDataMissing
                  ? (isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700')
                  : (isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700')
              }`}>
                {myDataConfigError}
                {isMyDataMissing && (
                  <div className={`mt-1 text-xs ${isDark ? 'text-amber-200/70' : 'text-amber-600'}`}>
                    {t('integrations.mydata.saveToCreate', 'Save settings to create MyData configuration for this branch.')}
                  </div>
                )}
              </div>
            )}

          <div className={`rounded-2xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
            <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('integrations.mydata.currentSetup', 'Current setup')}
            </div>
            <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('integrations.mydata.mode', 'Mode')}: {myDataConfig?.mode || t('integrations.mydata.notConfigured', 'Not configured')}
            </div>
            <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('integrations.mydata.status', 'Status')}: {myDataConfig?.status || t('integrations.mydata.unknown', 'Unknown')}
            </div>
            {myDataConfig?.environment && (
              <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {t('integrations.mydata.environment', 'Environment')}: {myDataConfig.environment}
              </div>
            )}
          </div>

          {myDataConfig?.mode && myDataConfig.mode !== 'fiscal_device' && (
            <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('integrations.mydata.deviceSettingsHelp', 'Device connection settings are required only when using a fiscal device.')}
            </div>
          )}

          <div className="space-y-3">
            <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('integrations.mydata.fiscalDeviceConnection', 'Fiscal device connection')}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  {t('integrations.mydata.connectionType', 'Connection type')}
                </label>
                <select
                  value={myDataConnectionType}
                  onChange={(event) => setMyDataConnectionType(event.target.value as 'usb_serial' | 'bluetooth')}
                  className="liquid-glass-modal-input"
                  disabled={!canSaveMyData || saveMyDataAction.disabled}
                >
                  <option value="usb_serial">{t('integrations.mydata.connectionTypes.usbSerial', 'USB serial')}</option>
                  <option value="bluetooth">{t('integrations.mydata.connectionTypes.bluetooth', 'Bluetooth')}</option>
                </select>
              </div>

              {myDataConnectionType === 'usb_serial' ? (
                <POSGlassInput
                  label={t('integrations.mydata.serialPort', 'Serial port')}
                  value={myDataSerialPort}
                  onChange={(event) => setMyDataSerialPort(event.target.value)}
                  placeholder="COM3 or /dev/ttyUSB0"
                  disabled={saveMyDataAction.disabled}
                />
              ) : (
                <POSGlassInput
                  label={t('integrations.mydata.bluetoothAddress', 'Bluetooth address')}
                  value={myDataBluetoothAddress}
                  onChange={(event) => setMyDataBluetoothAddress(event.target.value)}
                  placeholder="00:11:22:33:44:55"
                  disabled={saveMyDataAction.disabled}
                />
              )}

              {myDataConnectionType === 'usb_serial' && (
                <POSGlassInput
                  label={t('integrations.mydata.baudRate', 'Baud rate')}
                  value={myDataBaudRate}
                  onChange={(event) => setMyDataBaudRate(event.target.value)}
                  placeholder="9600"
                  disabled={saveMyDataAction.disabled}
                />
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <POSGlassButton variant="secondary" onClick={() => setMyDataModalOpen(false)} disabled={myDataSaving}>
              {t('common.actions.cancel', 'Cancel')}
            </POSGlassButton>
            <POSGlassButton
              onClick={handleSaveMyDataConfig}
              loading={myDataSaving}
              disabled={!canSaveMyData || myDataSaving || saveMyDataAction.disabled}
            >
              {t('common.actions.save', 'Save')}
            </POSGlassButton>
          </div>
        </div>
        </LiquidGlassModal>

        {/* Plugin Configuration Modal */}
        <LiquidGlassModal
          isOpen={pluginModalOpen}
          onClose={() => {
            if (!pluginSaving) {
              setPluginModalOpen(false);
              setActivePlugin(null);
            }
          }}
          title={activePlugin ? `${activePlugin.name} ${t('integrations.configuration', 'Configuration')}` : t('integrations.pluginConfiguration', 'Plugin configuration')}
          size="lg"
          className="!max-w-2xl"
          closeOnBackdrop={!pluginSaving}
          closeOnEscape={!pluginSaving}
        >
          <div className="space-y-4">
            {activePlugin && (
              <>
                {saveAction.disabled && (
                  <div className={`rounded-2xl p-3 text-sm ${isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'}`}>
                    {saveAction.message}
                  </div>
                )}
                <div className={`rounded-2xl p-3 text-xs ${isDark ? 'bg-white/5 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                  {t('integrations.credentialsHelp', 'Enter the credentials provided by the platform. Leave fields blank to keep existing values.')}
                </div>

                {(() => {
                  const config = PLUGIN_FORM_CONFIG[activePlugin.id] || { requiredFields: [] };
                  const isRequired = (field: PluginFieldKey) => config.requiredFields.includes(field);
                  const fieldLabel = (field: PluginFieldKey, key: string, fallback: string) =>
                    PLUGIN_FIELD_LABELS[activePlugin.id]?.[field] ?? t(key, fallback);
                  return (
                    <>
                      {(isRequired('store_url') || activePlugin.id === 'woocommerce' || activePlugin.id === 'shopify') && (
                        <POSGlassInput
                          label={`${t('integrations.fields.storeUrl', 'Store URL')}${isRequired('store_url') ? ' *' : ''}`}
                          value={pluginForm.store_url}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, store_url: event.target.value }))}
                          placeholder={t('integrations.placeholders.storeUrl', 'https://your-store.com')}
                          disabled={saveAction.disabled}
                        />
                      )}
                      <POSGlassInput
                        label={`${fieldLabel('api_key', 'integrations.fields.apiKey', 'API Key')}${isRequired('api_key') ? ' *' : ''}`}
                        value={pluginForm.api_key}
                        onChange={(event) => setPluginForm(prev => ({ ...prev, api_key: event.target.value }))}
                        placeholder={t('integrations.placeholders.apiKey', 'Enter API key')}
                        type="password"
                        disabled={saveAction.disabled}
                      />
                      {(isRequired('api_secret') || activePlugin.id !== 'google_analytics') && (
                        <POSGlassInput
                          label={`${fieldLabel('api_secret', 'integrations.fields.apiSecret', 'API Secret')}${isRequired('api_secret') ? ' *' : ''}`}
                          value={pluginForm.api_secret}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, api_secret: event.target.value }))}
                          placeholder={t('integrations.placeholders.apiSecret', 'Enter API secret')}
                          type="password"
                          disabled={saveAction.disabled}
                        />
                      )}
                      {(isRequired('merchant_id') || ['wolt', 'booking', 'expedia', 'viva'].includes(activePlugin.id)) && (
                        <POSGlassInput
                          label={`${fieldLabel('merchant_id', 'integrations.fields.merchantId', 'Merchant ID')}${isRequired('merchant_id') ? ' *' : ''}`}
                          value={pluginForm.merchant_id}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, merchant_id: event.target.value }))}
                          placeholder={t('integrations.placeholders.merchantId', 'Merchant ID')}
                          disabled={saveAction.disabled}
                        />
                      )}
                      {(isRequired('store_id') || ['efood', 'box'].includes(activePlugin.id)) && (
                        <POSGlassInput
                          label={`${fieldLabel('store_id', 'integrations.fields.storeId', 'Store ID')}${isRequired('store_id') ? ' *' : ''}`}
                          value={pluginForm.store_id}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, store_id: event.target.value }))}
                          placeholder={t('integrations.placeholders.storeId', 'Store ID')}
                          disabled={saveAction.disabled}
                        />
                      )}

                      {(isRequired('chain_id') || isRequired('webhook_secret')) && (
                        <>
                          {isRequired('chain_id') && (
                            <POSGlassInput
                              label={`${fieldLabel('chain_id', 'integrations.fields.chainId', 'Chain ID')}${isRequired('chain_id') ? ' *' : ''}`}
                              value={pluginForm.chain_id}
                              onChange={(event) => setPluginForm(prev => ({ ...prev, chain_id: event.target.value }))}
                              placeholder={t('integrations.placeholders.chainId', 'Chain ID')}
                              disabled={saveAction.disabled}
                            />
                          )}
                          {isRequired('webhook_secret') && (
                            <POSGlassInput
                              label={`${fieldLabel('webhook_secret', 'integrations.fields.webhookSecret', 'Webhook Secret')}${isRequired('webhook_secret') ? ' *' : ''}`}
                              value={pluginForm.webhook_secret}
                              onChange={(event) => setPluginForm(prev => ({ ...prev, webhook_secret: event.target.value }))}
                              placeholder={t('integrations.placeholders.webhookSecret', 'Webhook secret')}
                              type="password"
                              disabled={saveAction.disabled}
                            />
                          )}
                        </>
                      )}

                      {config.supportsCommission && (
                        <POSGlassInput
                          label={t('integrations.fields.commission', 'Commission (%)')}
                          value={String(pluginForm.commission_pct)}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, commission_pct: Number(event.target.value || 0) }))}
                          type="number"
                          placeholder="20"
                          disabled={saveAction.disabled}
                        />
                      )}

                      {(config.supportsAutoAccept || config.supportsPrepMinutes) && (
                        <div className={`rounded-2xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                          <div className="flex items-center justify-between mb-3">
                            <div className="text-sm font-medium">
                              {t('integrations.autoAccept', 'Auto-accept orders')}
                            </div>
                            <input
                              type="checkbox"
                              checked={pluginForm.auto_accept_orders}
                              onChange={(event) => setPluginForm(prev => ({ ...prev, auto_accept_orders: event.target.checked }))}
                              disabled={saveAction.disabled}
                            />
                          </div>
                          {config.supportsPrepMinutes && (
                            <POSGlassInput
                              label={t('integrations.prepMinutes', 'Preparation time (minutes)')}
                              value={String(pluginForm.auto_accept_prep_minutes)}
                              onChange={(event) => setPluginForm(prev => ({ ...prev, auto_accept_prep_minutes: Number(event.target.value || 20) }))}
                              type="number"
                              placeholder="20"
                              disabled={saveAction.disabled}
                            />
                          )}
                        </div>
                      )}

                      <div className={`rounded-2xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                        <div className="space-y-1 mb-3">
                          <div className="text-sm font-medium">
                            {t('integrations.routingTitle', 'Order routing')}
                          </div>
                          <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            {t(
                              'integrations.routingHelp',
                              'Route external plugin orders to a specific terminal. Applies only to plugin orders.'
                            )}
                          </div>
                        </div>

                        <label className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                          {t('integrations.routingTarget', 'Target terminal')}
                        </label>
                        <select
                          className="liquid-glass-modal-input mt-2"
                          value={pluginForm.target_terminal_id || ''}
                          disabled={saveAction.disabled}
                          onChange={(event) =>
                            setPluginForm(prev => ({
                              ...prev,
                              target_terminal_id: event.target.value ? event.target.value : null,
                            }))
                          }
                        >
                          <option value="">{t('integrations.routingAll', 'All terminals')}</option>
                          {availableTerminals.map((terminal) => (
                            <option key={terminal.id} value={terminal.id}>
                              {terminal.name || terminal.id}
                              {terminal.location ? ` • ${terminal.location}` : ''}
                            </option>
                          ))}
                        </select>
                        {terminalsLoading && (
                          <div className={`mt-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            {t('integrations.routingLoading', 'Loading terminals...')}
                          </div>
                        )}
                        {terminalsError && (
                          <div className="mt-2 text-xs text-red-500">{terminalsError}</div>
                        )}
                        {!terminalsLoading && !terminalsError && availableTerminals.length === 0 && (
                          <div className={`mt-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                            {t('integrations.routingEmpty', 'No terminals found for this branch.')}
                          </div>
                        )}
                      </div>

                      {(config.supportsMenuSync || config.supportsAvailabilitySync || config.supportsProductSync || config.supportsOrderSync || config.supportsInventorySync) && (
                        <div className={`rounded-2xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                          <div className="text-sm font-medium mb-2">{t('integrations.syncOptions', 'Sync Options')}</div>
                          {config.supportsMenuSync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_menu}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_menu: event.target.checked }))}
                                disabled={saveAction.disabled}
                              />
                              {t('integrations.sync.menu', 'Sync menu')}
                            </label>
                          )}
                          {config.supportsAvailabilitySync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_availability}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_availability: event.target.checked }))}
                                disabled={saveAction.disabled}
                              />
                              {t('integrations.sync.availability', 'Sync availability')}
                            </label>
                          )}
                          {config.supportsProductSync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_products}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_products: event.target.checked }))}
                                disabled={saveAction.disabled}
                              />
                              {t('integrations.sync.products', 'Sync products')}
                            </label>
                          )}
                          {config.supportsOrderSync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_orders}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_orders: event.target.checked }))}
                                disabled={saveAction.disabled}
                              />
                              {t('integrations.sync.orders', 'Sync orders')}
                            </label>
                          )}
                          {config.supportsInventorySync && (
                            <label className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_inventory}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_inventory: event.target.checked }))}
                                disabled={saveAction.disabled}
                              />
                              {t('integrations.sync.inventory', 'Sync inventory')}
                            </label>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}

                <div className="flex justify-end gap-2 pt-2">
                  <POSGlassButton variant="secondary" onClick={() => { setPluginModalOpen(false); setActivePlugin(null); }} disabled={pluginSaving}>
                    {t('common.actions.cancel', 'Cancel')}
                  </POSGlassButton>
                  <POSGlassButton onClick={handleSavePluginConfig} loading={pluginSaving} disabled={pluginSaving || saveAction.disabled}>
                    {t('common.actions.save', 'Save')}
                  </POSGlassButton>
                </div>
              </>
            )}
          </div>
        </LiquidGlassModal>
    </motion.div>
  );
};

export default IntegrationsPage;
