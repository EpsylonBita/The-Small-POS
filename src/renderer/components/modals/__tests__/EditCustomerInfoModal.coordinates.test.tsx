import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deliveryPro: true,
  validateAddressForDelivery: vi.fn(),
  resolveAddressSuggestion: vi.fn(),
  searchAddressSuggestions: vi.fn(),
  locateTypedAddress: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) => (
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
    ),
  }
  return { ...actual, useTranslation: () => translation }
})

vi.mock('../../../services/address-workflow', async (importOriginal) => {
  const workflow = await importOriginal<typeof import('../../../services/address-workflow')>()
  const houseNumber = await import('../../../services/address-house-number')
  return {
    ...workflow,
    ...houseNumber,
    buildAddressFingerprint: (address: string, coordinates?: { lat: number; lng: number }) =>
      coordinates ? `${address}|${coordinates.lat}|${coordinates.lng}` : address,
    createAddressSessionToken: () => 'addr_session_test',
    ensureAddressOfflineRuntime: vi.fn(async () => undefined),
    getSuggestionStreetLabel: () => 'Suggested street',
    locateTypedAddress: mocks.locateTypedAddress,
    resolveAddressSuggestion: mocks.resolveAddressSuggestion,
    searchAddressSuggestions: mocks.searchAddressSuggestions,
    upsertVerifiedLocalCandidate: vi.fn(),
    validateAddressForDelivery: mocks.validateAddressForDelivery,
  }
})

vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn(async () => ({ branchId: 'branch-1' })),
}))

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>()
  const value = { hasModule: () => mocks.deliveryPro }
  return { ...actual, useAcquiredModules: () => value }
})

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children, footer }: any) => (isOpen ? <div role="dialog">{children}{footer}</div> : null),
}))

import { EditCustomerInfoModal } from '../EditCustomerInfoModal'

// Synthetic data only.
const baseInfo = {
  name: 'Test Customer',
  phone: '6948128474',
  address: 'Odos Dokimis 12',
  postal_code: '55133',
  delivery_floor: '2',
  name_on_ringer: 'Test',
}

beforeEach(() => {
  mocks.deliveryPro = true
  mocks.locateTypedAddress.mockReset().mockResolvedValue({ located: false, reason: 'not_found' })
  mocks.validateAddressForDelivery.mockReset()
  mocks.resolveAddressSuggestion.mockReset()
  mocks.searchAddressSuggestions.mockReset().mockResolvedValue([])
  mocks.validateAddressForDelivery.mockResolvedValue({
    success: true,
    isValid: true,
    deliveryAvailable: true,
    validation_status: 'in_zone',
    requires_override: false,
    house_number_match: true,
  })
})

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); })

describe('EditCustomerInfoModal map street name note', () => {
  it.each(['pick', 'typed'] as const)('shows a different route after %s, clears on edit, and hides a matching route', async source => {
    const street = 'Κωνσταντινουπόλεως 62';
    const details = { streetAddress: street, route: 'Γιάννη Χαλκίδη', city: 'City', postalCode: '54249',
      coordinates: { lat: 40.614, lng: 22.9603 }, addressFingerprint: 'fp-note', validationSource: 'online' };
    mocks.searchAddressSuggestions.mockResolvedValue([{ place_id: 'pick' }]);
    mocks.resolveAddressSuggestion.mockResolvedValue(details);
    mocks.locateTypedAddress.mockResolvedValue({ located: true, details });
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder');
    const noteKey = 'modals.addCustomer.mapStreetNameDiffers';
    fireEvent.change(input, { target: { value: street } });
    if (source === 'pick') fireEvent.click(await screen.findByText('Suggested street'));
    else fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.postalCodePlaceholder'), { target: { value: '54640' } });
    const line = await screen.findByText(noteKey);
    expect(line).toHaveClass('text-xs', 'liquid-glass-modal-text-muted');
    expect(input).toHaveValue(street);
    fireEvent.change(input, { target: { value: `${street}A` } });
    expect(screen.queryByText(noteKey)).toBeNull();
    mocks.resolveAddressSuggestion.mockResolvedValue({ ...details, route: 'Κωνσταντινουπόλεως' });
    fireEvent.click(await screen.findByText('Suggested street'));
    await waitFor(() => expect(mocks.resolveAddressSuggestion).toHaveBeenCalledTimes(source === 'pick' ? 2 : 1));
    await waitFor(() => expect(input).toHaveValue(street));
    expect(screen.queryByText(noteKey)).toBeNull();
  });
});

describe('EditCustomerInfoModal order coordinates', () => {
  it.each([
    ['delivery_latitude null (dashboard orders)', { coordinates: undefined, latitude: null, longitude: null }],
    ['a stray (0,0) object', { coordinates: { lat: 0, lng: 0 }, latitude: null, longitude: null }],
    ['a stray (0,0) pair', { coordinates: undefined, latitude: 0, longitude: 0 }],
  ])('opens without a point for %s and never checks or saves (0,0)', async (_label, coordinates) => {
    const onSave = vi.fn(async () => undefined)
    render(
      <EditCustomerInfoModal
        isOpen
        orderCount={1}
        initialCustomerInfo={{ ...baseInfo, ...coordinates }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ coordinates: null, latitude: null, longitude: null }))
  })

  it('keeps a real order point', async () => {
    const point = { lat: 40.5836, lng: 22.9502 }
    const onSave = vi.fn(async () => undefined)
    render(
      <EditCustomerInfoModal
        isOpen
        orderCount={1}
        initialCustomerInfo={{ ...baseInfo, coordinates: point, latitude: point.lat, longitude: point.lng }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ coordinates: point }))
  })

  it('saves only the floor of an unchanged legacy destination without requiring a geocoder point', async () => {
    mocks.validateAddressForDelivery.mockResolvedValue({ success: true, isValid: false, deliveryAvailable: false,
      validation_status: 'requires_selection', message: 'Coordinates required' })
    const onSave = vi.fn(async () => undefined)
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={{ ...baseInfo, orderType: 'delivery',
      addressId: 'saved-address', addressFingerprint: 'original-fingerprint', delivery_floor: '', latitude: null, longitude: null }}
      onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.floorPlaceholder'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ address: baseInfo.address, postal_code: baseInfo.postal_code,
      addressId: 'saved-address', addressFingerprint: 'original-fingerprint', delivery_floor: '2', coordinates: null }))
  })

  it.each(['address', 'postal'])('requires fresh validation for a changed %s, without borrowing the old point', async field => {
    mocks.validateAddressForDelivery.mockResolvedValue({ success: true, isValid: false, deliveryAvailable: false, validation_status: 'requires_selection' })
    const onSave = vi.fn()
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={{ ...baseInfo, coordinates: { lat: 40.6, lng: 22.9 } }} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(field === 'address' ? 'modals.editCustomer.addressPlaceholder' : 'modals.editCustomer.postalCodePlaceholder'), { target: { value: field === 'address' ? 'Other street 50' : '54321' } })
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(mocks.validateAddressForDelivery).toHaveBeenCalledTimes(1))
    expect(mocks.validateAddressForDelivery.mock.calls[0][1].coordinates).toBeUndefined()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('discards a delayed validation result after the destination changes during Save', async () => {
    let finish!: (value: any) => void
    mocks.validateAddressForDelivery.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const onSave = vi.fn()
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Changed 20' } })
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(mocks.validateAddressForDelivery).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Latest 30' } })
    await act(async () => { finish({ success: true, validation_status: 'in_zone', coordinates: { lat: 40.6, lng: 22.9 } }) })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder')).toHaveValue('Latest 30')
  })

  it('ignores delayed suggestion resolution after editing another destination', async () => {
    mocks.searchAddressSuggestions.mockResolvedValue([{ place_id: 'place-1' }])
    let finish!: (value: any) => void
    mocks.resolveAddressSuggestion.mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Changed 20' } })
    fireEvent.click(await screen.findByText('Suggested street'))
    await waitFor(() => expect(mocks.resolveAddressSuggestion).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Latest 30' } })
    await act(async () => { finish({ streetAddress: 'Old resolved 20', coordinates: { lat: 40.6, lng: 22.9 } }) })
    expect(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder')).toHaveValue('Latest 30')
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
  })

  it('retains a current address selection when only the floor changes during resolution', async () => {
    mocks.searchAddressSuggestions.mockResolvedValue([{ place_id: 'place-1' }])
    let finish!: (value: any) => void
    mocks.resolveAddressSuggestion.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const onSave = vi.fn()
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Changed 20' } })
    fireEvent.click(await screen.findByText('Suggested street'))
    await waitFor(() => expect(mocks.resolveAddressSuggestion).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.floorPlaceholder'), { target: { value: '5' } })
    await act(async () => { finish({ streetAddress: 'Resolved 20', postalCode: '54321', coordinates: { lat: 40.6, lng: 22.9 } }) })
    await waitFor(() => expect(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder')).toHaveValue('Resolved 20'))
    expect(screen.queryByText('modals.addCustomer.validatingAddress')).toBeNull()
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ address: 'Resolved 20', delivery_floor: '5', coordinates: { lat: 40.6, lng: 22.9 } }))
  })
})


describe('EditCustomerInfoModal typed address correction', () => {
  const point = { lat: 40.614, lng: 22.9603 };
  const located = { located: true, postalCodeDiffers: true, providerPostalCode: '54249', details: {
    streetAddress: baseInfo.address, city: 'Map City', postalCode: '54249', coordinates: point, placeId: 'typed-place',
    resolvedStreetNumber: '12', addressFingerprint: `${baseInfo.address}|${point.lat}|${point.lng}`, validationSource: 'online',
  } };
  const setup = () => {
    mocks.locateTypedAddress.mockResolvedValue(located);
    const onSave = vi.fn();
    const initial = { ...baseInfo, city: 'Typed City' };
    const view = render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={initial} onSave={onSave} onClose={vi.fn()} />);
    return { ...view, onSave, initial };
  };
  const postal = () => screen.getByPlaceholderText('modals.editCustomer.postalCodePlaceholder');

  it('debounces corrected postal code, retains city/postal fields, displays note and saves the located point and provenance', async () => {
    const { onSave } = setup();
    vi.useFakeTimers();
    fireEvent.change(postal(), { target: { value: '546 4' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(699); });
    expect(mocks.locateTypedAddress).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    vi.useRealTimers();
    expect(mocks.locateTypedAddress).toHaveBeenCalledTimes(1);
    expect(mocks.locateTypedAddress).toHaveBeenCalledWith({ street: baseInfo.address, city: 'Typed City', postalCode: '546 40' }, { branchId: 'branch-1' });
    expect(postal()).toHaveValue('546 40');
    expect(screen.getByText('modals.addCustomer.mapPostalCodeDiffers')).toBeInTheDocument();
    expect(screen.getByText('modals.addCustomer.deliveryAvailable')).toBeInTheDocument();
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ postal_code: '546 40', city: 'Typed City',
      coordinates: point, placeId: 'typed-place', resolvedStreetNumber: '12', validationSource: 'online' }));
    expect(mocks.locateTypedAddress).toHaveBeenCalledTimes(1);
  });

  it('drops a zone verdict when the cashier changes the street after typed location succeeds', async () => {
    setup();
    let finish!: (value: any) => void;
    mocks.validateAddressForDelivery.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await waitFor(() => expect(mocks.validateAddressForDelivery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Later Street 80' } });
    await act(async () => { finish({ success: true, isValid: true, validation_status: 'in_zone', coordinates: point }); });
    expect(screen.queryByText('modals.addCustomer.deliveryAvailable')).toBeNull();
    expect(screen.getByText('Select a real address from suggestions to validate delivery.')).toBeInTheDocument();
  });

  it.each(['not_found', 'error', 'offline', 'no_number'])('requires selection after %s', async (kind) => {
    setup();
    mocks.locateTypedAddress.mockResolvedValue({ located: false, reason: 'imprecise' });
    if (kind === 'error') mocks.locateTypedAddress.mockRejectedValue(new Error('400'));
    if (kind === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    if (kind === 'no_number') fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Street Only' } });
    vi.useFakeTimers();
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    vi.useRealTimers();
    expect(screen.getByText('Select a real address from suggestions to validate delivery.')).toBeInTheDocument();
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled();
    if (kind === 'offline' || kind === 'no_number') expect(mocks.locateTypedAddress).not.toHaveBeenCalled();
  });

  it.each(['street', 'postal', 'pick', 'cancel', 'close', 'customer', 'module', 'unmount'])('discards pending lookup after %s', async (kind) => {
    const view = setup();
    let finish!: (result: any) => void;
    mocks.locateTypedAddress.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(postal(), { target: { value: '546 40' } });
    await waitFor(() => expect(mocks.locateTypedAddress).toHaveBeenCalledTimes(1));
    expect(screen.getByText('modals.addCustomer.validatingAddress')).toBeInTheDocument();
    if (kind === 'street' || kind === 'pick') {
      mocks.searchAddressSuggestions.mockResolvedValue([{ place_id: 'later', secondary_text: 'City', distance_meters: 80 }]);
      fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Later Street 80' } });
      if (kind === 'pick') {
        mocks.resolveAddressSuggestion.mockResolvedValue({ ...located.details, placeId: 'later', streetAddress: 'Later Street 80' });
        fireEvent.click(await screen.findByText(/City.*80 m/));
        await waitFor(() => expect(mocks.validateAddressForDelivery).toHaveBeenCalledTimes(1));
      }
    } else if (kind === 'postal') fireEvent.change(postal(), { target: { value: '546 41' } });
    else if (kind === 'cancel') fireEvent.click(screen.getByText('modals.editCustomer.cancel'));
    else if (kind === 'unmount') view.unmount();
    else {
      if (kind === 'module') mocks.deliveryPro = false;
      view.rerender(<EditCustomerInfoModal isOpen={kind !== 'close'} orderCount={1}
      initialCustomerInfo={kind === 'customer' ? { ...view.initial, address: 'Other Customer Street 50' } : view.initial}
      onSave={view.onSave} onClose={vi.fn()} />);
    }
    await act(async () => { finish(located); });
    expect(screen.queryByText('modals.addCustomer.mapPostalCodeDiffers')).toBeNull();
    expect(mocks.validateAddressForDelivery.mock.calls.some(([, options]) => options.placeId === 'typed-place')).toBe(false);
  });
});
