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

export function useFeatures() {
  const bridge = getBridge();
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const [terminalType, setTerminalType] = useState<TerminalType | null>(null);
  const [parentTerminalId, setParentTerminalId] = useState<string | null>(null);
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
      const config = await bridge.terminalConfig.getFullConfig();

      console.log('[useFeatures] Loaded config:', config);

      if (config) {
        const resolvedTerminalTypeValue = config.terminal_type || config.terminalType || null;
        const resolvedTerminalType = isTerminalType(resolvedTerminalTypeValue)
          ? resolvedTerminalTypeValue
          : null;
        const resolvedParentTerminalId =
          config.parent_terminal_id || config.parentTerminalId || null;
        const loadedFeatures = config.enabled_features || config.features || {};

        const mergedFeatures = {
          ...DEFAULT_FEATURES,
          ...mapServerToLocal<FeatureFlags>(
            loadedFeatures,
            FEATURE_KEY_MAPPING as Record<string, keyof FeatureFlags>
          ),
        };

        setTerminalType(resolvedTerminalType);
        setParentTerminalId(resolvedParentTerminalId);
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
      if (isTerminalType(nextTerminalType) || nextTerminalType === null) {
        setTerminalType(nextTerminalType);
      }
      const nextParentTerminalId = data?.parent_terminal_id ?? data?.parentTerminalId;
      if (nextParentTerminalId !== undefined) {
        setParentTerminalId(nextParentTerminalId);
      }
      const nextFeatures = data?.enabled_features ?? data?.features;
      if (nextFeatures) {
        setFeatures(() => ({
          ...DEFAULT_FEATURES,
          ...mapServerToLocal<FeatureFlags>(
            nextFeatures,
            FEATURE_KEY_MAPPING as Record<string, keyof FeatureFlags>
          ),
        }));
      }
    };

    // Subscribe to terminal config updates
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      mounted = false;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, [loadFeatures]);

  // Mapping logic moved to shared/feature-mapping.ts to avoid drift between main and renderer

  return {
    // Feature flags
    features,

    // Terminal type and parent
    terminalType,
    parentTerminalId,

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
