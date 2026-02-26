import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { offEvent, onEvent } from '../../lib';
import { useModules } from '../contexts/module-context';
import { useShift } from '../contexts/shift-context';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../services/terminal-credentials';

export type RequiredPosIdentity = 'branch' | 'organization' | 'branch+organization';

type IdentityKind = 'branch' | 'organization' | 'terminal';

interface IdentityState {
  branchId: string | null;
  organizationId: string | null;
  terminalId: string | null;
}

interface MissingIdentity {
  branch: boolean;
  organization: boolean;
}

const DEFAULT_PLACEHOLDERS = new Set([
  '',
  'default-branch',
  'default-terminal',
  'default-organization',
  'default-org',
]);
const IDENTITY_REFRESH_TIMEOUT_MS = 1600;

function normalizeIdentityValue(value: unknown, kind: IdentityKind): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (DEFAULT_PLACEHOLDERS.has(normalized)) {
    return null;
  }

  if (kind === 'branch' && normalized === 'default') {
    return null;
  }

  return trimmed;
}

export function useResolvedPosIdentity(required: RequiredPosIdentity) {
  const { staff } = useShift();
  const { organizationId: moduleOrganizationId } = useModules();
  const [identity, setIdentity] = useState<IdentityState>({
    branchId: null,
    organizationId: null,
    terminalId: null,
  });
  const [isResolving, setIsResolving] = useState(true);
  const latestResolveRef = useRef(0);

  const resolveIdentity = useCallback(
    async (forceRefresh = false, blockIfMissing = true) => {
      const resolveToken = Date.now();
      latestResolveRef.current = resolveToken;
      if (!blockIfMissing) {
        setIsResolving(false);
      }

      let branchId = normalizeIdentityValue(staff?.branchId, 'branch');
      let organizationId =
        normalizeIdentityValue(staff?.organizationId, 'organization') ||
        normalizeIdentityValue(moduleOrganizationId, 'organization');
      let terminalId = normalizeIdentityValue(staff?.terminalId, 'terminal');

      const cached = getCachedTerminalCredentials();
      branchId = branchId || normalizeIdentityValue(cached.branchId, 'branch');
      organizationId =
        organizationId || normalizeIdentityValue(cached.organizationId, 'organization');
      terminalId = terminalId || normalizeIdentityValue(cached.terminalId, 'terminal');

      const missingRequiredBranch = required !== 'organization' && !branchId;
      const missingRequiredOrganization = required !== 'branch' && !organizationId;
      const shouldBlockResolve = missingRequiredBranch || missingRequiredOrganization;
      const shouldRefresh = forceRefresh || missingRequiredBranch || missingRequiredOrganization;

      // Keep current data visible during background refreshes when required identity already exists.
      if (blockIfMissing && shouldBlockResolve) {
        setIsResolving(true);
      }

      if (latestResolveRef.current !== resolveToken) {
        return;
      }

      setIdentity({
        branchId,
        organizationId,
        terminalId,
      });

      if (!shouldRefresh) {
        setIsResolving(false);
        return;
      }

      try {
        const refreshed = await Promise.race([
          refreshTerminalCredentialCache(),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), IDENTITY_REFRESH_TIMEOUT_MS)
          ),
        ]);

        if (refreshed) {
          branchId = branchId || normalizeIdentityValue(refreshed.branchId, 'branch');
          organizationId =
            organizationId || normalizeIdentityValue(refreshed.organizationId, 'organization');
          terminalId = terminalId || normalizeIdentityValue(refreshed.terminalId, 'terminal');
        }
      } catch (error) {
        console.warn('[useResolvedPosIdentity] Failed to refresh terminal identity:', error);
      }

      if (latestResolveRef.current !== resolveToken) {
        return;
      }

      setIdentity({
        branchId,
        organizationId,
        terminalId,
      });
      setIsResolving(false);
    },
    [moduleOrganizationId, required, staff?.branchId, staff?.organizationId, staff?.terminalId]
  );

  useEffect(() => {
    void resolveIdentity(false, true);
  }, [resolveIdentity]);

  useEffect(() => {
    const handleIdentityUpdate = () => {
      void resolveIdentity(true, false);
    };

    onEvent('terminal-config-updated', handleIdentityUpdate);
    onEvent('terminal-settings-updated', handleIdentityUpdate);

    return () => {
      offEvent('terminal-config-updated', handleIdentityUpdate);
      offEvent('terminal-settings-updated', handleIdentityUpdate);
    };
  }, [resolveIdentity]);

  const missing = useMemo<MissingIdentity>(
    () => ({
      branch: !identity.branchId,
      organization: !identity.organizationId,
    }),
    [identity.branchId, identity.organizationId]
  );

  const isReady = useMemo(() => {
    if (required === 'branch') {
      return !missing.branch;
    }
    if (required === 'organization') {
      return !missing.organization;
    }
    return !missing.branch && !missing.organization;
  }, [missing.branch, missing.organization, required]);

  const refresh = useCallback(async () => {
    await resolveIdentity(true, true);
  }, [resolveIdentity]);

  return {
    branchId: identity.branchId,
    organizationId: identity.organizationId,
    terminalId: identity.terminalId,
    isResolving,
    missing,
    isReady,
    refresh,
  };
}
