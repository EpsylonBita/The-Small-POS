import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { StaffShift } from '../types';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../services/terminal-credentials';
import { getBridge, offEvent, onEvent } from '../../lib';

interface StaffData {
  staffId: string;
  name: string;
  role: string;
  branchId: string;
  terminalId: string;
  organizationId?: string;
}

interface ShiftContextType {
  staff: StaffData | null;
  activeShift: StaffShift | null;
  isShiftActive: boolean;
  setStaff: (staff: StaffData | null) => void;
  refreshActiveShift: (overrideStaffId?: string) => Promise<void>;
  setActiveShiftImmediate: (shift: StaffShift | null) => void;
  clearShift: () => void;
}

const ShiftContext = createContext<ShiftContextType | undefined>(undefined);
const INVALID_CONTEXT_VALUES = new Set([
  '',
  'default-branch',
  'default-terminal',
  'default-organization',
  'default-org',
]);

function normalizeContextValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (INVALID_CONTEXT_VALUES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

export function ShiftProvider({ children }: { children: ReactNode }) {
  const bridge = getBridge();
  const [staff, setStaffState] = useState<StaffData | null>(null);
  const [activeShift, setActiveShift] = useState<StaffShift | null>(null);

  // Load staff from localStorage on mount
  useEffect(() => {
    const storedStaff = localStorage.getItem('staff');
    if (storedStaff) {
      try {
        const parsedStaff = JSON.parse(storedStaff);
        setStaffState(parsedStaff);
      } catch (error) {
        console.error('Failed to parse stored staff data:', error);
      }
    }
  }, []);
  // Attempt to restore active shift by terminal (used on startup and when settings arrive)
  const attemptRestoreByTerminal = async (): Promise<boolean> => {
    try {
      // Resolve branchId with multiple fallbacks
      let branchId: string | null = null;
      try { branchId = await bridge.terminalConfig.getBranchId(); } catch { }
      if (!branchId) {
        try { branchId = (await bridge.terminalConfig.getSetting('terminal', 'branch_id')) as string | null; } catch { }
      }
      if (!branchId) {
        branchId = staff?.branchId
          || (() => { try { return JSON.parse(localStorage.getItem('staff') || 'null')?.branchId || null } catch { return null } })()
          || (() => { try { return JSON.parse(localStorage.getItem('pos-user') || 'null')?.branchId || null } catch { return null } })()
          || null;
      }

      // Resolve terminalId with multiple fallbacks
      let terminalId: string | null = null;
      try { terminalId = await bridge.terminalConfig.getTerminalId(); } catch { }
      if (!terminalId) {
        try { terminalId = (await bridge.terminalConfig.getSetting('terminal', 'terminal_id')) as string | null; } catch { }
      }
      if (!terminalId) {
        terminalId = staff?.terminalId
          || (() => { try { return JSON.parse(localStorage.getItem('staff') || 'null')?.terminalId || null } catch { return null } })()
          || (() => { try { return JSON.parse(localStorage.getItem('pos-user') || 'null')?.terminalId || null } catch { return null } })()
          || null;
      }

      // Resolve organizationId with multiple fallbacks
      let organizationId: string | null = null;
      try { organizationId = await bridge.terminalConfig.getOrganizationId(); } catch { }
      if (!organizationId) {
        try { organizationId = (await bridge.terminalConfig.getSetting('terminal', 'organization_id')) as string | null; } catch { }
      }
      if (!organizationId) {
        organizationId = staff?.organizationId
          || (() => { try { return JSON.parse(localStorage.getItem('staff') || 'null')?.organizationId || null } catch { return null } })()
          || null;
      }

      if (!branchId || !terminalId) {
        console.warn('[ShiftContext] attemptRestoreByTerminal: missing branch/terminal', { branchId, terminalId });
        return false;
      }

      let result = await bridge.shifts.getActiveByTerminal(branchId, terminalId);
      // Handle wrapped IPC response - extract data from { success, data } format
      let s = result?.data ?? result;

      if (!s || (result?.success === false)) {
        // Loose fallback: try by terminal only (handles branchId mismatches between local and admin)
        try {
          console.warn('[ShiftContext] attemptRestoreByTerminal: strict lookup failed; trying terminal-only fallback', { terminalId });
          const looseResult = await bridge.shifts.getActiveByTerminalLoose(terminalId);
          s = looseResult?.data ?? looseResult;
          if (s && s.status === 'active') console.log('[ShiftContext] Restored active shift by terminal (loose)', { terminalId, shiftId: s.id, branchIdFromRow: s.branch_id });
        } catch (e) {
          console.warn('[ShiftContext] terminal-only fallback failed:', e);
        }
      }
      if (s && s.status === 'active') {
        // Validate organization context if we have it
        if (organizationId && s.organization_id && organizationId !== s.organization_id) {
          console.warn('[ShiftContext] Organization mismatch - clearing shift', {
            expected: organizationId,
            found: s.organization_id
          });
          clearShift();
          return false;
        }

        console.log('[ShiftContext] Restored active shift by terminal', { branchId, terminalId, shiftId: s.id });
        setActiveShift(s);
        if (!staff) {
          setStaffState(prev => prev ?? {
            staffId: s.staff_id,
            name: (JSON.parse(localStorage.getItem('staff') || 'null')?.name) || 'Staff',
            role: s.role_type,
            branchId: s.branch_id || branchId,
            terminalId: s.terminal_id || terminalId,
            organizationId: s.organization_id || organizationId || undefined,
          });
        }
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[ShiftContext] attemptRestoreByTerminal failed:', e);
      return false;
    }
  };

  // Restore active shift from localStorage on mount and validate against DB
  useEffect(() => {
    try {
      const storedShift = localStorage.getItem('activeShift');
      if (storedShift) {
        const parsed = JSON.parse(storedShift);
        if (parsed && parsed.status === 'active') {
          setActiveShift(parsed);
          // If staff not present, derive minimal staff from stored shift so UI can operate
          if (!staff) {
            setStaffState(prev => prev ?? {
              staffId: parsed.staff_id,
              name: (JSON.parse(localStorage.getItem('staff') || 'null')?.name) || 'Staff',
              role: parsed.role_type,
              branchId: parsed.branch_id,
              terminalId: parsed.terminal_id,
            });
          }
          // Validate against local DB to ensure the shift is still active (e.g., after Z report)
          (async () => {
            try {
              // Skip validation for simple PIN login (pseudo-session)
              if (parsed.staff_id === 'local-simple-pin') {
                console.debug('[ShiftContext] Skipping shift validation for simple PIN login');
                await attemptRestoreByTerminal();
                return;
              }

              const result = await bridge.shifts.getActive(parsed.staff_id);
              // Handle wrapped IPC response - extract data from { success, data } format
              const latest = result?.data ?? result;

              if (latest && latest.status === 'active') {
                setActiveShift(latest);
              } else {
                console.warn('[ShiftContext] No active shift by staffId; trying terminal fallback...');
                const ok = await attemptRestoreByTerminal();
                if (!ok) {
                  setActiveShift(null);
                  localStorage.removeItem('activeShift');
                }
              }
            } catch (e) {
              console.warn('[ShiftContext] Active shift validation failed:', e);
              // Try terminal fallback even if validation failed
              const ok = await attemptRestoreByTerminal();
              if (!ok) {
                setActiveShift(null);
                localStorage.removeItem('activeShift');
              }
            }
          })();
        }
      } else {
        // Nothing stored, try to restore by terminal when app starts
        (async () => {
          const ok = await attemptRestoreByTerminal();
          if (!ok) {
            // leave as null; restrictions will show until check-in
          }
        })();
      }
    } catch (e) {
      console.warn('[ShiftContext] Failed to restore activeShift from localStorage', e);
    }
  }, []);

  // Persist active shift so it survives app reload/login cycles until Z report/checkout
  useEffect(() => {
    try {
      if (activeShift && activeShift.status === 'active') {
        localStorage.setItem('activeShift', JSON.stringify(activeShift));
      } else {
        localStorage.removeItem('activeShift');
      }
    } catch (e) {
      console.warn('[ShiftContext] Failed to persist activeShift', e);
    }
  }, [activeShift]);


  // Refresh active shift when staff changes
  // Do NOT clear activeShift when staff is null; shifts persist across logout until Z Report.
  useEffect(() => {
    if (staff?.staffId) {
      refreshActiveShift();
    } else {
      // Leave activeShift as-is; restoration logic (localStorage/terminal fallback) handles state
      console.debug('[ShiftContext] staff missing; preserving activeShift until Z Report');
    }
  }, [staff?.staffId]);

  // Hardening: if staff exists but organization is missing, merge from shift/terminal context.
  useEffect(() => {
    let disposed = false;

    const hydrateMissingStaffOrganization = async () => {
      if (!staff || normalizeContextValue(staff.organizationId)) {
        return;
      }

      let resolvedOrganizationId =
        normalizeContextValue((activeShift as any)?.organization_id) ||
        normalizeContextValue(getCachedTerminalCredentials().organizationId);

      if (!resolvedOrganizationId) {
        try {
          const refreshed = await refreshTerminalCredentialCache();
          resolvedOrganizationId = normalizeContextValue(refreshed.organizationId);
        } catch (error) {
          console.warn('[ShiftContext] Failed to refresh terminal identity for org hydration:', error);
        }
      }

      if (!resolvedOrganizationId || disposed) {
        return;
      }

      const mergedStaff = {
        ...staff,
        organizationId: resolvedOrganizationId,
      };
      setStaffState(mergedStaff);
      localStorage.setItem('staff', JSON.stringify(mergedStaff));
    };

    void hydrateMissingStaffOrganization();
    return () => {
      disposed = true;
    };
  }, [activeShift, staff]);

  const refreshActiveShift = async (overrideStaffId?: string) => {
    const sid = overrideStaffId || staff?.staffId;
    if (!sid) {
      setActiveShift(null);
      return;
    }

    // Skip shift query for simple PIN login (it's a pseudo-session, not a real staff shift)
    if (sid === 'local-simple-pin') {
      console.debug('[ShiftContext] Skipping shift query for simple PIN login');
      // Try terminal-based restore in case there's an actual shift active
      await attemptRestoreByTerminal();
      return;
    }

    try {
      console.log('[ShiftContext] refreshActiveShift -> querying staffId:', sid);
      const result = await bridge.shifts.getActive(sid);
      console.log('[ShiftContext] refreshActiveShift -> result:', result);

      // Handle wrapped IPC response - extract data from { success, data } format
      const shift = result?.data ?? result;

      if (!shift || (result?.success === false)) {
        console.warn('[ShiftContext] Staff appears logged in but no active shift found for staffId:', sid);
        // Attempt fallback by terminal
        const ok = await attemptRestoreByTerminal();
        if (!ok) {
          console.warn('[ShiftContext] Terminal fallback failed; preserving existing activeShift if any');
        }
        return;
      }

      // Verify shift is active
      if (shift.status !== 'active') {
        console.warn('[ShiftContext] Shift found but not active:', shift.status);
        const ok = await attemptRestoreByTerminal();
        if (!ok) {
          console.warn('[ShiftContext] Terminal fallback failed; preserving existing activeShift if any');
        }
        return;
      }

      setActiveShift(shift);
    } catch (error) {
      console.error('Failed to fetch active shift:', error);
      // Try fallback before giving up
      const ok = await attemptRestoreByTerminal();
      if (!ok) setActiveShift(null);
    }
  };

  // Re-attempt restore when terminal settings are updated (they may arrive after app start)
  useEffect(() => {
    const handleTerminalSettingsUpdated = () => {
      if (!activeShift || activeShift.status !== 'active') {
        attemptRestoreByTerminal();
      }
    };
    onEvent('terminal-settings-updated', handleTerminalSettingsUpdated);
    return () => {
      offEvent('terminal-settings-updated', handleTerminalSettingsUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShift?.id]);


  const setStaff = (newStaff: StaffData | null) => {
    setStaffState(newStaff);
    if (newStaff) {
      localStorage.setItem('staff', JSON.stringify(newStaff));
    } else {
      localStorage.removeItem('staff');
    }
  };

  const clearShift = () => {
    setStaffState(null);
    setActiveShift(null);
    localStorage.removeItem('staff');
    try { localStorage.removeItem('activeShift'); } catch { }
  };

  // Monitor terminal ID changes and clear shifts when it changes
  useEffect(() => {
    let disposed = false;

    const monitorTerminalSwitch = async () => {
      const cachedTerminalId = getCachedTerminalCredentials().terminalId || '';
      const refreshed = await refreshTerminalCredentialCache();
      const currentTerminalId = (refreshed.terminalId || cachedTerminalId || '').trim();
      if (disposed || !currentTerminalId) return;

      const lastTerminalId = localStorage.getItem('last_known_terminal_id');
      if (lastTerminalId && currentTerminalId !== lastTerminalId) {
        console.log('[ShiftContext] Terminal ID changed, clearing shifts', {
          from: lastTerminalId,
          to: currentTerminalId
        });
        clearShift();
      }

      localStorage.setItem('last_known_terminal_id', currentTerminalId);
    };

    void monitorTerminalSwitch();
    return () => { disposed = true; };
  }, []);

  const isShiftActive = activeShift !== null && activeShift.status === 'active';

  return (
    <ShiftContext.Provider
      value={{
        staff,
        activeShift,
        isShiftActive,
        setStaff,
        refreshActiveShift,
        setActiveShiftImmediate: setActiveShift,
        clearShift
      }}
    >
      {children}
    </ShiftContext.Provider>
  );
}

export function useShift() {
  const context = useContext(ShiftContext);
  if (context === undefined) {
    throw new Error('useShift must be used within a ShiftProvider');
  }
  return context;
}
