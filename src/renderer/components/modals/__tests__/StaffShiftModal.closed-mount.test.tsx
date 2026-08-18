import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Render-instrumentation probe for the shared modal shell. The mock preserves
// the REAL LiquidGlassModal behavior (it forwards every render to the actual
// component) while recording each render's isOpen. The closed-mount guarantee
// under test: while StaffShiftModal has isOpen=false it early-returns null, so
// LiquidGlassModal must never render at all — not even with isOpen=false.
const { lgmRenderSpy } = vi.hoisted(() => ({ lgmRenderSpy: vi.fn() }));

vi.mock('../../ui/pos-glass-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/pos-glass-components')>();
  const ActualLiquidGlassModal = actual.LiquidGlassModal;
  const LiquidGlassModal: typeof actual.LiquidGlassModal = (props) => {
    lgmRenderSpy(props.isOpen);
    return <ActualLiquidGlassModal {...props} />;
  };
  return { ...actual, LiquidGlassModal };
});

// `t` MUST be referentially stable across renders (as react-i18next's is):
// effects that list `t` in their dependency arrays re-arm on every render
// otherwise, which can loop a component that sets fresh state in them.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) => (
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
    ),
  };
  return {
    ...actual,
    useTranslation: () => translation,
  };
});

vi.mock('../../../contexts/i18n-context', () => {
  const i18n = {
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string) => (key === 'common.actions.close' ? 'Close' : key),
  };
  return { useI18n: () => i18n };
});

vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({
    staff: null,
    activeShift: null,
    isShiftActive: false,
    refreshActiveShift: vi.fn(async () => undefined),
    setStaff: vi.fn(),
    setActiveShiftImmediate: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useTerminalSettings', () => {
  const useTerminalSettings = () => ({
    settings: {},
    loading: false,
    error: null,
    refresh: vi.fn(),
    getSetting: () => undefined,
  });
  return { default: useTerminalSettings, useTerminalSettings };
});

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(async () => ({ success: false })),
  posApiPost: vi.fn(async () => ({ success: false })),
}));

vi.mock('../../../utils/fiscal-integration-entitlement', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../utils/fiscal-integration-entitlement')
  >();
  return {
    ...actual,
    loadFiscalOrderReportingEntitlement: vi.fn(async () => false),
  };
});

// src/lib — everything IPC funnels through getBridge(); resolve every call
// with inert data so open-state effects settle without a Tauri runtime.
// Partial mock: the rest of the module (emitCompatEvent, onEvent wiring used
// by the UI blocker registry) must stay real for LiquidGlassModal to mount.
vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib')>()),
  getBridge: () => ({
    terminalConfig: {
      getSetting: vi.fn(async () => null),
      getBranchId: vi.fn(async () => null),
    },
    settings: {
      get: vi.fn(async () => ({})),
      updateLocal: vi.fn(async () => ({ success: true })),
    },
    staffAuth: {
      refreshDirectory: vi.fn(async () => ({ success: false })),
      verifyPin: vi.fn(async () => ({ success: false })),
    },
    staffSchedule: {
      list: vi.fn(async () => ({ success: false, error: 'offline' })),
    },
    shifts: {
      getActive: vi.fn(async () => null),
      getSummary: vi.fn(async () => null),
      getExpenses: vi.fn(async () => []),
      getStaffPayments: vi.fn(async () => []),
      getStaffPaymentsByStaff: vi.fn(async () => []),
      getStaffPaymentTotalForDate: vi.fn(async () => 0),
    },
  }),
}));

import { StaffShiftModal } from '../StaffShiftModal';

const baseProps = {
  onClose: vi.fn(),
  mode: 'checkin' as const,
};

describe('StaffShiftModal closed-state mount gating', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('contributes no vDOM while closed: LiquidGlassModal never renders, across repeated parent renders', () => {
    const view = render(<StaffShiftModal {...baseProps} isOpen={false} />);

    // Simulate the idle-PIN-screen churn: context-driven parent re-renders
    // hitting a closed modal. None of them may reach the modal shell.
    for (let i = 0; i < 5; i += 1) {
      view.rerender(<StaffShiftModal {...baseProps} isOpen={false} />);
    }

    expect(lgmRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the shell when opened and drops it entirely on a parent-driven close', async () => {
    const view = render(<StaffShiftModal {...baseProps} isOpen={false} />);
    expect(lgmRenderSpy).not.toHaveBeenCalled();

    view.rerender(<StaffShiftModal {...baseProps} isOpen />);
    // The staff-shift shell renders open; the sibling ConfirmDialog renders its
    // own (closed) LiquidGlassModal, so assert on the open shell specifically.
    expect(lgmRenderSpy.mock.calls.some(([open]) => open === true)).toBe(true);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // Parent-driven close: the early return unmounts the shell immediately
    // (accepted snap-close, same as OrderDetailsModal).
    lgmRenderSpy.mockClear();
    view.rerender(<StaffShiftModal {...baseProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lgmRenderSpy).not.toHaveBeenCalled();

    // And it stays out of the tree through further closed re-renders.
    view.rerender(<StaffShiftModal {...baseProps} isOpen={false} />);
    expect(lgmRenderSpy).not.toHaveBeenCalled();
  });
});
