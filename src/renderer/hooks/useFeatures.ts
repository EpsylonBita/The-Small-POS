import { useCallback, useEffect, useState } from 'react';

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
 * Default features for main POS terminal (all features enabled)
 */
const DEFAULT_FEATURES: FeatureFlags = {
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

export function useFeatures() {
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
      const config = await (window as any).electronAPI?.ipcRenderer?.invoke(
        'terminal-config:get-full-config'
      );

      console.log('[useFeatures] Loaded config:', config);

      if (config) {
        setTerminalType(config.terminalType || 'main');
        setParentTerminalId(config.parentTerminalId || null);

        // Merge loaded features with defaults to ensure all keys exist
        // If features object is empty or missing keys, defaults will fill them in
        const loadedFeatures = config.features || {};
        const mergedFeatures = {
          ...DEFAULT_FEATURES, // Start with all defaults enabled
          ...loadedFeatures,   // Override with any loaded features
        };

        console.log('[useFeatures] Merged features:', mergedFeatures);
        setFeatures(mergedFeatures);
      } else {
        // No config returned, use defaults
        console.log('[useFeatures] No config, using defaults');
        setFeatures(DEFAULT_FEATURES);
      }
    } catch (e: any) {
      console.error('[useFeatures] Failed to load features:', e);
      setError(e?.message || 'Failed to load features');
      // Keep default features on error
      setFeatures(DEFAULT_FEATURES);
    } finally {
      setLoading(false);
    }
  }, []);

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

      if (data?.terminal_type) {
        setTerminalType(data.terminal_type);
      }
      if (data?.parent_terminal_id !== undefined) {
        setParentTerminalId(data.parent_terminal_id);
      }
      if (data?.enabled_features) {
        // Merge with existing features using shared mapping
        setFeatures((prev) => ({
          ...prev,
          ...mapServerToLocal<FeatureFlags>(data.enabled_features, FEATURE_KEY_MAPPING as Record<string, keyof FeatureFlags>),
        }));
      }
    };

    // Subscribe to terminal config updates
    const unsubscribe = (window as any).electronAPI?.ipcRenderer?.on?.(
      'terminal-config-updated',
      (_event: any, data: any) => handleConfigUpdate(data)
    );

    return () => {
      mounted = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
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
    isMainTerminal: terminalType === 'main' || terminalType === null,

    // Loading state
    loading,
    error,

    // Refresh function
    refresh,
  };
}

export default useFeatures;
