/**
 * The notice for platform orders declined while the till was offline
 * (Android parity, offline week Ω6, 22/10/2026): count, about how much money
 * in the store's currency, in every app language.
 */
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSED_PLATFORM_ORDERS_NOTICE_MS,
  missedPlatformOrdersNoticeText,
  showMissedPlatformOrdersNotice,
} from '../MissedPlatformOrdersNoticeManager';
import type { MissedPlatformOrdersResult } from '../../../hooks/useMissedPlatformOrdersNotice';
import { formatCurrency } from '../../../utils/format';
import { localeBundles } from '../../../../locales/bundles';

const mocks = vi.hoisted(() => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('react-hot-toast', () => ({ toast: mocks.toast, default: mocks.toast }));

/** English defaults with their values, like the real `t` without a bundle. */
const t = (key: string, options: Record<string, unknown> = {}) => {
  const count = typeof options.count === 'number' ? options.count : undefined;
  const fallback = count === undefined
    ? options.defaultValue
    : count === 1 ? options.defaultValue_one : options.defaultValue_other;
  return String(fallback ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(options[name]));
};

function result(count: number, total: number): MissedPlatformOrdersResult {
  return {
    count,
    total,
    orders: Array.from({ length: count }, (_, index) => ({
      id: `order-${index}`,
      order_number: `EF-${index}`,
      platform: 'efood',
      total_amount: total / count,
    })),
  };
}

beforeEach(() => {
  mocks.toast.custom.mockReset();
  mocks.toast.dismiss.mockReset();
});
afterEach(() => cleanup());

describe('missedPlatformOrdersNoticeText', () => {
  it('says how many orders were declined and about how much, in the store currency', () => {
    expect(missedPlatformOrdersNoticeText(result(1, 18.5), t)).toEqual({
      title: '1 platform order was declined while the till was offline',
      body: `≈${formatCurrency(18.5)} in orders declined automatically (till offline). Keep the till connected to receive platform orders.`,
    });
    expect(missedPlatformOrdersNoticeText(result(4, 61.2), t).title).toBe(
      '4 platform orders were declined while the till was offline',
    );
  });
});

describe('showMissedPlatformOrdersNotice', () => {
  it('shows one alert toast for 12 s that staff can dismiss', () => {
    showMissedPlatformOrdersNotice(result(3, 42), t);

    expect(mocks.toast.custom).toHaveBeenCalledTimes(1);
    const [renderNotice, options] = mocks.toast.custom.mock.calls[0];
    expect(options).toEqual({ id: 'missed-platform-orders', duration: MISSED_PLATFORM_ORDERS_NOTICE_MS });
    expect(MISSED_PLATFORM_ORDERS_NOTICE_MS).toBe(12_000);

    const ui = render(<>{renderNotice({ id: options.id, visible: true })}</>);
    const notice = ui.getByTestId('missed-platform-orders-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('3 platform orders were declined while the till was offline');
    expect(notice.textContent).toContain(formatCurrency(42));

    fireEvent.click(ui.getByTestId('missed-platform-orders-notice-dismiss'));
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('missed-platform-orders');
  });
});

describe('locales', () => {
  it.each(['en', 'el', 'de', 'fr', 'it', 'sq'] as const)('%s has the title (one and other), the body and the button', async (language) => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: language,
      fallbackLng: false,
      resources: { [language]: { translation: localeBundles[language] as Record<string, unknown> } },
      interpolation: { escapeValue: false },
    });
    const translate = instance.t.bind(instance) as unknown as (key: string, options?: Record<string, unknown>) => string;

    const one = missedPlatformOrdersNoticeText(result(1, 10), translate);
    const many = missedPlatformOrdersNoticeText(result(5, 50), translate);
    for (const text of [one.title, many.title, one.body]) {
      expect(text).not.toMatch(/missedPlatformOrders\./);
      expect(text).not.toMatch(/{{|}}/);
    }
    expect(one.title).toContain('1');
    expect(many.title).toContain('5');
    expect(one.title).not.toBe(many.title.replace('5', '1'));
    expect(one.body).toContain(formatCurrency(10));
    expect(translate('missedPlatformOrders.dismiss')).not.toBe('missedPlatformOrders.dismiss');
  });
});
