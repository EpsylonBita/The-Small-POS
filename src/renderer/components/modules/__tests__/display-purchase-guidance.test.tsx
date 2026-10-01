import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModuleUpsellCard } from '../ModuleUpsellCard';
import { openExternalUrl } from '../../../utils/external-url';
import { DISPLAY_PURCHASE_COPY_KEYS } from '@shared/modules/display-purchase-guidance';
import type { ModuleUpsellInfo } from '@shared/types/upsell';
import { localeBundles } from '../../../../locales/bundles';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce<unknown>((part, segment) => (part as Record<string, unknown>)?.[segment], localeBundles.en) || key,
  }),
}));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock('../../../utils/external-url', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));

const staleDescription = 'Legacy cloud Web TV pairing description';
const staleFeature = 'Scan a legacy cloud pairing URL';
const pricing = Object.freeze({ monthly: 42.5, annual: 400, currency: 'EUR' });
function moduleInfo(moduleId: string): ModuleUpsellInfo {
  return Object.freeze({
    module_id: moduleId, name: 'catalog-name', display_name: 'Catalog module name',
    description: staleDescription, icon: 'Monitor', pricing,
    features: [{ id: 'legacy', name: staleFeature, description: 'Receive cloud browser orders' }],
    dependencies: [], unlocked_features: [], category: 'shared' as const,
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('display purchase information in desktop POS', () => {
  it.each([
    ['kitchen_display', 'expanded'], ['customer_display', 'expanded'],
    ['kitchen_display', 'modal'], ['customer_display', 'modal'],
  ] as const)('shows %s equipment before the %s browser offer, without creating checkout in POS', async (moduleId, variant) => {
    const module = moduleInfo(moduleId);
    const original = JSON.stringify(module);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ checkout_url: 'https://checkout.example.test/session' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ModuleUpsellCard moduleId={moduleId} moduleInfo={module} variant={variant} isOpen />);
    const guidance = screen.getByTestId(`display-purchase-guidance-${moduleId}`);
    const purchase = screen.getByRole('button', { name: 'Upgrade Now' });
    expect(guidance).toBeVisible();
    expect(guidance.compareDocumentPosition(purchase) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(guidance).getByText(/not every Android POS/)).toBeVisible();
    expect(within(guidance).getByText(/main POS screen plus two different/)).toBeVisible();
    expect(within(guidance).getByText(moduleId === 'kitchen_display' ? /HDMI video alone does not provide touch/ : /does not require a touchscreen/)).toBeVisible();
    expect(screen.queryByText(staleDescription)).not.toBeInTheDocument();
    expect(screen.queryByText(staleFeature)).not.toBeInTheDocument();
    expect(screen.getByText('€42.5')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(purchase);
    await vi.waitFor(() => expect(openExternalUrl).toHaveBeenLastCalledWith(expect.stringContaining('/profile?')));
    const destination = new URL(vi.mocked(openExternalUrl).mock.lastCall![0]);
    expect(destination.pathname).toBe('/profile');
    expect(destination.searchParams.get('purchase')).toBe(moduleId);
    expect(destination.searchParams.get('tab')).toBe('modules');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/modules/checkout')).toBe(false);
    expect(JSON.stringify(module)).toBe(original);
  });

  it.each(['kitchen_display', 'customer_display'])('shows a readable %s compact summary and full guidance when opened', (moduleId) => {
    const learnMore = vi.fn();
    render(<ModuleUpsellCard moduleId={moduleId} moduleInfo={moduleInfo(moduleId)} onLearnMore={learnMore} />);
    expect(screen.getByTestId(`display-purchase-guidance-${moduleId}`)).toHaveTextContent(/Hardware is shop-provided and is not included/);
    expect(screen.queryByText(staleDescription)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upgrade Now' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(learnMore).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('dialog')).getByText(/Sharing a Wi-Fi network alone/)).toBeVisible();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Upgrade Now' })).toBeEnabled();
  });

  it('preserves unrelated marketing and normalizes established display aliases for presentation', () => {
    const view = render(<ModuleUpsellCard moduleId="inventory" moduleInfo={moduleInfo('inventory')} variant="expanded" />);
    expect(screen.getByText(staleDescription)).toBeVisible();
    expect(screen.getByText(staleFeature)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Before you buy' })).not.toBeInTheDocument();
    view.rerender(<ModuleUpsellCard moduleId="kitchen-display" moduleInfo={moduleInfo('kitchen-display')} variant="expanded" />);
    expect(screen.getByTestId('display-purchase-guidance-kitchen_display')).toBeVisible();
  });

  it.each(Object.entries(localeBundles))('resolves all guidance keys from the %s desktop runtime bundle', (_, locale) => {
    for (const key of DISPLAY_PURCHASE_COPY_KEYS) {
      const value = key.split('.').reduce<unknown>((part, segment) => (part as Record<string, unknown>)?.[segment], locale);
      expect(typeof value).toBe('string');
      expect(String(value).trim().length).toBeGreaterThan(3);
      expect(value).not.toBe(key);
    }
  });
});
