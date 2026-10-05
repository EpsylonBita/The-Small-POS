import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';
import { useShift } from '../contexts/shift-context';
import { getCachedTerminalCredentials } from '../services/terminal-credentials';
import { resolveActiveCashierShift } from '../utils/active-cashier';
import type { StaffShift } from '../types';

export const CASHIER_DAY_POLL_MS = 30_000;
export const CASHIER_DAY_EVENTS = ['shift-updated', 'sync:complete', 'terminal-settings-updated', 'terminal-config-updated'];

export function useCashierDayGate(options: { isMobileWaiter?: boolean; parentTerminalId?: string | null; ready?: boolean } = {}) {
  const { staff, activeShift } = useShift();
  const snapshot = useRef(activeShift);
  snapshot.current = activeShift;
  const identity = getCachedTerminalCredentials();
  const branchId = identity.branchId || staff?.branchId || null;
  const terminalId = identity.terminalId || staff?.terminalId || null;
  const scope = [branchId, terminalId, options.isMobileWaiter, options.parentTerminalId].join(':');
  const [state, setState] = useState({ scope, branchId, isBlocked: true, isResolving: true });
  const generation = useRef(0);
  const closedDayInvalidation = useRef(false);
  const governingShiftId = useRef<string | null>(null);
  const ownShiftVersion = `${activeShift?.id}:${activeShift?.status}`;
  const lastOwnShiftVersion = useRef(ownShiftVersion);
  const mounted = useRef(false);
  const runCheck = useCallback(async (invalidate = false) => {
    const request = ++generation.current;
    if (invalidate) setState(previous => ({ ...previous,
      isBlocked: previous.scope === scope ? previous.isBlocked : true, isResolving: true }));
    try {
      if (options.ready === false) return;
      const bridge = getBridge();
      const currentBranch = branchId || await bridge.terminalConfig.getBranchId();
      const currentTerminal = terminalId || await bridge.terminalConfig.getTerminalId();
      let shift: StaffShift | null = null;
      if (currentBranch && currentTerminal) {
        if (options.isMobileWaiter && !options.parentTerminalId) {
          // Legacy pairing: preserve the branch day policy until a parent is known.
          try {
            const response: unknown = await bridge.shifts.getActiveForBranch(currentBranch);
            const rows = (response as { data?: StaffShift[] } | null)?.data ?? response;
            shift = (Array.isArray(rows) ? rows : []).find(candidate =>
              candidate.status === 'active' && ['cashier', 'manager'].includes(candidate.role_type) &&
              candidate.branch_id === currentBranch) ?? null;
          } catch {
            const cached = closedDayInvalidation.current ? null : snapshot.current;
            shift = cached?.status === 'active' && ['cashier', 'manager'].includes(cached.role_type) &&
              cached.branch_id === currentBranch ? cached : null;
          }
        } else {
          shift = await resolveActiveCashierShift({
            branchId: currentBranch,
            terminalId: options.isMobileWaiter ? options.parentTerminalId : currentTerminal,
            activeShift: closedDayInvalidation.current ? null : snapshot.current,
            logContext: 'CashierDayGate',
          });
        }
      }
      if (mounted.current && request === generation.current) {
        governingShiftId.current = shift?.id || null;
        if (shift) closedDayInvalidation.current = false;
        setState({ scope, branchId: currentBranch, isBlocked: !shift, isResolving: false });
      }
    } catch (error) {
      console.warn('[CashierDayGate] Day lookup unavailable:', error);
      if (mounted.current && request === generation.current) {
        setState(previous => ({ scope, branchId, isBlocked: previous.scope === scope ? previous.isBlocked : true, isResolving: false }));
      }
    }
  }, [branchId, terminalId, scope, options.ready, options.isMobileWaiter, options.parentTerminalId]);

  useEffect(() => {
    mounted.current = true;
    void runCheck(true);
    const invalidate = () => { void runCheck(true); };
    const poll = () => { void runCheck(); };
    const handlers = CASHIER_DAY_EVENTS.map(event => {
      const handler = event === 'shift-updated' ? (payload: { status?: string; shiftId?: string; terminalId?: string; branchId?: string; roleType?: string } | undefined) => {
        const matchesScope = (!payload?.branchId || payload.branchId === branchId) &&
          (!payload?.terminalId || payload.terminalId === (options.isMobileWaiter ? options.parentTerminalId : terminalId));
        const qualifies = !payload?.roleType || ['cashier', 'manager'].includes(payload.roleType);
        if (payload?.status === 'closed' && qualifies &&
            (payload.shiftId === governingShiftId.current || matchesScope)) {
          closedDayInvalidation.current = true;
          setState(previous => ({ ...previous, isBlocked: true }));
        }
        void runCheck();
      } : event.startsWith('terminal-') ? invalidate : poll;
      onEvent(event, handler);
      return { event, handler };
    });
    window.addEventListener('focus', invalidate);
    const visibility = () => { if (document.visibilityState === 'visible') invalidate(); };
    document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(poll, CASHIER_DAY_POLL_MS);
    return () => {
      mounted.current = false;
      ++generation.current;
      clearInterval(timer);
      handlers.forEach(({ event, handler }) => offEvent(event, handler));
      window.removeEventListener('focus', invalidate);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [runCheck]);
  useEffect(() => {
    if (lastOwnShiftVersion.current === ownShiftVersion) return;
    lastOwnShiftVersion.current = ownShiftVersion;
    if (mounted.current) void runCheck();
  }, [ownShiftVersion, runCheck]);
  return { ...state, isResolving: state.isResolving || state.scope !== scope || options.ready === false, recheck: () => runCheck(true) };
}
