import {
  extractStreetNumber,
  resolveAddressSuggestion,
  searchAddressSuggestions,
} from '../services/address-workflow';

export interface SavedAddressLike {
  street_address?: string;
  street?: string;
  city?: string;
  postal_code?: string;
  postalCode?: string;
  latitude?: number | null;
  longitude?: number | null;
  lat?: number | null;
  lng?: number | null;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
}

export interface ResolvedSavedAddress {
  coordinates: { lat: number; lng: number };
  addressFingerprint?: string;
  placeId?: string;
  resolvedStreetNumber?: string;
  validationSource?: 'online' | 'offline_cache';
}

function normalizeText(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0370-\u03ff\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSavedAddressCoordinates(
  address?: SavedAddressLike | null
): { lat: number; lng: number } | null {
  if (!address) {
    return null;
  }

  const directCoordinates = address.coordinates;
  if (
    directCoordinates &&
    typeof directCoordinates === 'object' &&
    'lat' in directCoordinates &&
    'lng' in directCoordinates &&
    Number.isFinite(Number(directCoordinates.lat)) &&
    Number.isFinite(Number(directCoordinates.lng))
  ) {
    return {
      lat: Number(directCoordinates.lat),
      lng: Number(directCoordinates.lng),
    };
  }

  const geoJsonCoordinates =
    directCoordinates &&
    typeof directCoordinates === 'object' &&
    'coordinates' in directCoordinates
      ? directCoordinates.coordinates
      : undefined;

  if (
    Array.isArray(geoJsonCoordinates) &&
    geoJsonCoordinates.length >= 2 &&
    Number.isFinite(Number(geoJsonCoordinates[0])) &&
    Number.isFinite(Number(geoJsonCoordinates[1]))
  ) {
    return {
      lat: Number(geoJsonCoordinates[1]),
      lng: Number(geoJsonCoordinates[0]),
    };
  }

  const latitude = Number(address.latitude ?? address.lat);
  const longitude = Number(address.longitude ?? address.lng);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return {
      lat: latitude,
      lng: longitude,
    };
  }

  return null;
}

export function buildSavedAddressQuery(address?: SavedAddressLike | null): string {
  if (!address) {
    return '';
  }

  return [
    address.street_address || address.street || '',
    address.city || '',
    address.postal_code || address.postalCode || '',
  ]
    .filter(Boolean)
    .join(', ')
    .trim();
}

function scoreSuggestion(
  address: SavedAddressLike,
  suggestion: {
    name?: string;
    main_text?: string;
    formatted_address?: string;
    city?: string;
    postal_code?: string;
    resolved_street_number?: string;
  }
): number {
  const street = normalizeText(address.street_address || address.street || '');
  const city = normalizeText(address.city || '');
  const postalCode = normalizeText(address.postal_code || address.postalCode || '').replace(/\s+/g, '');
  const streetNumber = normalizeText(extractStreetNumber(address.street_address || address.street || '') || '');

  const haystack = normalizeText(
    [suggestion.main_text, suggestion.name, suggestion.formatted_address].filter(Boolean).join(' ')
  );

  let score = 0;
  if (street && haystack.includes(street)) {
    score += 4;
  }
  if (city) {
    const candidateCity = normalizeText(suggestion.city || suggestion.formatted_address || '');
    if (candidateCity.includes(city) || city.includes(candidateCity)) {
      score += 2;
    }
  }
  if (postalCode) {
    const candidatePostalCode = normalizeText(suggestion.postal_code || suggestion.formatted_address || '').replace(/\s+/g, '');
    if (candidatePostalCode.includes(postalCode) || postalCode.includes(candidatePostalCode)) {
      score += 2;
    }
  }
  if (streetNumber) {
    const candidateStreetNumber = normalizeText(
      suggestion.resolved_street_number || extractStreetNumber(suggestion.main_text || suggestion.name || suggestion.formatted_address || '') || ''
    );
    if (candidateStreetNumber && candidateStreetNumber === streetNumber) {
      score += 4;
    }
  }

  return score;
}

export async function resolveSavedAddressCoordinates(
  address: SavedAddressLike,
  branchId?: string
): Promise<ResolvedSavedAddress | null> {
  const existingCoordinates = extractSavedAddressCoordinates(address);
  if (existingCoordinates) {
    return {
      coordinates: existingCoordinates,
    };
  }

  const query = buildSavedAddressQuery(address);
  if (!query) {
    return null;
  }

  const suggestions = await searchAddressSuggestions(query, {
    branchId,
    limit: 5,
  });

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  const bestSuggestion = [...suggestions]
    .sort((left, right) => scoreSuggestion(address, right) - scoreSuggestion(address, left))[0];

  if (!bestSuggestion || scoreSuggestion(address, bestSuggestion) < 4) {
    return null;
  }

  const resolved = await resolveAddressSuggestion(bestSuggestion, query, {
    branchId,
  });

  if (!resolved.coordinates) {
    return null;
  }

  const expectedStreetNumber = normalizeText(
    extractStreetNumber(address.street_address || address.street || '') || ''
  );
  const resolvedStreetNumber = normalizeText(resolved.resolvedStreetNumber || '');
  if (expectedStreetNumber && resolvedStreetNumber && expectedStreetNumber !== resolvedStreetNumber) {
    return null;
  }

  return {
    coordinates: resolved.coordinates,
    addressFingerprint: resolved.addressFingerprint,
    placeId: resolved.placeId,
    resolvedStreetNumber: resolved.resolvedStreetNumber,
    validationSource: resolved.validationSource,
  };
}
