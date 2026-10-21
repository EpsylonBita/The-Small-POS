import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ translate: (key: string, fallback?: any) => typeof fallback === 'string' ? fallback : fallback?.defaultValue || key, checkIn: vi.fn(), complete: vi.fn(), update: vi.fn(), refetch: vi.fn(),
  getAll: vi.fn(async () => []), service: { id: '10000000-0000-4000-8000-000000000001', name: 'Haircut', price: 25, priceIncludesVat: true },
  bridge: { staffSchedule: { list: vi.fn(async () => ({ success: true, data: { staff: [] } })) }, services: { list: vi.fn(async () => ({ success: true, data: { services: [] } })) } } }));
vi.mock('react-i18next', async original => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: mocks.translate, i18n: { language: 'en' } }) }));
vi.mock('../../../../components/OrderFlow', () => ({ default: ({ salonSale, onSalonClose }: any) => <div data-testid="sale">{salonSale.items.map((line: any) => `${line.service_id}:${line.appointment_id}`)}<button onClick={onSalonClose}>Finish salon sale</button></div> }));
vi.mock('../../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../../../contexts/module-context', () => ({ useModules: () => ({ organizationId: 'org' }) }));
vi.mock('../../../../../lib', () => ({ getBridge: () => Object.assign(mocks.bridge, { orders: { getAll: mocks.getAll } }), isBrowser: () => false, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('../../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ branchId: 'branch', organizationId: 'org' }), refreshTerminalCredentialCache: async () => ({ branchId: 'branch', organizationId: 'org' }) }));
vi.mock('../../../../utils/api-helpers', () => ({ posApiGet: async () => ({ success: true, data: { timeZone: 'Europe/Athens' } }) }));
vi.mock('../../../../services/ServicesService', () => ({ servicesService: { setContext: vi.fn(), fetchServices: async () => [mocks.service] } }));
vi.mock('../../../../components/modals/CustomerSearchModal', () => ({ CustomerSearchModal: () => null }));
vi.mock('../../../../hooks/useAppointments', () => ({ useAppointments: () => ({ appointments: [{
  id: '20000000-0000-4000-8000-000000000001', organizationId: 'org', branchId: 'branch', status: 'scheduled',
  startTime: '2026-10-21T07:00:00Z', endTime: '2026-10-21T07:45:00Z', serviceId: mocks.service.id, serviceName: 'Haircut',
  customerName: 'Mia', staffName: 'Ana', staffId: 'stylist', services: [], totalPrice: 25,
}], stats: { total: 1, scheduled: 1 }, staff: [], isLoading: false, refetch: mocks.refetch,
  createAppointment: vi.fn(), updateStatus: mocks.update, checkIn: mocks.checkIn, complete: mocks.complete }) }));
import { AppointmentsView } from '../AppointmentsView';
afterEach(cleanup);
describe('desktop appointment actions', () => {
  it('checks a scheduled appointment in, and checks out through the normal sale instead of completing it', async () => {
    render(<AppointmentsView embedded />);
    fireEvent.click(await screen.findByRole('button', { name: 'List' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    expect(mocks.checkIn).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001');
    fireEvent.click(screen.getByRole('button', { name: 'salonSale.checkout' }));
    await waitFor(() => expect(screen.getByTestId('sale').textContent).toContain(`${mocks.service.id}:20000000-0000-4000-8000-000000000001`));
    fireEvent.click(screen.getByRole('button', { name: 'Finish salon sale' }));
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
});
