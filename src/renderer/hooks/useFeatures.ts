import { useCallback, useEffect, useState } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';

/**
 * Feature flags interface
 * Defines which features are enabled/disabled for a terminal
 */
export interface FeatureFlags {
  cashDrawer: boolean;
  zReportExecution: boolean;
  cashPayments: boolean;
  cardPayments: boolean;
  orderCreation: boolean;
  orderModification: boolean;
  discounts: boolean;
  refunds: boolean;
  expenses: boolean;
  staffPayments: boolean;
  reports: boolean;
  settings: boolean;
  [key: string]: boolean | undefined;
}

/**
 * Terminal type
 */
export type TerminalType = 'main' | 'mobile_waiter';

/**
 * Terminal configuration interface
 */
export interface TerminalConfig {
  terminalType: TerminalType | null;
  parentTerminalId: string | null;
  ownerTerminalId: string | null;
  ownerTerminalDbId: string | null;
  sourceTerminalId: string | null;
  sourceTerminalDbId: string | null;
  posOperatingMode: string | null;
  features: FeatureFlags;
}

/**
 * Default features for unknown terminal state (all features disabled until
 * authoritative terminal config is loaded).
 */
const DEFAULT_FEATURES: FeatureFlags = {
  cashDrawer: false,
  zReportExecution: false,
  cashPayments: false,
  cardPayments: false,
  orderCreation: false,
  orderModification: false,
  discounts: false,
  refunds: false,
  expenses: false,
  staffPayments: false,
  reports: false,
  settings: false,
};

const DEFAULT_FEATURES_BY_TERMINAL_TYPE: Record<TerminalType, FeatureFlags> = {
  main: {
    cashDrawer: true,
    zReportExecution: true,
    cashPayments: true,
    cardPayments: true,
    orderCreation: true,
    orderModification: true,
    discounts: true,
    refunds: true,
    expenses: true,
    staffPayments: true,
    reports: true,
    settings: true,
  },
  mobile_waiter: {
    cashDrawer: false,
    zReportExecution: false,
    cashPayments: true,
    cardPayments: true,
    orderCreation: true,
    orderModification: true,
    discounts: false,
    refunds: false,
    expenses: false,
    staffPayments: false,
    reports: false,
    settings: false,
  },
};

let terminalFeatureRecoveryPromise: Promise<Record<string, unknown> | null> | null = null;

/**
 * useFeatures Hook
 *
 * Provides access to terminal feature flags and configuration.
 * Used for conditional rendering based on terminal type (main vs mobile waiter).
 *
 * @example
 * ```tsx
 * const { features, terminalType, isFeatureEnabled, isMobileWaiter } = useFeatures();
 *
 * if (!isFeatureEnabled('cashDrawer')) {
 *   return <DisabledFeatureMessage feature="Cash Drawer" />;
 * }
 *
 * if (isMobileWaiter) {
 *   return <MobileWaiterUI />;
 * }
 * ```
 */
import { FEATURE_KEY_MAPPING, mapServerFeaturesToLocal as mapServerToLocal } from '../../shared/feature-mapping';

function isTerminalType(value: unknown): value is TerminalType {
  return value === 'main' || value === 'mobile_waiter';
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function getBooleanFeature(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (hasOwn(source, key) && typeof source[key] === 'boolean') {
      return source[key] as boolean;
    }
  }

  return undefined;
}

function getFallbackPaymentDefaults(
  terminalType: TerminalType | null
): Pick<FeatureFlags, 'cashPayments' | 'cardPayments'> {
  return terminalType
    ? DEFAULT_FEATURES_BY_TERMINAL_TYPE[terminalType]
    : DEFAULT_FEATURES_BY_TERMINAL_TYPE.main;
}

function getFallbackFeatureDefaults(terminalType: TerminalType | null): FeatureFlags | null {
  return terminalType ? DEFAULT_FEATURES_BY_TERMINAL_TYPE[terminalType] : null;
}

function hasKnownPaymentFeatureSource(rawFeatures: Record<string, unknown>): boolean {
  return (
    getBooleanFeature(rawFeatures, ['cash_payments', 'cashPayments']) !== undefined ||
    getBooleanFeature(rawFeatures, ['card_payments', 'cardPayments']) !== undefined ||
    getBooleanFeature(rawFeatures, ['payment_processing', 'paymentProcessing']) !== undefined
  );
}

function extractRuntimeConfig(config: unknown): {
  rawConfig: Record<string, unknown>;
  terminalType: TerminalType | null;
  parentTerminalId: string | null;
  ownerTerminalId: string | null;
  ownerTerminalDbId: string | null;
  sourceTerminalId: string | null;
  sourceTerminalDbId: string | null;
  posOperatingMode: string | null;
  loadedFeatures: Record<string, unknown>;
} | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }

  const rawConfig = config as Record<string, unknown>;
  const resolvedTerminalTypeValue = rawConfig.terminal_type || rawConfig.terminalType || null;
  const terminalType = isTerminalType(resolvedTerminalTypeValue)
    ? resolvedTerminalTypeValue
    : null;
  const parentTerminalId =
    typeof rawConfig.parent_terminal_id === 'string'
      ? rawConfig.parent_terminal_id
      : typeof rawConfig.parentTerminalId === 'string'
        ? rawConfig.parentTerminalId
        : null;
  const ownerTerminalId =
    typeof rawConfig.owner_terminal_id === 'string'
      ? rawConfig.owner_terminal_id
      : typeof rawConfig.ownerTerminalId === 'string'
        ? rawConfig.ownerTerminalId
        : null;
  const ownerTerminalDbId =
    typeof rawConfig.owner_terminal_db_id === 'string'
      ? rawConfig.owner_terminal_db_id
      : typeof rawConfig.ownerTerminalDbId === 'string'
        ? rawConfig.ownerTerminalDbId
        : null;
  const sourceTerminalId =
    typeof rawConfig.source_terminal_id === 'string'
      ? rawConfig.source_terminal_id
      : typeof rawConfig.sourceTerminalId === 'string'
        ? rawConfig.sourceTerminalId
        : null;
  const sourceTerminalDbId =
    typeof rawConfig.source_terminal_db_id === 'string'
      ? rawConfig.source_terminal_db_id
      : typeof rawConfig.sourceTerminalDbId === 'string'
        ? rawConfig.sourceTerminalDbId
        : null;
  const posOperatingMode =
    typeof rawConfig.pos_operating_mode === 'string'
      ? rawConfig.pos_operating_mode
      : typeof rawConfig.posOperatingMode === 'string'
        ? rawConfig.posOperatingMode
        : null;
  const enabledFeaturesCandidate = rawConfig.enabled_features ?? rawConfig.features;
  const loadedFeatures =
    enabledFeaturesCandidate &&
    typeof enabledFeaturesCandidate === 'object' &&
    !Array.isArray(enabledFeaturesCandidate)
      ? enabledFeaturesCandidate as Record<string, unknown>
      : {};

  return {
    rawConfig,
    terminalType,
    parentTerminalId,
    ownerTerminalId,
    ownerTerminalDbId,
    sourceTerminalId,
    sourceTerminalDbId,
    posOperatingMode,
    loadedFeatures,
  };
}

function shouldRecoverTerminalFeatures(
  rawConfig: Record<string, unknown>,
  rawFeatures: Record<string, unknown>,
  terminalType: TerminalType | null,
  resolvedFeatures: FeatureFlags
): boolean {
  const syncHealth = rawConfig.sync_health;
  const hasFeaturePayload = Object.keys(rawFeatures).length > 0;
  const hasPaymentFeatureSource = hasKnownPaymentFeatureSource(rawFeatures);
  const noPaymentsAvailable = !resolvedFeatures.cashPayments && !resolvedFeatures.cardPayments;

  return (
    !hasFeaturePayload ||
    !hasPaymentFeatureSource ||
    (!terminalType && noPaymentsAvailable) ||
    ((syncHealth === 'stale' || syncHealth === 'offline') && noPaymentsAvailable)
  );
}

async function recoverTerminalRuntimeConfig(
  bridge: ReturnType<typeof getBridge>
): Promise<Record<string, unknown> | null> {
  if (!terminalFeatureRecoveryPromise) {
    terminalFeatureRecoveryPromise = (async () => {
      try {
        const syncResult = await bridge.terminalConfig.syncFromAdmin();
        const directSyncResult = syncResult as { config?: Record<string, unknown> } | null;
        const syncedConfigCandidate = directSyncResult?.config ?? syncResult?.data?.config;
        if (syncedConfigCandidate && typeof syncedConfigCandidate === 'object' && !Array.isArray(syncedConfigCandidate)) {
          return syncedConfigCandidate as Record<string, unknown>;
        }

        const refreshedConfig = await bridge.terminalConfig.getFullConfig();
        if (refreshedConfig && typeof refreshedConfig === 'object' && !Array.isArray(refreshedConfig)) {
          return refreshedConfig as Record<string, unknown>;
        }
      } catch (error) {
        console.warn('[useFeatures] Failed to recover terminal config from admin:', error);
      }

      return null;
    })().finally(() => {
      terminalFeatureRecoveryPromise = null;
    });
  }

  return terminalFeatureRecoveryPromise;
}

function resolveFeatureFlags(
  rawFeatures: Record<string, unknown>,
  terminalType: TerminalType | null
): FeatureFlags {
  const mappedFeatures = {
    ...DEFAULT_FEATURES,
    ...mapServerToLocal<FeatureFlags>(
      rawFeatures as Record<string, boolean>,
      FEATURE_KEY_MAPPING as Record<string, keyof FeatureFlags>
    ),
  };

  const fallbackFeatureDefaults = getFallbackFeatureDefaults(terminalType);
  const fallbackPaymentDefaults = getFallbackPaymentDefaults(terminalType);
  const explicitCashDrawer = getBooleanFeature(rawFeatures, ['cash_drawer', 'cashDrawer', 'receipt_printing']);
  const explicitZReportExecution = getBooleanFeature(rawFeatures, ['z_report_execution', 'zReportExecution']);
  const hasExplicitCash = hasOwn(rawFeatures, 'cash_payments') || hasOwn(rawFeatures, 'cashPayments');
  const hasExplicitCard = hasOwn(rawFeatures, 'card_payments') || hasOwn(rawFeatures, 'cardPayments');
  const legacyPaymentProcessing = getBooleanFeature(rawFeatures, ['payment_processing', 'paymentProcessing']);
  const explicitOrderCreation = getBooleanFeature(rawFeatures, ['order_creation', 'orderCreation', 'table_management']);
  const explicitOrderModification = getBooleanFeature(rawFeatures, ['order_modification', 'orderModification']);
  const explicitDiscounts = getBooleanFeature(rawFeatures, ['discounts']);
  const explicitRefunds = getBooleanFeature(rawFeatures, ['refunds']);
  const explicitExpenses = getBooleanFeature(rawFeatures, ['expenses']);
  const explicitStaffPayments = getBooleanFeature(rawFeatures, ['staff_payments', 'staffPayments', 'staff_management']);
  const explicitReports = getBooleanFeature(rawFeatures, ['reports', 'reportsView', 'reports_view', 'inventory_view']);
  const explicitSettings = getBooleanFeature(rawFeatures, ['settings', 'settingsAccess', 'settings_access']);

  return {
    ...mappedFeatures,
    cashDrawer: explicitCashDrawer ?? fallbackFeatureDefaults?.cashDrawer ?? mappedFeatures.cashDrawer,
    zReportExecution:
      explicitZReportExecution ?? fallbackFeatureDefaults?.zReportExecution ?? mappedFeatures.zReportExecution,
    cashPayments: hasExplicitCash
      ? mappedFeatures.cashPayments
      : legacyPaymentProcessing ?? fallbackPaymentDefaults.cashPayments,
    cardPayments: hasExplicitCard
      ? mappedFeatures.cardPayments
      : legacyPaymentProcessing ?? fallbackPaymentDefaults.cardPayments,
    orderCreation: explicitOrderCreation ?? fallbackFeatureDefaults?.orderCreation ?? mappedFeatures.orderCreation,
    orderModification:
      explicitOrderModification ?? fallbackFeatureDefaults?.orderModification ?? mappedFeatures.orderModification,
    discounts: explicitDiscounts ?? fallbackFeatureDefaults?.discounts ?? mappedFeatures.discounts,
    refunds: explicitRefunds ?? fallbackFeatureDefaults?.refunds ?? mappedFeatures.refunds,
    expenses: explicitExpenses ?? fallbackFeatureDefaults?.expenses ?? mappedFeatures.expenses,
    staffPayments: explicitStaffPayments ?? fallbackFeatureDefaults?.staffPayments ?? mappedFeatures.staffPayments,
    reports: explicitReports ?? fallbackFeatureDefaults?.reports ?? mappedFeatures.reports,
    settings: explicitSettings ?? fallbackFeatureDefaults?.settings ?? mappedFeatures.settings,
  };
}

export function useFeatures() {
  const bridge = getBridge();
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const [terminalType, setTerminalType] = useState<TerminalType | null>(null);
  const [parentTerminalId, setParentTerminalId] = useState<string | null>(null);
  const [ownerTerminalId, setOwnerTerminalId] = useState<string | null>(null);
  const [ownerTerminalDbId, setOwnerTerminalDbId] = useState<string | null>(null);
  const [sourceTerminalId, setSourceTerminalId] = useState<string | null>(null);
  const [sourceTerminalDbId, setSourceTerminalDbId] = useState<string | null>(null);
  const [posOperatingMode, setPosOperatingMode] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Load features from main process via IPC
   */
  const loadFeatures = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Get full terminal configuration
      const initialConfig = await bridge.terminalConfig.getFullConfig();

      console.log('[useFeatures] Loaded config:', initialConfig);

      let extractedConfig = extractRuntimeConfig(initialConfig);

      if (extractedConfig) {
        let {
          rawConfig,
          terminalType: resolvedTerminalType,
          parentTerminalId: resolvedParentTerminalId,
          ownerTerminalId: resolvedOwnerTerminalId,
          ownerTerminalDbId: resolvedOwnerTerminalDbId,
          sourceTerminalId: resolvedSourceTerminalId,
          sourceTerminalDbId: resolvedSourceTerminalDbId,
          posOperatingMode: resolvedPosOperatingMode,
          loadedFeatures,
        } = extractedConfig;
        let mergedFeatures = resolveFeatureFlags(loadedFeatures, resolvedTerminalType);

        if (shouldRecoverTerminalFeatures(rawConfig, loadedFeatures, resolvedTerminalType, mergedFeatures)) {
          const recoveredConfig = await recoverTerminalRuntimeConfig(bridge);
          const recoveredRuntimeConfig = extractRuntimeConfig(recoveredConfig);
          if (recoveredRuntimeConfig) {
            console.log('[useFeatures] Recovered config from admin sync:', recoveredConfig);
            rawConfig = recoveredRuntimeConfig.rawConfig;
            resolvedTerminalType = recoveredRuntimeConfig.terminalType;
            resolvedParentTerminalId = recoveredRuntimeConfig.parentTerminalId;
            resolvedOwnerTerminalId = recoveredRuntimeConfig.ownerTerminalId;
            resolvedOwnerTerminalDbId = recoveredRuntimeConfig.ownerTerminalDbId;
            resolvedSourceTerminalId = recoveredRuntimeConfig.sourceTerminalId;
            resolvedSourceTerminalDbId = recoveredRuntimeConfig.sourceTerminalDbId;
            resolvedPosOperatingMode = recoveredRuntimeConfig.posOperatingMode;
            loadedFeatures = recoveredRuntimeConfig.loadedFeatures;
            mergedFeatures = resolveFeatureFlags(loadedFeatures, resolvedTerminalType);
          }
        }

        setTerminalType(resolvedTerminalType);
        setParentTerminalId(resolvedParentTerminalId);
        setOwnerTerminalId(resolvedOwnerTerminalId);
        setOwnerTerminalDbId(resolvedOwnerTerminalDbId);
        setSourceTerminalId(resolvedSourceTerminalId);
        setSourceTerminalDbId(resolvedSourceTerminalDbId);
        setPosOperatingMode(resolvedPosOperatingMode);
        console.log('[useFeatures] Merged features:', mergedFeatures);
        setFeatures(mergedFeatures);
      } else {
        console.log('[useFeatures] No config, keeping fail-closed defaults');
        setFeatures(DEFAULT_FEATURES);
      }
    } catch (e: any) {
      console.error('[useFeatures] Failed to load features:', e);
      setError(e?.message || 'Failed to load features');
      setFeatures(DEFAULT_FEATURES);
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  /**
   * Refresh features (call after settings sync)
   */
  const refresh = useCallback(async () => {
    await loadFeatures();
  }, [loadFeatures]);

  /**
   * Check if a specific feature is enabled
   */
  // Treat unknown flags as disabled to align with main FeatureService.isFeatureEnabled default
  const isFeatureEnabled = useCallback(
    (feature: keyof FeatureFlags): boolean => {
      return features[feature] ?? false;
    },
    [features]
  );

  // Load features on mount
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (mounted) {
        await loadFeatures();
      }
    };

    init();

    // Listen for terminal config updates from main process
    const handleConfigUpdate = (data: any) => {
      if (!mounted) return;

      console.log('[useFeatures] Terminal config updated:', data);

      const nextTerminalType = data?.terminal_type ?? data?.terminalType ?? null;
      const resolvedTerminalType = isTerminalType(nextTerminalType)
        ? nextTerminalType
        : terminalType;
      if (isTerminalType(nextTerminalType) || nextTerminalType === null) {
        setTerminalType(nextTerminalType);
      }
      const nextParentTerminalId = data?.parent_terminal_id ?? data?.parentTerminalId;
      if (nextParentTerminalId !== undefined) {
        setParentTerminalId(nextParentTerminalId);
      }
      const nextOwnerTerminalId = data?.owner_terminal_id ?? data?.ownerTerminalId;
      if (nextOwnerTerminalId !== undefined) {
        setOwnerTerminalId(nextOwnerTerminalId);
      }
      const nextOwnerTerminalDbId = data?.owner_terminal_db_id ?? data?.ownerTerminalDbId;
      if (nextOwnerTerminalDbId !== undefined) {
        setOwnerTerminalDbId(nextOwnerTerminalDbId);
      }
      const nextSourceTerminalId = data?.source_terminal_id ?? data?.sourceTerminalId;
      if (nextSourceTerminalId !== undefined) {
        setSourceTerminalId(nextSourceTerminalId);
      }
      const nextSourceTerminalDbId = data?.source_terminal_db_id ?? data?.sourceTerminalDbId;
      if (nextSourceTerminalDbId !== undefined) {
        setSourceTerminalDbId(nextSourceTerminalDbId);
      }
      const nextPosOperatingMode = data?.pos_operating_mode ?? data?.posOperatingMode;
      if (nextPosOperatingMode !== undefined) {
        setPosOperatingMode(nextPosOperatingMode);
      }
      const nextFeatures = data?.enabled_features ?? data?.features;
      if (nextFeatures) {
        setFeatures(() => resolveFeatureFlags(nextFeatures, resolvedTerminalType));
      }
    };

    // Subscribe to terminal config updates
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      mounted = false;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, [loadFeatures, terminalType]);

  // Mapping logic moved to shared/feature-mapping.ts to avoid drift between main and renderer

  return {
    // Feature flags
    features,

    // Terminal type and parent
    terminalType,
    parentTerminalId,
    ownerTerminalId,
    ownerTerminalDbId,
    sourceTerminalId,
    sourceTerminalDbId,
    posOperatingMode,

    // Convenience checks
    isFeatureEnabled,
    isMobileWaiter: terminalType === 'mobile_waiter',
    isMainTerminal: terminalType === 'main',

    // Loading state
    loading,
    error,

    // Refresh function
    refresh,
  };
}

export default useFeatures;
