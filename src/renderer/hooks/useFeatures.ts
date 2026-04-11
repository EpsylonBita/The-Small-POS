import { useCallback, useEffect, useState } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';

// Shared imports — single source of truth
import type { PosFeatureFlags, TerminalType } from '../../../../shared/types/pos-features';
import { DEFAULT_FEATURES } from '../../../../shared/types/pos-features';
import {
  extractRuntimeConfig,
  resolveFeatureFlags,
  shouldRecoverTerminalFeatures,
  executeFeatureRecovery,
  type FeatureRecoveryAdapter,
} from '../../../../shared/pos/feature-recovery';

// Re-export for backward compatibility
export type { PosFeatureFlags as FeatureFlags, TerminalType };

function isTerminalType(value: unknown): value is TerminalType {
  return value === 'main' || value === 'mobile_waiter';
}

/**
 * useFeatures Hook
 *
 * Provides access to terminal feature flags and configuration.
 * Uses shared feature resolution and recovery logic from shared/.
 */
export function useFeatures() {
  const bridge = getBridge();
  const [features, setFeatures] = useState<PosFeatureFlags>(DEFAULT_FEATURES);
  const [terminalType, setTerminalType] = useState<TerminalType | null>(null);
  const [parentTerminalId, setParentTerminalId] = useState<string | null>(null);
  const [ownerTerminalId, setOwnerTerminalId] = useState<string | null>(null);
  const [ownerTerminalDbId, setOwnerTerminalDbId] = useState<string | null>(null);
  const [sourceTerminalId, setSourceTerminalId] = useState<string | null>(null);
  const [sourceTerminalDbId, setSourceTerminalDbId] = useState<string | null>(null);
  const [posOperatingMode, setPosOperatingMode] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /** Desktop-specific recovery adapter using Tauri bridge */
  const createRecoveryAdapter = useCallback((): FeatureRecoveryAdapter => ({
    async syncFromAdmin() {
      try {
        const syncResult = await bridge.terminalConfig.syncFromAdmin();
        const directSyncResult = syncResult as { config?: Record<string, unknown> } | null;
        const syncedConfig = directSyncResult?.config ?? syncResult?.data?.config;
        if (syncedConfig && typeof syncedConfig === 'object' && !Array.isArray(syncedConfig)) {
          return syncedConfig as Record<string, unknown>;
        }
      } catch {
        // Let shared recovery handle the fallback
      }
      return null;
    },
    async getFullConfig() {
      const config = await bridge.terminalConfig.getFullConfig();
      if (config && typeof config === 'object' && !Array.isArray(config)) {
        return config as Record<string, unknown>;
      }
      return null;
    },
  }), [bridge]);

  const loadFeatures = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const initialConfig = await bridge.terminalConfig.getFullConfig();
      console.log('[useFeatures] Loaded config:', initialConfig);

      let extracted = extractRuntimeConfig(initialConfig);

      if (extracted) {
        let mergedFeatures = resolveFeatureFlags(extracted.loadedFeatures, extracted.terminalType);

        if (shouldRecoverTerminalFeatures(extracted.rawConfig, extracted.loadedFeatures, extracted.terminalType, mergedFeatures)) {
          const recoveredConfig = await executeFeatureRecovery(createRecoveryAdapter());
          const recoveredExtracted = extractRuntimeConfig(recoveredConfig);
          if (recoveredExtracted) {
            console.log('[useFeatures] Recovered config from admin sync:', recoveredConfig);
            extracted = recoveredExtracted;
            mergedFeatures = resolveFeatureFlags(extracted.loadedFeatures, extracted.terminalType);
          }
        }

        setTerminalType(extracted.terminalType);
        setParentTerminalId(extracted.parentTerminalId);
        setOwnerTerminalId(extracted.ownerTerminalId);
        setOwnerTerminalDbId(extracted.ownerTerminalDbId);
        setSourceTerminalId(extracted.sourceTerminalId);
        setSourceTerminalDbId(extracted.sourceTerminalDbId);
        setPosOperatingMode(extracted.posOperatingMode);
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
  }, [bridge, createRecoveryAdapter]);

  const refresh = useCallback(async () => {
    await loadFeatures();
  }, [loadFeatures]);

  const isFeatureEnabled = useCallback(
    (feature: keyof PosFeatureFlags): boolean => {
      return features[feature] ?? false;
    },
    [features],
  );

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (mounted) {
        await loadFeatures();
      }
    };

    init();

    const handleConfigUpdate = (data: any) => {
      if (!mounted) return;

      console.log('[useFeatures] Terminal config updated:', data);

      const nextTerminalType = data?.terminal_type ?? data?.terminalType ?? null;
      const resolvedType = isTerminalType(nextTerminalType) ? nextTerminalType : terminalType;
      if (isTerminalType(nextTerminalType) || nextTerminalType === null) {
        setTerminalType(nextTerminalType);
      }
      const nextParentTerminalId = data?.parent_terminal_id ?? data?.parentTerminalId;
      if (nextParentTerminalId !== undefined) setParentTerminalId(nextParentTerminalId);
      const nextOwnerTerminalId = data?.owner_terminal_id ?? data?.ownerTerminalId;
      if (nextOwnerTerminalId !== undefined) setOwnerTerminalId(nextOwnerTerminalId);
      const nextOwnerTerminalDbId = data?.owner_terminal_db_id ?? data?.ownerTerminalDbId;
      if (nextOwnerTerminalDbId !== undefined) setOwnerTerminalDbId(nextOwnerTerminalDbId);
      const nextSourceTerminalId = data?.source_terminal_id ?? data?.sourceTerminalId;
      if (nextSourceTerminalId !== undefined) setSourceTerminalId(nextSourceTerminalId);
      const nextSourceTerminalDbId = data?.source_terminal_db_id ?? data?.sourceTerminalDbId;
      if (nextSourceTerminalDbId !== undefined) setSourceTerminalDbId(nextSourceTerminalDbId);
      const nextPosOperatingMode = data?.pos_operating_mode ?? data?.posOperatingMode;
      if (nextPosOperatingMode !== undefined) setPosOperatingMode(nextPosOperatingMode);
      const nextFeatures = data?.enabled_features ?? data?.features;
      if (nextFeatures) {
        setFeatures(() => resolveFeatureFlags(nextFeatures, resolvedType));
      }
    };

    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      mounted = false;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, [loadFeatures, terminalType]);

  return {
    features,
    terminalType,
    parentTerminalId,
    ownerTerminalId,
    ownerTerminalDbId,
    sourceTerminalId,
    sourceTerminalDbId,
    posOperatingMode,
    isFeatureEnabled,
    isMobileWaiter: terminalType === 'mobile_waiter',
    isMainTerminal: terminalType === 'main',
    loading,
    error,
    refresh,
  };
}

export default useFeatures;
