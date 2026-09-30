import { describe, expect, it } from 'vitest'

import { buildResolvedAddressDetails, type AddressSuggestion } from '../../services/address-workflow'
import { resolvedPlaceMatchesSavedAddress } from '../saved-address-geolocation'

/**
 * Desktop/Android parity for automatic geolocation of a saved address without
 * coordinates (founder decision 4, 2026-09-29: "same behaviour on desktop and
 * Android"). The cases below are the Android cases of
 * POSSystemMobile/src/utils/deliveryZoneCheck.test.ts
 * (placeDetailsMatchSavedAddress), run through the desktop path: the same
 * Google place-details payload goes through address-workflow's
 * buildResolvedAddressDetails and then resolvedPlaceMatchesSavedAddress.
 * Keep the two tables in step.
 *
 * Review finding: desktop compared the municipality exactly and accepted any
 * postal-code length, so "Καλαμαριά" (saved) against Google's
 * "Δήμος Καλαμαριάς" was located on Android but "not checked" on desktop.
 */
const suggestion: AddressSuggestion = {
  place_id: 'google-place',
  name: 'Οδός Δοκιμής 12',
  formatted_address: 'Οδός Δοκιμής 12',
  source: 'online',
}

// Same shape as Android's googleDetails() helper.
function googleDetails(overrides: { postal?: string; locality?: string; number?: string; route?: string }) {
  return {
    place_id: 'google-place',
    address_components: [
      ...(overrides.number ? [{ long_name: overrides.number, short_name: overrides.number, types: ['street_number'] }] : []),
      { long_name: overrides.route ?? 'Οδός Δοκιμής', short_name: overrides.route ?? 'Οδός Δοκιμής', types: ['route'] },
      ...(overrides.locality
        ? [{ long_name: overrides.locality, short_name: overrides.locality, types: ['locality', 'political'] }]
        : []),
      ...(overrides.postal ? [{ long_name: overrides.postal, short_name: overrides.postal, types: ['postal_code'] }] : []),
    ],
    geometry: { location: { lat: 40.5836, lng: 22.9502 } },
  }
}

function matches(target: { street: string; city: string; postalCode: string }, details: ReturnType<typeof googleDetails>) {
  // The desktop suggestion label carries no number, so the house number must
  // come from the place itself (as on Android).
  const resolved = buildResolvedAddressDetails({ ...suggestion, name: '', formatted_address: '' }, details)
  return resolvedPlaceMatchesSavedAddress(
    { street_address: target.street, city: target.city, postal_code: target.postalCode },
    resolved,
  )
}

describe('automatic location is accepted only in the saved area (Android parity table)', () => {
  const target = { street: 'Οδός Δοκιμής 12', city: 'Καλαμαριά', postalCode: '551 33' }

  it('accepts the same postal code, house number and street', () => {
    expect(matches(target, googleDetails({ postal: '55133', locality: 'Kalamaria', number: '12' }))).toBe(true)
  })

  it('rejects the same street in another postal area even when the municipality text matches', () => {
    expect(matches(target, googleDetails({ postal: '546 21', locality: 'Καλαμαριά', number: '12' }))).toBe(false)
  })

  it('uses the municipality when the saved address has no postal code (accents and genitive tolerated)', () => {
    const noPostal = { ...target, postalCode: '' }
    expect(matches(noPostal, googleDetails({ locality: 'Δήμος Καλαμαριάς', number: '12' }))).toBe(true)
    expect(matches(noPostal, googleDetails({ locality: 'Πυλαία', number: '12' }))).toBe(false)
  })

  it('rejects another house number, a result without one, or another street', () => {
    expect(matches(target, googleDetails({ postal: '55133', number: '14' }))).toBe(false)
    expect(matches(target, googleDetails({ postal: '55133' }))).toBe(false)
    expect(matches(target, googleDetails({ postal: '55133', number: '12', route: 'Άλλη Οδός' }))).toBe(false)
  })

  it('cannot verify an address without postal code and municipality', () => {
    expect(matches({ street: 'Οδός Δοκιμής 12', city: '', postalCode: '' }, googleDetails({ postal: '55133', number: '12' }))).toBe(false)
  })

  it('compares house-number digits (12Α = 12), like Android', () => {
    expect(matches({ ...target, street: 'Οδός Δοκιμής 12Α' }, googleDetails({ postal: '55133', number: '12' }))).toBe(true)
  })
})
