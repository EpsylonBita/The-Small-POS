import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Render-instrumentation probe for the shared modal shell. The mock preserves
// the REAL LiquidGlassModal behavior while recording each render's isOpen.
// Closed-mount guarantee under test: while MenuModal has isOpen=false it
// early-returns null, so LiquidGlassModal must never render at all.
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
// MenuModal's menu-items loader effect lists `t` in its dependency array and
// sets a fresh array each run, so a per-render `t` identity loops the
// component into OOM.
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

// Hook mocks MUST return referentially stable values: several MenuModal
// effects/memos list these results in their dependency arrays, and a mock
// that fabricates fresh objects per render re-arms them on every commit.
vi.mock('../../../contexts/shift-context', () => {
  const shiftValue = {
    staff: { branchId: 'branch-1' },
    activeShift: null,
    isShiftActive: false,
    refreshActiveShift: vi.fn(async () => undefined),
  };
  return { useShift: () => shiftValue };
});

vi.mock('../../../hooks/useDiscountSettings', () => {
  const value = { maxDiscountPercentage: 100 };
  return { useDiscountSettings: () => value };
});

vi.mock('../../../hooks/useFeaturedItems', () => {
  const value = { topSellerIds: [], rankedTopSellerIds: [], topSellers: [] };
  return { useFeaturedItems: () => value };
});

vi.mock('../../../hooks/useDeliveryValidation', () => {
  const value = {
    validateAddress: vi.fn(async () => null),
    isValidating: false,
  };
  return { useDeliveryValidation: () => value };
});

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>();
  const value = { hasModule: () => false };
  return {
    ...actual,
    useAcquiredModules: () => value,
  };
});

vi.mock('../../../hooks/useKdsLiveDraftSync', () => ({
  useKdsLiveDraftSync: vi.fn(),
}));

vi.mock('../../../services/MenuService', () => ({
  menuService: {
    getMenuItems: vi.fn(async () => []),
    getMenuCategories: vi.fn(async () => []),
    getIngredients: vi.fn(async () => []),
    getMenuCombos: vi.fn(async () => []),
    getMenuItemById: vi.fn(async () => null),
    getLoadingStatus: () => ({ menuItems: 'success' }),
    clearCacheEntry: vi.fn(),
  },
}));

vi.mock('../../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: vi.fn(() => null),
  refreshTerminalCredentialCache: vi.fn(async () => null),
}));

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(async () => ({ success: false })),
  posApiPost: vi.fn(async () => ({ success: false })),
}));

// The real getBridge() returns a stable singleton, and MenuModal depends on
// that: `bridge.loyalty` sits in an effect dependency array, so a mock that
// fabricates a fresh bridge per call re-arms that effect on every render and
// loops the component. Partial mock; the rest of src/lib stays real.
vi.mock('../../../../lib', async (importOriginal) => {
  const bridge = {
    settings: { get: vi.fn(async () => null) },
    orders: { getById: vi.fn(async () => null) },
    customers: {},
    loyalty: {
      getSettings: vi.fn(async () => null),
      getCustomerBalance: vi.fn(async () => null),
    },
  };
  return {
    ...(await importOriginal<typeof import('../../../../lib')>()),
    getBridge: () => bridge,
  };
});

// Presentation-heavy children are not under test; stub them so the shell
// gating is exercised without dragging their own data dependencies in.
vi.mock('../../menu/MenuCategoryTabs', () => ({
  MenuCategoryTabs: () => <div data-testid="menu-category-tabs" />,
}));
vi.mock('../../menu/MenuItemGrid', () => ({
  MenuItemGrid: () => <div data-testid="menu-item-grid" />,
}));
vi.mock('../../menu/MenuCart', () => ({
  MenuCart: () => <div data-testid="menu-cart" />,
}));
vi.mock('../../menu/MenuItemModal', () => ({
  MenuItemModal: () => null,
}));
vi.mock('../../menu/ComboChoiceModal', () => ({
  ComboChoiceModal: () => null,
}));
vi.mock('../PaymentModal', () => ({
  PaymentModal: () => null,
}));
vi.mock('../LoyaltyRedeemModal', () => ({
  LoyaltyRedeemModal: () => null,
}));

import { MenuModal } from '../MenuModal';

const baseProps = {
  onClose: vi.fn(),
  orderType: 'pickup' as const,
};

describe('MenuModal closed-state mount gating', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('contributes no vDOM while closed: LiquidGlassModal never renders, across repeated parent renders', () => {
    const view = render(<MenuModal {...baseProps} isOpen={false} />);

    // OrderDashboard mounts this modal twice, unconditionally, and re-renders
    // constantly at an idle dashboard; a closed instance must stay inert.
    for (let i = 0; i < 5; i += 1) {
      view.rerender(<MenuModal {...baseProps} isOpen={false} />);
    }

    expect(lgmRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the menu surface when opened and drops it entirely on a parent-driven close', async () => {
    const view = render(<MenuModal {...baseProps} isOpen={false} />);
    expect(lgmRenderSpy).not.toHaveBeenCalled();

    view.rerender(<MenuModal {...baseProps} isOpen />);
    expect(lgmRenderSpy.mock.calls.some(([open]) => open === true)).toBe(true);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByTestId('menu-cart')).toBeInTheDocument();

    // Parent-driven close: the early return unmounts the shell immediately
    // (accepted snap-close, same as OrderDetailsModal).
    lgmRenderSpy.mockClear();
    view.rerender(<MenuModal {...baseProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lgmRenderSpy).not.toHaveBeenCalled();
  });
});
