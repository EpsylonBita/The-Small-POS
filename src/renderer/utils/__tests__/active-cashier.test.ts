import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffShift } from '../../types';
import { resolveActiveCashierShift } from '../active-cashier';

const shifts = vi.hoisted(() => ({
  getActiveCashierByTerminal: vi.fn(),
  getActiveCashierByTerminalLoose: vi.fn(),
}));

vi.mock('../../../lib', () => ({ getBridge: () => ({ shifts }) }));

const BRANCH = 'branch-1';
const TERMINAL = 'terminal-1';
const activeCashier = {
  id: 'cashier-shift',
  staff_id: 'cashier-1',
  branch_id: BRANCH,
  terminal_id: TERMINAL,
  role_type: 'cashier',
  status: 'active',
} as StaffShift;

const resolve = (activeShift: StaffShift | null = activeCashier, branchId: string | null = BRANCH) =>
  resolveActiveCashierShift({ branchId, terminalId: TERMINAL, activeShift, logContext: 'test' });

beforeEach(() => {
  shifts.getActiveCashierByTerminal.mockReset().mockResolvedValue(null);
  shifts.getActiveCashierByTerminalLoose.mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('resolveActiveCashierShift', () => {
  it('vetoes stale cached active state when strict and terminal-only reads find no active cashier', async () => {
    expect(await resolve()).toBeNull();
    expect(shifts.getActiveCashierByTerminal).toHaveBeenCalledWith(BRANCH, TERMINAL);
    expect(shifts.getActiveCashierByTerminalLoose).toHaveBeenCalledWith(TERMINAL);
  });

  it.each(['strict', 'loose'])('a successful empty %s read vetoes cache when the other read throws', async (successfulRead) => {
    const failingRead = successfulRead === 'strict'
      ? shifts.getActiveCashierByTerminalLoose
      : shifts.getActiveCashierByTerminal;
    failingRead.mockRejectedValue(new Error('db unavailable'));
    expect(await resolve()).toBeNull();
  });

  it('treats a wrapped successful empty response as authoritative', async () => {
    shifts.getActiveCashierByTerminal.mockResolvedValue({ data: null });
    shifts.getActiveCashierByTerminalLoose.mockResolvedValue({ data: null });
    expect(await resolve()).toBeNull();
  });

  it('returns a valid strict result before any recovery or cached shift', async () => {
    const freshShift = { ...activeCashier, id: 'fresh-shift' };
    shifts.getActiveCashierByTerminal.mockResolvedValue({ data: freshShift });
    expect(await resolve()).toBe(freshShift);
    expect(shifts.getActiveCashierByTerminalLoose).not.toHaveBeenCalled();
  });

  it('preserves authoritative terminal-only recovery when the branch context is stale', async () => {
    const freshShift = { ...activeCashier, id: 'fresh-shift', branch_id: 'current-branch' };
    shifts.getActiveCashierByTerminalLoose.mockResolvedValue(freshShift);
    expect(await resolve()).toBe(freshShift);
  });

  it('preserves terminal-only recovery when the strict lookup throws', async () => {
    shifts.getActiveCashierByTerminal.mockRejectedValue(new Error('db unavailable'));
    shifts.getActiveCashierByTerminalLoose.mockResolvedValue(activeCashier);
    expect(await resolve(null)).toBe(activeCashier);
  });

  it('permits cached offline state only when both authoritative reads throw', async () => {
    shifts.getActiveCashierByTerminal.mockRejectedValue(new Error('db unavailable'));
    shifts.getActiveCashierByTerminalLoose.mockRejectedValue(new Error('db unavailable'));
    expect(await resolve()).toBe(activeCashier);
  });

  it('permits cache when the applicable lookup method is unavailable', async () => {
    shifts.getActiveCashierByTerminalLoose.mockImplementation(() => {
      throw new TypeError('lookup unavailable');
    });
    expect(await resolve(activeCashier, null)).toBe(activeCashier);
    expect(shifts.getActiveCashierByTerminal).not.toHaveBeenCalled();
  });

  it('vetoes cache on a successful terminal-only empty read without branch context', async () => {
    expect(await resolve(activeCashier, null)).toBeNull();
    expect(shifts.getActiveCashierByTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['closed', { status: 'closed' }],
    ['wrong terminal', { terminal_id: 'other-terminal' }],
    ['driver', { role_type: 'driver' }],
  ])('a %s lookup result cannot open the day or revive stale cache', async (_label, override) => {
    const invalidShift = { ...activeCashier, ...override } as StaffShift;
    shifts.getActiveCashierByTerminal.mockResolvedValue(invalidShift);
    shifts.getActiveCashierByTerminalLoose.mockResolvedValue(invalidShift);
    expect(await resolve()).toBeNull();
  });

  it('rejects a wrong-branch strict result when terminal-only recovery is empty', async () => {
    shifts.getActiveCashierByTerminal.mockResolvedValue({ ...activeCashier, branch_id: 'other-branch' });
    expect(await resolve()).toBeNull();
  });

  it.each([
    ['closed', { status: 'closed' }],
    ['wrong branch', { branch_id: 'other-branch' }],
    ['wrong terminal', { terminal_id: 'other-terminal' }],
    ['driver', { role_type: 'driver' }],
  ])('rejects %s cached state even when every read is unavailable', async (_label, override) => {
    shifts.getActiveCashierByTerminal.mockRejectedValue(new Error('db unavailable'));
    shifts.getActiveCashierByTerminalLoose.mockRejectedValue(new Error('db unavailable'));
    expect(await resolve({ ...activeCashier, ...override } as StaffShift)).toBeNull();
  });

  it.each(['strict', 'loose', 'cache'])('accepts an active manager from %s under the native day-opening policy', async (source) => {
    const managerShift = { ...activeCashier, role_type: 'manager' } as StaffShift;
    if (source === 'strict') {
      shifts.getActiveCashierByTerminal.mockResolvedValue(managerShift);
    } else if (source === 'loose') {
      shifts.getActiveCashierByTerminalLoose.mockResolvedValue(managerShift);
    } else {
      shifts.getActiveCashierByTerminal.mockRejectedValue(new Error('db unavailable'));
      shifts.getActiveCashierByTerminalLoose.mockRejectedValue(new Error('db unavailable'));
    }
    expect(await resolve(managerShift)).toBe(managerShift);
  });

  it('requires a configured terminal before querying or accepting cache', async () => {
    expect(await resolveActiveCashierShift({
      branchId: BRANCH, terminalId: 'default-terminal', activeShift: activeCashier, logContext: 'test',
    })).toBeNull();
    expect(shifts.getActiveCashierByTerminal).not.toHaveBeenCalled();
    expect(shifts.getActiveCashierByTerminalLoose).not.toHaveBeenCalled();
  });
});
