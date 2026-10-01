import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Item H, fix review 30/09/2026. The terminal's tax rate at checkout: the
// stored rate, today's 24% when none is stored, and unavailable (checkout
// paused) when the settings could not be read or the stored value is not a
// rate. Never an assumed 24% on a read error.

const toastMock = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { error: toastMock.error, dismiss: toastMock.dismiss }),
}));

import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import it_ from '../../../locales/it.json';
import sq from '../../../locales/sq.json';
import {
  DEFAULT_TAX_RATE_PERCENTAGE,
  notifyMoneySettingsUnavailable,
  resolveCheckoutTaxRate,
} from '../checkoutMoneySettings';

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

const reader = (loaded: boolean | undefined, stored: Record<string, unknown>) => ({
  loaded,
  getSetting: <T,>(category: string, key: string, fallback?: T) =>
    (Object.prototype.hasOwnProperty.call(stored, `${category}.${key}`)
      ? (stored[`${category}.${key}`] as T)
      : fallback),
});

afterEach(() => {
  cleanup();
  toastMock.error.mockReset();
});

describe('resolveCheckoutTaxRate', () => {
  it('is unavailable while no read of the settings has succeeded', () => {
    expect(resolveCheckoutTaxRate(reader(false, {}))).toEqual({ available: false });
  });

  it('keeps today\'s default when no rate is stored', () => {
    expect(resolveCheckoutTaxRate(reader(true, {}))).toEqual({
      available: true,
      rate: DEFAULT_TAX_RATE_PERCENTAGE,
    });
  });

  it('uses the stored rate', () => {
    expect(resolveCheckoutTaxRate(reader(true, { 'tax.tax_rate_percentage': '13' }))).toEqual({
      available: true,
      rate: 13,
    });
  });

  it('a stored value that is not a rate is unavailable, never 24%', () => {
    expect(
      resolveCheckoutTaxRate(reader(true, { 'tax.tax_rate_percentage': 'garbled' })),
    ).toEqual({ available: false });
    expect(
      resolveCheckoutTaxRate(reader(true, { 'tax.tax_rate_percentage': 240 })),
    ).toEqual({ available: false });
  });
});

describe('the paused-checkout message', () => {
  it.each(Object.keys(LOCALES) as Lng[])('%s: says it in the store language with Try again', async (lng) => {
    const instance = i18next.createInstance();
    await instance.init({
      lng,
      fallbackLng: false,
      resources: { [lng]: { translation: LOCALES[lng] } },
      interpolation: { escapeValue: false },
    });
    const retry = vi.fn();

    notifyMoneySettingsUnavailable(instance.t, retry);

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const [renderToast] = toastMock.error.mock.calls[0];
    render(<>{renderToast({ id: 'toast-1' })}</>);
    const notice = screen.getByTestId('money-settings-unavailable');
    expect(notice.textContent).toContain(instance.t('payment.moneySettings.unavailableTitle'));
    expect(notice.textContent).toContain(instance.t('payment.moneySettings.unavailableMessage'));
    if (lng !== 'en') {
      expect(notice.textContent).not.toContain('could not be read');
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: instance.t('payment.moneySettings.retry') }));
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
