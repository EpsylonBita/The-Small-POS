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

import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
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
} from 'lucide-react';
import { getPosAuthHeaders, posApiGet, posApiPost } from '../utils/api-helpers';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { getApiUrl } from '../../config/environment';

// ============================================================
// TYPES
// ============================================================

type IntegrationCategory = 'food' | 'hotel' | 'government';

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
  // Food delivery plugins - require 'delivery' module
  {
    id: 'efood',
    name: 'e-food',
    description: 'Greece\'s leading food delivery platform',
    icon: <Pizza className="w-6 h-6" />,
    category: 'food',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'wolt',
    name: 'Wolt',
    description: 'Food delivery and discovery platform',
    icon: <Bike className="w-6 h-6" />,
    category: 'food',
    requiredModule: MODULE_IDS.DELIVERY,
  },
  {
    id: 'box',
    name: 'Box',
    description: 'Delivery platform for restaurants',
    icon: <Package className="w-6 h-6" />,
    category: 'food',
    requiredModule: MODULE_IDS.DELIVERY,
    requiresPartnerCredentials: true,
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
    id: 'mydata',
    name: 'MyData',
    description: 'Greek AADE e-invoicing compliance',
    icon: <Receipt className="w-6 h-6" />,
    category: 'government',
  },
];

const CATEGORY_CONFIG: Record<IntegrationCategory, { label: string; icon: typeof Plug }> = {
  food: { label: 'Food Platforms', icon: Truck },
  hotel: { label: 'Hotel Platforms', icon: Building2 },
  government: { label: 'Government & Compliance', icon: FileText },
};

type PluginFieldKey = 'api_key' | 'api_secret' | 'merchant_id' | 'store_id' | 'store_url';

const PLUGIN_FORM_CONFIG: Record<string, { requiredFields: PluginFieldKey[]; supportsCommission?: boolean; supportsAutoAccept?: boolean; supportsPrepMinutes?: boolean; supportsMenuSync?: boolean; supportsAvailabilitySync?: boolean; supportsProductSync?: boolean; supportsOrderSync?: boolean; supportsInventorySync?: boolean; }> = {
  efood: { requiredFields: ['api_key', 'api_secret', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  wolt: { requiredFields: ['api_key', 'api_secret', 'merchant_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  box: { requiredFields: ['api_key', 'store_id'], supportsCommission: true, supportsAutoAccept: true, supportsPrepMinutes: true, supportsMenuSync: true, supportsAvailabilitySync: true },
  booking: { requiredFields: ['api_key', 'api_secret', 'merchant_id'], supportsCommission: true },
  airbnb: { requiredFields: ['api_key', 'api_secret'], supportsCommission: true },
  expedia: { requiredFields: ['api_key', 'api_secret', 'merchant_id'], supportsCommission: true },
  tripadvisor: { requiredFields: ['api_key', 'api_secret'], supportsCommission: true },
  stripe: { requiredFields: ['api_key', 'api_secret'] },
  viva: { requiredFields: ['api_key', 'api_secret', 'merchant_id'] },
  'google-analytics': { requiredFields: ['api_key'] },
  woocommerce: { requiredFields: ['store_url', 'api_key', 'api_secret'], supportsProductSync: true, supportsOrderSync: true, supportsInventorySync: true },
  shopify: { requiredFields: ['store_url', 'api_key', 'api_secret'], supportsProductSync: true, supportsOrderSync: true, supportsInventorySync: true },
};

interface PluginFormState {
  api_key: string;
  api_secret: string;
  merchant_id: string;
  store_id: string;
  store_url: string;
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

async function fetchMyDataConfigQuietly(): Promise<MyDataConfigFetchResult> {
  try {
    const url = getApiUrl('/pos/mydata/config');
    const headers = await getPosAuthHeaders();
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error || payload?.message || `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      config: payload?.config,
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

interface IntegrationCardProps {
  integration: IntegrationWithStatus;
  isDark: boolean;
  onToggle: (id: string) => void;
  onConfigure: (integration: IntegrationWithStatus) => void;
}

const IntegrationCard = memo<IntegrationCardProps>(({
  integration,
  isDark,
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
  const isToggleDisabled = isLocked || integration.status === 'pending';
  const isEnabled = integration.status === 'connected';

  return (
    <div
      className={`relative p-4 rounded-xl border transition-all duration-200 hover:shadow-md ${
        isDark
          ? 'bg-gray-800/50 border-white/10 hover:border-white/20'
          : 'bg-white border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${
            isDark ? 'bg-white/5' : 'bg-gray-100'
          }`}
        >
          {integration.icon}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h3 className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {integration.name}
          </h3>
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {integration.description}
          </p>

          {/* Status Badge */}
          <div className="flex items-center gap-2 mt-3">
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium"
              style={{
                backgroundColor: `${statusColor}20`,
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
              className={`p-2 rounded-lg transition-colors ${
                isDark
                  ? 'hover:bg-white/10 text-gray-400 hover:text-white'
                  : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
              }`}
              title={t('integrations.configure', 'Configure')}
            >
              <Settings size={18} />
            </button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            onClick={() => !isToggleDisabled && onToggle(integration.id)}
            disabled={isToggleDisabled}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              isDark ? 'shadow-sm' : 'shadow-sm'
            } ${isEnabled ? 'liquid-glass-modal-success' : 'liquid-glass-modal-secondary'} ${isToggleDisabled ? 'opacity-50 cursor-not-allowed' : ''} liquid-glass-modal-button min-h-0 min-w-0`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform ${
                isEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className={`text-[10px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
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
    </div>
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
  onToggle: (id: string) => void;
  onConfigure: (integration: IntegrationWithStatus) => void;
}

const CategorySection = memo<CategorySectionProps>(({
  category,
  integrations,
  isDark,
  onToggle,
  onConfigure,
}) => {
  const { t } = useTranslation();
  
  const [isExpanded, setIsExpanded] = useState(true);
  const config = CATEGORY_CONFIG[category];
  const Icon = config.icon;

  const connectedCount = integrations.filter(i => i.status === 'connected').length;

  return (
    <div className="mb-6">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center justify-between p-3 rounded-lg mb-3 transition-colors ${
          isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              isDark ? 'bg-white/10' : 'bg-gray-100'
            }`}
          >
            <Icon size={16} className={isDark ? 'text-gray-300' : 'text-gray-600'} />
          </div>
          <div className="text-left">
            <h2 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t(`integrations.category.${category}`, config.label)}
            </h2>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {connectedCount}/{integrations.length} {t('integrations.connected', 'connected')}
            </p>
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp size={20} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
        ) : (
          <ChevronDown size={20} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
        )}
      </button>

      {isExpanded && (
        <div className="grid gap-3 sm:grid-cols-1 lg:grid-cols-2">
          {integrations.map(integration => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              isDark={isDark}
              onToggle={onToggle}
              onConfigure={onConfigure}
            />
          ))}
        </div>
      )}
    </div>
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
  <div
    className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}
  >
    <div className="flex items-center gap-3">
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: `${color}20` }}
      >
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
  </div>
));

StatsCard.displayName = 'StatsCard';

// ============================================================
// MAIN PAGE COMPONENT
// ============================================================

export const IntegrationsPage: React.FC = () => {
  const { t } = useTranslation();
  
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const { hasModule, isLoading: modulesLoading, refetch: refetchModules } = useAcquiredModules();
  const { getSetting } = useTerminalSettings();
  // State
  const [integrations, setIntegrations] = useState<IntegrationWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Filter integrations based on enabled modules
  const filteredIntegrations = useMemo(() => {
    return ALL_INTEGRATIONS.filter(integration => {
      if (!integration.requiredModule) return true;
      return hasModule(integration.requiredModule);
    });
  }, [hasModule]);

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
      try {
        setLoading(true);
        setError(null);

        const integrationsResult = await posApiGet<{ integrations?: any[] }>('/pos/integrations');
        const remoteIntegrations = integrationsResult.success ? (integrationsResult.data?.integrations || []) : [];
        const remoteMap = new Map(remoteIntegrations.map((item: any) => [item.provider, item]));

        // Map to IntegrationWithStatus
        const integrationsWithStatus: IntegrationWithStatus[] = filteredIntegrations.map(integration => {
          const remote = remoteMap.get(integration.id);
          const remoteStatus = remote?.status;
          const mappedStatus = remoteStatus === 'connected'
            ? 'connected'
            : remoteStatus === 'pending' || remoteStatus === 'error'
            ? 'pending'
            : remoteStatus === 'inactive'
            ? 'disconnected'
            : (remote?.is_active ? 'connected' : 'disconnected');

          return {
            ...integration,
            status: integration.requiresPartnerCredentials
              ? 'pending'
              : mappedStatus,
            lastSyncedAt: typeof remote?.last_sync_at === 'string' ? remote.last_sync_at : undefined,
            settings: remote?.settings || undefined,
          };
        });

        setIntegrations(integrationsWithStatus);
      } catch (err) {
        console.error('Failed to fetch integrations:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch integrations');
        // Still show integrations as disconnected
        setIntegrations(filteredIntegrations.map(i => ({ ...i, status: 'disconnected' })));
      } finally {
        setLoading(false);
      }
    }, [filteredIntegrations]);

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
  }, [integrations, t]);

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
    if (myDataConnectionType === 'usb_serial' && !myDataSerialPort.trim()) {
      toast.error('Serial port is required for USB connection');
      return;
    }

    if (myDataConnectionType === 'bluetooth' && !myDataBluetoothAddress.trim()) {
      toast.error('Bluetooth address is required');
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
      toast.success('MyData configuration saved');
      setMyDataModalOpen(false);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save MyData configuration');
    } finally {
      setMyDataSaving(false);
    }
  }, [myDataBaudRate, myDataBluetoothAddress, myDataConnectionType, myDataSerialPort]);

  const handleSavePluginConfig = useCallback(async () => {
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
  }, [activePlugin, pluginForm, t]);

  // Group integrations by category
  const groupedIntegrations = useMemo(() => {
    const groups: Record<IntegrationCategory, IntegrationWithStatus[]> = {
      food: [],
      hotel: [],
      government: [],
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

  // Loading state
  if (loading || modulesLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        <div className="text-center">
          <Loader2 className={`w-8 h-8 animate-spin mx-auto mb-3 ${isDark ? 'text-blue-400' : 'text-blue-500'}`} />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('integrations.loading', 'Loading plugins...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className={`sticky top-0 z-10 px-4 py-4 border-b ${isDark ? 'bg-gray-900/95 border-white/10' : 'bg-white/95 border-gray-200'} backdrop-blur-sm`}>
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                  isDark ? 'bg-purple-500/20' : 'bg-purple-100'
                }`}
              >
                <Plug size={24} className="text-purple-500" />
              </div>
              <div>
                <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('integrations.title', 'Plugins')}
                </h1>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {t('integrations.subtitle', 'Connect third-party plugins')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Online Status */}
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${
                isOnline
                  ? isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-600'
                  : isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-600'
              }`}>
                {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
                <span className="text-xs font-medium">
                  {isOnline ? t('common.online', 'Online') : t('common.offline', 'Offline')}
                </span>
              </div>

              {/* Refresh Button */}
              <button
                onClick={handleRefresh}
                disabled={isRefreshing || !isOnline}
                className={`p-2 rounded-lg transition-colors disabled:opacity-50 ${
                  isDark
                    ? 'hover:bg-white/10 text-gray-300'
                    : 'hover:bg-gray-100 text-gray-600'
                }`}
              >
                <RefreshCw
                  size={20}
                  className={isRefreshing ? 'animate-spin' : ''}
                />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto p-4">
        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatsCard
            label={t('integrations.stats.total', 'Total')}
            value={stats.total}
            icon={Plug}
            color="#6366f1"
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
            color="#6b7280"
            isDark={isDark}
          />
          <StatsCard
            label={t('integrations.stats.pending', 'Pending')}
            value={stats.pending}
            icon={AlertCircle}
            color="#f59e0b"
            isDark={isDark}
          />
        </div>

        {/* Error State */}
        {error && (
          <div className={`p-4 rounded-xl mb-6 ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'}`}>
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
          </div>
        )}

        {/* Empty State */}
        {groupedIntegrations.length === 0 && !error && (
          <div className={`text-center py-12 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}>
            <Plug size={48} className={`mx-auto mb-4 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} />
            <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('integrations.empty.title', 'No plugins available')}
            </h3>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('integrations.empty.description', 'Enable modules to unlock plugins')}
            </p>
          </div>
        )}

        {/* Integration Categories */}
        {groupedIntegrations.map(([category, categoryIntegrations]) => (
          <CategorySection
            key={category}
            category={category}
            integrations={categoryIntegrations}
            isDark={isDark}
            onToggle={handleToggle}
            onConfigure={handleConfigure}
          />
        ))}

        {/* Coming Soon Notice */}
        {groupedIntegrations.length > 0 && (
          <div className={`p-6 rounded-xl text-center ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}>
            <AlertCircle size={32} className={`mx-auto mb-3 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
            <h3 className={`font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('integrations.comingSoon.title', 'More plugins coming soon')}
            </h3>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('integrations.comingSoon.description', 'We\'re working on adding more plugins.')}
            </p>
          </div>
        )}
      </div>

        {/* MyData Configuration Modal */}
        <LiquidGlassModal
          isOpen={myDataModalOpen}
          onClose={() => setMyDataModalOpen(false)}
          title={t('integrations.mydata.title', 'MyData Configuration')}
          size="md"
          closeOnBackdrop={!myDataSaving}
          closeOnEscape={!myDataSaving}
        >
        <div className="space-y-4">
            {myDataConfigError && (
              <div className={`rounded-lg p-3 text-sm ${
                isMyDataMissing
                  ? (isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700')
                  : (isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700')
              }`}>
                {myDataConfigError}
                {isMyDataMissing && (
                  <div className={`mt-1 text-xs ${isDark ? 'text-amber-200/70' : 'text-amber-600'}`}>
                    Save settings to create MyData configuration for this branch.
                  </div>
                )}
              </div>
            )}

          <div className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
            <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Current Setup
            </div>
            <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Mode: {myDataConfig?.mode || 'Not configured'}
            </div>
            <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Status: {myDataConfig?.status || 'Unknown'}
            </div>
            {myDataConfig?.environment && (
              <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                Environment: {myDataConfig.environment}
              </div>
            )}
          </div>

          {myDataConfig?.mode && myDataConfig.mode !== 'fiscal_device' && (
            <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Device connection settings are required only when using a fiscal device.
            </div>
          )}

          <div className="space-y-3">
            <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Fiscal Device Connection
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Connection Type
                </label>
                <select
                  value={myDataConnectionType}
                  onChange={(event) => setMyDataConnectionType(event.target.value as 'usb_serial' | 'bluetooth')}
                  className="liquid-glass-modal-input"
                  disabled={!canSaveMyData}
                >
                  <option value="usb_serial">USB Serial</option>
                  <option value="bluetooth">Bluetooth</option>
                </select>
              </div>

              {myDataConnectionType === 'usb_serial' ? (
                <POSGlassInput
                  label="Serial Port"
                  value={myDataSerialPort}
                  onChange={(event) => setMyDataSerialPort(event.target.value)}
                  placeholder="COM3 or /dev/ttyUSB0"
                />
              ) : (
                <POSGlassInput
                  label="Bluetooth Address"
                  value={myDataBluetoothAddress}
                  onChange={(event) => setMyDataBluetoothAddress(event.target.value)}
                  placeholder="00:11:22:33:44:55"
                />
              )}

              {myDataConnectionType === 'usb_serial' && (
                <POSGlassInput
                  label="Baud Rate"
                  value={myDataBaudRate}
                  onChange={(event) => setMyDataBaudRate(event.target.value)}
                  placeholder="9600"
                />
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <POSGlassButton variant="secondary" onClick={() => setMyDataModalOpen(false)} disabled={myDataSaving}>
              Cancel
            </POSGlassButton>
            <POSGlassButton
              onClick={handleSaveMyDataConfig}
              loading={myDataSaving}
              disabled={!canSaveMyData || myDataSaving}
            >
              Save
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
          title={activePlugin ? `${activePlugin.name} Configuration` : 'Plugin Configuration'}
          size="lg"
          closeOnBackdrop={!pluginSaving}
          closeOnEscape={!pluginSaving}
        >
          <div className="space-y-4">
            {activePlugin && (
              <>
                <div className={`rounded-lg p-3 text-xs ${isDark ? 'bg-white/5 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                  Enter the credentials provided by the platform. Leave fields blank to keep existing values.
                </div>

                {(() => {
                  const config = PLUGIN_FORM_CONFIG[activePlugin.id] || { requiredFields: [] };
                  const isRequired = (field: PluginFieldKey) => config.requiredFields.includes(field);
                  return (
                    <>
                      {(isRequired('store_url') || activePlugin.id === 'woocommerce' || activePlugin.id === 'shopify') && (
                        <POSGlassInput
                          label={`Store URL${isRequired('store_url') ? ' *' : ''}`}
                          value={pluginForm.store_url}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, store_url: event.target.value }))}
                          placeholder="https://your-store.com"
                        />
                      )}
                      <POSGlassInput
                        label={`API Key${isRequired('api_key') ? ' *' : ''}`}
                        value={pluginForm.api_key}
                        onChange={(event) => setPluginForm(prev => ({ ...prev, api_key: event.target.value }))}
                        placeholder="Enter API key"
                        type="password"
                      />
                      {(isRequired('api_secret') || activePlugin.id !== 'google-analytics') && (
                        <POSGlassInput
                          label={`API Secret${isRequired('api_secret') ? ' *' : ''}`}
                          value={pluginForm.api_secret}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, api_secret: event.target.value }))}
                          placeholder="Enter API secret"
                          type="password"
                        />
                      )}
                      {(isRequired('merchant_id') || ['wolt', 'booking', 'expedia', 'viva'].includes(activePlugin.id)) && (
                        <POSGlassInput
                          label={`Merchant ID${isRequired('merchant_id') ? ' *' : ''}`}
                          value={pluginForm.merchant_id}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, merchant_id: event.target.value }))}
                          placeholder="Merchant ID"
                        />
                      )}
                      {(isRequired('store_id') || ['efood', 'box'].includes(activePlugin.id)) && (
                        <POSGlassInput
                          label={`Store ID${isRequired('store_id') ? ' *' : ''}`}
                          value={pluginForm.store_id}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, store_id: event.target.value }))}
                          placeholder="Store ID"
                        />
                      )}

                      {config.supportsCommission && (
                        <POSGlassInput
                          label="Commission (%)"
                          value={String(pluginForm.commission_pct)}
                          onChange={(event) => setPluginForm(prev => ({ ...prev, commission_pct: Number(event.target.value || 0) }))}
                          type="number"
                          placeholder="20"
                        />
                      )}

                      {(config.supportsAutoAccept || config.supportsPrepMinutes) && (
                        <div className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                          <div className="flex items-center justify-between mb-3">
                            <div className="text-sm font-medium">
                              {t('integrations.autoAccept', 'Auto-accept orders')}
                            </div>
                            <input
                              type="checkbox"
                              checked={pluginForm.auto_accept_orders}
                              onChange={(event) => setPluginForm(prev => ({ ...prev, auto_accept_orders: event.target.checked }))}
                            />
                          </div>
                          {config.supportsPrepMinutes && (
                            <POSGlassInput
                              label={t('integrations.prepMinutes', 'Preparation time (minutes)')}
                              value={String(pluginForm.auto_accept_prep_minutes)}
                              onChange={(event) => setPluginForm(prev => ({ ...prev, auto_accept_prep_minutes: Number(event.target.value || 20) }))}
                              type="number"
                              placeholder="20"
                            />
                          )}
                        </div>
                      )}

                      <div className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
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
                        <div className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                          <div className="text-sm font-medium mb-2">{t('integrations.syncOptions', 'Sync Options')}</div>
                          {config.supportsMenuSync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_menu}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_menu: event.target.checked }))}
                              />
                              Sync menu
                            </label>
                          )}
                          {config.supportsAvailabilitySync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_availability}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_availability: event.target.checked }))}
                              />
                              Sync availability
                            </label>
                          )}
                          {config.supportsProductSync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_products}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_products: event.target.checked }))}
                              />
                              Sync products
                            </label>
                          )}
                          {config.supportsOrderSync && (
                            <label className="flex items-center gap-2 text-xs mb-2">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_orders}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_orders: event.target.checked }))}
                              />
                              Sync orders
                            </label>
                          )}
                          {config.supportsInventorySync && (
                            <label className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={pluginForm.sync_inventory}
                                onChange={(event) => setPluginForm(prev => ({ ...prev, sync_inventory: event.target.checked }))}
                              />
                              Sync inventory
                            </label>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}

                <div className="flex justify-end gap-2 pt-2">
                  <POSGlassButton variant="secondary" onClick={() => { setPluginModalOpen(false); setActivePlugin(null); }} disabled={pluginSaving}>
                    Cancel
                  </POSGlassButton>
                  <POSGlassButton onClick={handleSavePluginConfig} loading={pluginSaving} disabled={pluginSaving}>
                    Save
                  </POSGlassButton>
                </div>
              </>
            )}
          </div>
        </LiquidGlassModal>
      </div>
    );
  };

export default IntegrationsPage;
