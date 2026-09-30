import { describe, expect, it } from 'vitest'

import { resolveCanonicalCustomerAddress } from '../customer-addresses'
import { createUncheckedDeliveryZoneResult, getDeliveryFeeStatus, resolveDeliveryFee } from '../delivery-fee'
import {
  decidePickupToDeliveryZone,
  planDeliveryAddressRepick,
  planDeliveryZoneHandoff,
  resolveHandoffCustomer,
  toDeliveryZoneInfoFromModalValidation,
  withoutRepickTarget,
} from '../delivery-zone-handoff'

// Synthetic data only.
const EDITED_POINT = { lat: 40.5836, lng: 22.9502 }

const defaultWithoutPoint = {
  id: 'addr-default',
  street_address: 'Odos Proti 1',
  city: 'Kalamaria',
  postal_code: '55133',
  latitude: null,
  longitude: null,
  is_default: true,
  address_type: 'delivery',
  created_at: '2026-05-20T10:00:00Z',
}

const editedWithPoint = {
  id: 'addr-edited',
  street_address: 'Odos Deftera 2',
  city: 'Kalamaria',
  postal_code: '55133',
  latitude: EDITED_POINT.lat,
  longitude: EDITED_POINT.lng,
  is_default: false,
  address_type: 'delivery',
  created_at: '2026-06-01T10:00:00Z',
}

const inZoneModalCheck = {
  success: true,
  isValid: true,
  deliveryAvailable: true,
  validation_status: 'in_zone',
  requires_override: false,
  house_number_match: true,
  coordinates: EDITED_POINT,
  selectedZone: {
    id: 'zone-1',
    name: 'Zone 1',
    delivery_fee: 1.5,
    minimum_order_amount: 5,
    estimated_delivery_time_min: 25,
    estimated_delivery_time_max: 40,
  },
}

describe('address hand-off after the customer/address modal', () => {
  it('sends the order to the EDITED address, not the default (regression: default at (0,0))', () => {
    // What AddCustomerModal returns in editAddress mode today.
    const returned = {
      id: 'cust-1',
      name: 'Test Customer',
      editAddressId: 'addr-edited',
      addresses: [defaultWithoutPoint, editedWithPoint],
    }

    const handoff = resolveHandoffCustomer(returned)

    expect(handoff.address?.id).toBe('addr-edited')
    expect(handoff.addressFromModal).toBe(true)
    expect(handoff.customer.selected_address_id).toBe('addr-edited')
    expect('editAddressId' in handoff.customer).toBe(false)
    expect(resolveCanonicalCustomerAddress(handoff.customer)?.id).toBe('addr-edited')
  })

  it('prefers the modal\'s selected_address_id, then the previous choice for the same customer', () => {
    const base = { id: 'cust-1', addresses: [defaultWithoutPoint, editedWithPoint] }

    expect(resolveHandoffCustomer({ ...base, selected_address_id: 'addr-edited' }).address?.id).toBe('addr-edited')
    expect(resolveHandoffCustomer(base, { customerId: 'cust-1', selectedAddressId: 'addr-edited' }).address?.id)
      .toBe('addr-edited')
    expect(resolveHandoffCustomer(base, { customerId: 'cust-other', selectedAddressId: 'addr-edited' }).address?.id)
      .toBe('addr-default')
  })

  it('never keeps a modal zone check on the stored customer (it would come back stale)', () => {
    const handoff = resolveHandoffCustomer({
      id: 'cust-1',
      selected_address_id: 'addr-edited',
      delivery_zone_validation: inZoneModalCheck,
      addresses: [editedWithPoint],
    })
    expect('delivery_zone_validation' in handoff.customer).toBe(false)
  })

  it('reuses the modal\'s in-zone check for the address it saved (no second check)', () => {
    const plan = planDeliveryZoneHandoff({
      address: editedWithPoint,
      modalValidation: inZoneModalCheck,
      addressFromModal: true,
    })

    expect(plan.kind).toBe('reuse')
    if (plan.kind !== 'reuse') return
    expect(getDeliveryFeeStatus('delivery', plan.zoneInfo)).toBe('resolved')
    expect(resolveDeliveryFee(plan.zoneInfo)).toBe(1.5)
    expect(plan.zoneInfo.zone.minimumOrderAmount).toBe(5)
    expect(plan.zoneInfo.coordinates).toEqual(EDITED_POINT)
  })

  it('does not reuse a modal check for an address the modal did not name', () => {
    const plan = planDeliveryZoneHandoff({
      address: editedWithPoint,
      modalValidation: inZoneModalCheck,
      addressFromModal: false,
    })
    expect(plan).toEqual({ kind: 'check_point', point: EDITED_POINT })
  })

  it('never plans a (0,0) check: an address without a point is left to the menu', () => {
    expect(planDeliveryZoneHandoff({ address: defaultWithoutPoint })).toEqual({ kind: 'menu' })
    expect(planDeliveryZoneHandoff({ address: { ...defaultWithoutPoint, latitude: 0, longitude: 0 } }))
      .toEqual({ kind: 'menu' })
    expect(planDeliveryZoneHandoff({ address: { street_address: '#Beach bar', ...EDITED_POINT } }))
      .toEqual({ kind: 'menu' })
  })

  it('does not turn a modal "not checked" answer into a zone', () => {
    expect(toDeliveryZoneInfoFromModalValidation({
      success: true,
      isValid: false,
      validation_status: 'requires_selection',
      suggestedAction: 'geocode_first',
    })).toBeNull()
  })

  it('keeps a real out-of-zone modal answer (desktop override flow) resolving with fee 0', () => {
    const zoneInfo = toDeliveryZoneInfoFromModalValidation({
      success: true,
      isValid: false,
      validation_status: 'out_of_zone',
      requires_override: true,
      zone_checked: true,
      coordinates: EDITED_POINT,
    })
    expect(zoneInfo).not.toBeNull()
    expect(getDeliveryFeeStatus('delivery', zoneInfo)).toBe('resolved')
    expect(resolveDeliveryFee(zoneInfo)).toBe(0)
  })
})

describe('"pick the address again" (re-pick) helpers', () => {
  const customer = { id: 'cust-1', name: 'Test', selected_address_id: 'addr-default' }

  it("opens the address editor on the order's saved address", () => {
    const plan = planDeliveryAddressRepick(customer, { id: 'addr-edited' })
    expect(plan).toEqual({
      kind: 'edit_address',
      customer: { ...customer, selected_address_id: 'addr-edited', editAddressId: 'addr-edited' },
    })
  })

  it("falls back to the order's address form without a saved address row or customer id", () => {
    expect(planDeliveryAddressRepick(customer, null)).toEqual({ kind: 'order_address_form' })
    expect(planDeliveryAddressRepick({ name: 'Walk-in' } as never, { id: 'addr-1' })).toEqual({ kind: 'order_address_form' })
    expect(planDeliveryAddressRepick(null, { id: 'addr-1' })).toEqual({ kind: 'order_address_form' })
  })

  it('closing without saving keeps the customer and drops only the edit target', () => {
    const repicking = { ...customer, selected_address_id: 'addr-edited', editAddressId: 'addr-edited' }
    expect(withoutRepickTarget(repicking)).toEqual({ ...customer, selected_address_id: 'addr-edited' })
    expect(withoutRepickTarget(null)).toBeNull()
  })
})

describe('pickup -> delivery conversion zone decision', () => {
  it('a zone that was not checked proceeds with no override', () => {
    expect(decidePickupToDeliveryZone(createUncheckedDeliveryZoneResult())).toEqual({
      zoneNotChecked: true,
      canProceed: true,
      canAttemptOverride: false,
    })
    // The legacy out_of_zone shape of an unusable point is "not checked" too.
    expect(decidePickupToDeliveryZone({
      success: true,
      isValid: false,
      deliveryAvailable: false,
      validation_status: 'out_of_zone',
      zone_checked: false,
      uiState: { canProceed: false, showOverrideOption: true, requiresManagerApproval: true },
    } as never)).toMatchObject({ zoneNotChecked: true, canProceed: true, canAttemptOverride: false })
  })

  it('a genuine out_of_zone keeps the manager override flow', () => {
    expect(decidePickupToDeliveryZone({
      success: true,
      isValid: false,
      deliveryAvailable: false,
      validation_status: 'out_of_zone',
      zone_checked: true,
      uiState: { canProceed: false, showOverrideOption: true, requiresManagerApproval: true },
    } as never)).toEqual({ zoneNotChecked: false, canProceed: false, canAttemptOverride: true })
  })

  it('an in-zone answer proceeds; a failed check with no override option does not', () => {
    expect(decidePickupToDeliveryZone({
      success: true, isValid: true, deliveryAvailable: true, uiState: { canProceed: true },
    } as never)).toMatchObject({ canProceed: true, canAttemptOverride: false })
    expect(decidePickupToDeliveryZone(null)).toEqual({ zoneNotChecked: false, canProceed: false, canAttemptOverride: false })
  })
})
