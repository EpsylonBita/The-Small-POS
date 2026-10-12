import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import CustomerOrderHistoryModal from '../CustomerOrderHistoryModal';
import { getBridge } from '../../../../lib';
import { formatCurrency } from '../../../utils/format';

vi.mock('../../../../lib', () => ({ getBridge: vi.fn() }));
vi.mock('../../../../lib/i18n', () => ({ default: { language: 'en-US' } }));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('keeps order currency and separates mixed-currency customer totals', async () => {
  const bridge = { orders: { getByCustomerPhone: vi.fn().mockResolvedValue({ success: true, orders: [
    { id: 'usd', order_number: '001', total_amount: 24.5, currency: 'USD', created_at: '2026-10-09T12:00:00Z', status: 'completed' },
    { id: 'chf', order_number: '002', total_amount: 10, currency: 'CHF', created_at: '2026-10-09T12:00:00Z', status: 'completed' },
    { id: 'unknown', order_number: '003', total_amount: 3, currency: null, created_at: '2026-10-09T12:00:00Z', status: 'completed' },
  ] }) } };
  vi.mocked(getBridge).mockReturnValue(bridge as any);
  render(<CustomerOrderHistoryModal isOpen customerPhone="+41215550301" onClose={() => {}} />);
  expect(await screen.findByText([formatCurrency(24.5, 'USD'), formatCurrency(10, 'CHF'), formatCurrency(3, null)].join(' · ').replace(/\s/g, ' '))).toBeTruthy();
  expect(screen.getByText(formatCurrency(24.5, 'USD'))).toBeTruthy();
  expect(screen.getByText(formatCurrency(3, null))).toBeTruthy();
});
