import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { StaffShift } from '../types';

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

export function ShiftProvider({ children }: { children: ReactNode }) {
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
      try { branchId = await (window as any).electronAPI?.getTerminalBranchId?.(); } catch { }
      if (!branchId) {
        try { branchId = await (window as any).electronAPI?.getTerminalSetting?.('terminal', 'branch_id'); } catch { }
      }
      if (!branchId) {
        branchId = staff?.branchId
          || (() => { try { return JSON.parse(localStorage.getItem('staff') || 'null')?.branchId || null } catch { return null } })()
          || (() => { try { return JSON.parse(localStorage.getItem('pos-user') || 'null')?.branchId || null } catch { return null } })()
          || null;
      }

      // Resolve terminalId with multiple fallbacks
      let terminalId: string | null = null;
      try { terminalId = await (window as any).electronAPI?.getTerminalId?.(); } catch { }
      if (!terminalId) {
        try { terminalId = await (window as any).electronAPI?.getTerminalSetting?.('terminal', 'terminal_id'); } catch { }
      }
      if (!terminalId) {
        terminalId = staff?.terminalId
          || (() => { try { return JSON.parse(localStorage.getItem('staff') || 'null')?.terminalId || null } catch { return null } })()
          || (() => { try { return JSON.parse(localStorage.getItem('pos-user') || 'null')?.terminalId || null } catch { return null } })()
          || null;
      }

      // Resolve organizationId with multiple fallbacks
      let organizationId: string | null = null;
      try { organizationId = await (window as any).electronAPI?.getTerminalOrganizationId?.(); } catch { }
      if (!organizationId) {
        try { organizationId = await (window as any).electronAPI?.getTerminalSetting?.('terminal', 'organization_id'); } catch { }
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

      let result = await (window as any).electronAPI?.getActiveShiftByTerminal?.(branchId, terminalId);
      // Handle wrapped IPC response - extract data from { success, data } format
      let s = result?.data ?? result;

      if (!s || (result?.success === false)) {
        // Loose fallback: try by terminal only (handles branchId mismatches between local and admin)
        try {
          console.warn('[ShiftContext] attemptRestoreByTerminal: strict lookup failed; trying terminal-only fallback', { terminalId });
          const looseResult = await (window as any).electronAPI?.getActiveShiftByTerminalLoose?.(terminalId);
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

              const result = await (window as any).electronAPI?.getActiveShift?.(parsed.staff_id);
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
      const result = await (window as any).electronAPI.getActiveShift(sid);
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
    const unsubscribe = (window as any).electronAPI?.onTerminalSettingsUpdated?.(() => {
      if (!activeShift || activeShift.status !== 'active') {
        attemptRestoreByTerminal();
      }
    });
    return () => {
      try { unsubscribe && unsubscribe(); } catch { }
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
    const currentTerminalId = localStorage.getItem('terminal_id');
    const lastTerminalId = localStorage.getItem('last_known_terminal_id');

    if (currentTerminalId && lastTerminalId && currentTerminalId !== lastTerminalId) {
      console.log('[ShiftContext] Terminal ID changed, clearing shifts', {
        from: lastTerminalId,
        to: currentTerminalId
      });
      clearShift();
    }

    // Update last known terminal ID
    if (currentTerminalId) {
      localStorage.setItem('last_known_terminal_id', currentTerminalId);
    }
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

