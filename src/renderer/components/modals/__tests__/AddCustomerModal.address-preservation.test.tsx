import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  update: vi.fn(),
  bridge: { terminalConfig: { getBranchId: vi.fn().mockResolvedValue('branch-1') } },
}));
vi.mock('../../../../lib', () => ({ getBridge: () => mock.bridge, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('../../../services/CustomerService', () => ({ customerService: { updateCustomerAddress: mock.update } }));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../../hooks/useAcquiredModules', () => ({ MODULE_IDS: { DELIVERY: 'delivery', DELIVERY_ZONES: 'delivery_zones' }, useAcquiredModules: () => ({ hasModule: () => false }) }));
vi.mock('../../../services/terminal-credentials', () => ({ getResolvedTerminalCredentials: vi.fn().mockResolvedValue({ branchId: 'branch-1' }) }));
vi.mock('../../../services/address-workflow', () => ({
  buildAddressFingerprint: vi.fn(), createAddressSessionToken: vi.fn(), ensureAddressOfflineRuntime: vi.fn(),
  extractStreetNumber: vi.fn(), getSuggestionStreetLabel: vi.fn(), resolveAddressSuggestion: vi.fn(),
  searchAddressSuggestions: vi.fn().mockResolvedValue([]), upsertVerifiedLocalCandidate: vi.fn(), validateAddressForDelivery: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'el' } }) }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ children, isOpen }: any) => isOpen ? <div>{children}</div> : null }));
vi.mock('../../forms/FloorPresetPicker', () => ({ FloorPresetPicker: ({ value, onChange, placeholder }: any) => <input placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} /> }));
import { AddCustomerModal } from '../AddCustomerModal';
const address = {
  id: 'address-2', street_address: 'Ermou 12', city: 'Athens', postal_code: '10563',
  floor_number: '2', name_on_ringer: 'Papas', delivery_notes: 'Ring twice',
  latitude: 37.98, longitude: 23.73, is_default: false, version: 3,
};
const customer = { id: 'customer-1', phone: '6912345678', name: 'Maria', email: 'maria@example.test', editAddressId: address.id, addresses: [address] };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.update.mockImplementation(async (_id, patch) => ({ success: true, data: { ...address, ...patch } }));
});
describe('saved delivery address editing', () => {
  it.each(['floor', 'ringer', 'unchanged'])('keeps all unedited address fields on a %s save without Delivery Pro', async edit => {
    const onCustomerAdded = vi.fn();
    const { container } = render(<AddCustomerModal isOpen onClose={() => {}} onCustomerAdded={onCustomerAdded} mode="editAddress" initialCustomer={customer} />);
    if (edit === 'floor') fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '3' } });
    if (edit === 'ringer') fireEvent.change(screen.getByDisplayValue('Papas'), { target: { value: 'Family Papas' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith(address.id, expect.objectContaining({
      street_address: 'Ermou 12', city: 'Athens', postal_code: '10563', notes: 'Ring twice',
      latitude: 37.98, longitude: 23.73, coordinates: { lat: 37.98, lng: 23.73 },
      floor_number: edit === 'floor' ? '3' : '2', name_on_ringer: edit === 'ringer' ? 'Family Papas' : 'Papas',
    }), 3));
    expect(onCustomerAdded).toHaveBeenCalled();
  });
  it('allows an intentional city change and clears the old point', async () => {
    const { container } = render(<AddCustomerModal isOpen onClose={() => {}} onCustomerAdded={() => {}} mode="editAddress" initialCustomer={customer} />);
    fireEvent.change(screen.getByDisplayValue('Athens'), { target: { value: 'Piraeus' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith(address.id, expect.objectContaining({ city: 'Piraeus', latitude: null, longitude: null, coordinates: null }), 3));
  });
});
