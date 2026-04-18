import { getBridge } from '../../lib';
import type { StaffShift } from '../types';

type ResolveActiveCashierShiftParams = {
  branchId?: string | null;
  terminalId?: string | null;
  activeShift?: StaffShift | null;
  logContext: string;
};

function normalizeContextValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  if (
    normalized === 'default-branch' ||
    normalized === 'default-terminal' ||
    normalized === 'default-organization' ||
    normalized === 'default-org'
  ) {
    return null;
  }
  return trimmed;
}

function unwrapData<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object') {
    return (value as T | null) ?? null;
  }
  if ('data' in value) {
    return ((value as { data?: T | null }).data ?? null) as T | null;
  }
  return value as T;
}

function isActiveCashierShift(
  shift: StaffShift | null | undefined,
  terminalId: string | null,
): shift is StaffShift {
  if (!shift || shift.status !== 'active' || shift.role_type !== 'cashier') {
    return false;
  }
  if (!terminalId) {
    return true;
  }
  return normalizeContextValue(shift.terminal_id) === terminalId;
}

export async function resolveActiveCashierShift({
  branchId,
  terminalId,
  activeShift,
  logContext,
}: ResolveActiveCashierShiftParams): Promise<StaffShift | null> {
  const bridge = getBridge();
  const normalizedBranchId = normalizeContextValue(branchId);
  const normalizedTerminalId = normalizeContextValue(terminalId);

  if (!normalizedTerminalId) {
    return null;
  }

  let strictLookupFailed = false;

  if (normalizedBranchId) {
    try {
      const strictShift = unwrapData<StaffShift>(
        await bridge.shifts.getActiveCashierByTerminal(
          normalizedBranchId,
          normalizedTerminalId,
        ),
      );
      if (isActiveCashierShift(strictShift, normalizedTerminalId)) {
        return strictShift;
      }
      strictLookupFailed = true;
    } catch (error) {
      strictLookupFailed = true;
      console.warn(`[${logContext}] Active cashier strict lookup failed:`, error);
    }
  }

  try {
    const looseShift = unwrapData<StaffShift>(
      await bridge.shifts.getActiveCashierByTerminalLoose(normalizedTerminalId),
    );
    if (isActiveCashierShift(looseShift, normalizedTerminalId)) {
      if (strictLookupFailed) {
        console.info(`[${logContext}] Recovered active cashier via terminal-only fallback`, {
          branchId: normalizedBranchId,
          terminalId: normalizedTerminalId,
          shiftId: looseShift.id,
          shiftBranchId: normalizeContextValue(looseShift.branch_id),
        });
      }
      return looseShift;
    }
  } catch (error) {
    console.warn(`[${logContext}] Active cashier loose lookup failed:`, error);
  }

  if (isActiveCashierShift(activeShift, normalizedTerminalId)) {
    if (strictLookupFailed) {
      console.info(`[${logContext}] Recovered active cashier from cached shift`, {
        branchId: normalizedBranchId,
        terminalId: normalizedTerminalId,
        shiftId: activeShift.id,
        shiftBranchId: normalizeContextValue(activeShift.branch_id),
      });
    }
    return activeShift;
  }

  return null;
}
