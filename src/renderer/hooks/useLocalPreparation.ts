import { useEffect, useSyncExternalStore } from 'react';
import { localPreparationStore, type LocalPreparationSnapshot } from '../services/KdsLocalPhaseStore';
import { useResolvedPosIdentity } from './useResolvedPosIdentity';

/** The shared local kitchen stage snapshot (KDS, central order views, customer display). */
export function useLocalPreparationSnapshot(): LocalPreparationSnapshot {
  return useSyncExternalStore(
    localPreparationStore.subscribe,
    localPreparationStore.getSnapshot,
    localPreparationStore.getSnapshot
  );
}

/**
 * Mounted once at app level and the only caller of `configure`: hydrates this
 * terminal's kitchen stages from local SQLite at startup, restart and sign-in,
 * even when no KDS page is open, and clears them on sign-out. Local IPC only.
 */
export function LocalPreparationScopeSync(): null {
  const { organizationId, branchId, terminalId, isReady } = useResolvedPosIdentity('branch');
  const scope = isReady && organizationId && branchId && terminalId ? `${organizationId}|${branchId}|${terminalId}` : '';
  useEffect(() => {
    localPreparationStore.configure(scope);
  }, [scope]);
  useEffect(() => () => localPreparationStore.configure(''), []);
  return null;
}
