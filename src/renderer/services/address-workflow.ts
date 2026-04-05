import { getBridge, onEvent } from '../../lib';
import { posApiPost } from '../utils/api-helpers';
import { resolveAddressLanguage } from '../utils/address-language';
import {
  extractStreetNumber,
  selectResolvedStreetNumber,
} from './address-house-number';
import { getResolvedTerminalCredentials } from './terminal-credentials';

export {
  extractStreetNumber,
  houseNumbersMatch,
  normalizeHouseNumber,
  parseHouseNumberParts,
  selectResolvedStreetNumber,
  type HouseNumberParts,
} from './address-house-number';

export type ValidationStatus =
  | 'in_zone'
  | 'out_of_zone'
  | 'module_disabled'
  | 'unverified_offline'
  | 'requires_selection'
  | 'validating';

export interface AddressSuggestion {
  place_id: string;
  name: string;
  formatted_address: string;
  displayLabel?: string;
  main_text?: string;
  secondary_text?: string;
  location?: { lat: number; lng: number };
  types?: string[];
  verified?: boolean;
  source: 'online' | 'offline_cache';
  city?: string;
  postal_code?: string;
  resolved_street_number?: string;
  address_fingerprint?: string;
  validation_source?: 'online' | 'offline_cache';
}

export interface ResolvedAddressDetails {
  streetAddress: string;
  city: string;
  postalCode: string;
  coordinates?: { lat: number; lng: number };
  placeId?: string;
  formattedAddress?: string;
  resolvedStreetNumber?: string;
  addressFingerprint: string;
  validationSource: 'online' | 'offline_cache';
}

export interface DeliveryValidationResult {
  success: boolean;
  isValid: boolean;
  deliveryAvailable: boolean;
  validation_status: ValidationStatus;
  requires_override: boolean;
  house_number_match: boolean;
  reason?: string;
  message?: string;
  suggestedAction?: string;
  selectedZone?: any;
  coordinates?: { lat: number; lng: number };
  address_fingerprint?: string;
  validation_source?: 'online' | 'offline_cache';
  meetsMinimumOrder?: boolean;
  minimumOrderAmount?: number;
}

interface SearchOptions {
  branchId?: string;
  location?: { latitude: number; longitude: number } | null;
  radius?: number;
  limit?: number;
  sessionToken?: string;
}

interface ResolveOptions {
  branchId?: string;
  sessionToken?: string;
}

interface ValidateOptions {
  branchId?: string;
  orderAmount?: number;
  placeId?: string;
  coordinates?: { lat: number; lng: number };
  inputStreetNumber?: string;
  resolvedStreetNumber?: string;
  addressFingerprint?: string;
  validationSource?: 'online' | 'offline_cache';
}

const CACHE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
let runtimeInitialized = false;
let lastCacheRefreshMs = 0;
let activeBranchId: string | undefined;

export function createAddressSessionToken(): string {
  return [
    'addr',
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 12),
  ].join('_');
}

function isOnline(): boolean {
  if (typeof navigator === 'undefined') {
    return true;
  }
  return navigator.onLine;
}

function normalizePlaceId(raw: any): string {
  return String(raw?.place_id || raw?.id || `local-${Math.random().toString(36).slice(2)}`);
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractPrimaryStreetText(value: unknown): string {
  const sanitized = sanitizeString(value);
  if (!sanitized) {
    return '';
  }
  const [firstSegment] = sanitized.split(',');
  return sanitizeString(firstSegment);
}

function normalizeSuggestionLocation(value: any): { lat: number; lng: number } | undefined {
  const lat = value?.lat ?? value?.latitude;
  const lng = value?.lng ?? value?.longitude;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return {
      lat: Number(lat),
      lng: Number(lng),
    };
  }
  return undefined;
}

export function getSuggestionStreetLabel(
  suggestion?: Partial<Pick<AddressSuggestion, 'displayLabel' | 'main_text' | 'name' | 'formatted_address'>> | null
): string {
  return (
    sanitizeString(suggestion?.displayLabel)
    || sanitizeString(suggestion?.main_text)
    || sanitizeString(suggestion?.name)
    || extractPrimaryStreetText(suggestion?.formatted_address)
  );
}

function isAddressLikeSuggestion(candidate: AddressSuggestion): boolean {
  const types = Array.isArray(candidate.types) ? candidate.types.map((t) => String(t).toLowerCase()) : [];
  const formatted = `${getSuggestionStreetLabel(candidate)} ${candidate.formatted_address}`.toLowerCase();

  if (types.some((t) => ['street_address', 'route', 'premise', 'subpremise', 'geocode', 'address'].includes(t))) {
    return true;
  }
  if (types.some((t) => ['locality', 'sublocality', 'sublocality_level_1', 'neighborhood', 'postal_town', 'administrative_area_level_3'].includes(t))) {
    return true;
  }
  if ((candidate.formatted_address || '').includes(',')) {
    return true;
  }
  return /(\d+[a-zα-ω]?|\bοδός\b|\bstreet\b|\broad\b|\bavenue\b)/u.test(formatted);
}

function scoreSuggestion(query: string, candidate: AddressSuggestion): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = getSuggestionStreetLabel(candidate).toLowerCase();
  const formatted = candidate.formatted_address.toLowerCase();
  let score = 0;
  if (name.startsWith(q)) score += 100;
  if (formatted.startsWith(q)) score += 80;
  if (name.includes(q)) score += 50;
  if (formatted.includes(q)) score += 30;
  if (isAddressLikeSuggestion(candidate)) score += 40;
  if (candidate.source === 'offline_cache') score += 10;
  return score;
}

export function buildAddressFingerprint(
  address: string,
  coordinates?: { lat: number; lng: number }
): string {
  const normalized = address.trim().toLowerCase();
  if (coordinates && Number.isFinite(coordinates.lat) && Number.isFinite(coordinates.lng)) {
    return `${normalized}|${coordinates.lat.toFixed(5)}|${coordinates.lng.toFixed(5)}`;
  }
  return normalized;
}

async function refreshDeliveryZoneCache(branchId?: string): Promise<void> {
  const now = Date.now();
  if (!isOnline()) return;
  if (now - lastCacheRefreshMs < CACHE_REFRESH_INTERVAL_MS) return;

  const bridge = getBridge();
  await bridge.deliveryZones.cacheRefresh({
    branchId: branchId || activeBranchId || undefined,
  }).catch(() => null);
  lastCacheRefreshMs = now;
}

export async function ensureAddressOfflineRuntime(branchId?: string): Promise<void> {
  if (branchId) {
    activeBranchId = branchId;
  }

  if (!runtimeInitialized) {
    runtimeInitialized = true;

    setInterval(() => {
      if (isOnline()) {
        void refreshDeliveryZoneCache(activeBranchId);
      }
    }, CACHE_REFRESH_INTERVAL_MS);

    onEvent('sync:complete', () => {
      void refreshDeliveryZoneCache(activeBranchId);
    });

    onEvent('network:status', (payload: any) => {
      if (payload?.isOnline) {
        void refreshDeliveryZoneCache(activeBranchId);
      }
    });
  }

  await refreshDeliveryZoneCache(branchId || activeBranchId);
}

function dedupeSuggestions(candidates: AddressSuggestion[]): AddressSuggestion[] {
  const deduped = new Map<string, AddressSuggestion>();

  for (const candidate of candidates) {
    const key = candidate.place_id;
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
      continue;
    }

    const existing = deduped.get(key)!;
    const existingScore =
      (existing.location ? 2 : 0)
      + ((existing.types?.length || 0) > 0 ? 1 : 0)
      + (existing.formatted_address.length > 0 ? 1 : 0)
      + (existing.displayLabel ? 1 : 0)
      + (existing.main_text ? 1 : 0)
      + (existing.secondary_text ? 1 : 0);
    const nextScore =
      (candidate.location ? 2 : 0)
      + ((candidate.types?.length || 0) > 0 ? 1 : 0)
      + (candidate.formatted_address.length > 0 ? 1 : 0)
      + (candidate.displayLabel ? 1 : 0)
      + (candidate.main_text ? 1 : 0)
      + (candidate.secondary_text ? 1 : 0);
    if (nextScore > existingScore) {
      deduped.set(key, candidate);
    }
  }

  return Array.from(deduped.values());
}

function normalizeOnlinePredictionSuggestions(raw: any): AddressSuggestion[] {
  const predictions = Array.isArray(raw?.predictions) ? raw.predictions : [];

  return dedupeSuggestions(
    predictions.map((prediction: any) => {
      const formattedAddress = sanitizeString(
        prediction.description || prediction.formatted_address || prediction.main_text
      );
      const displayLabel =
        sanitizeString(prediction.structured_formatting?.main_text)
        || sanitizeString(prediction.main_text)
        || extractPrimaryStreetText(formattedAddress)
        || 'Address';

      return {
        place_id: normalizePlaceId(prediction),
        name: displayLabel,
        displayLabel,
        main_text: displayLabel,
        secondary_text:
          sanitizeString(prediction.structured_formatting?.secondary_text)
          || sanitizeString(prediction.secondary_text)
          || formattedAddress,
        formatted_address: formattedAddress,
        location: normalizeSuggestionLocation(prediction.location),
        types: Array.isArray(prediction.types) ? prediction.types : [],
        source: 'online',
        validation_source: 'online',
      };
    })
  );
}

function normalizeOnlinePlaceSuggestions(raw: any): AddressSuggestion[] {
  const places = Array.isArray(raw?.places) ? raw.places : [];

  return dedupeSuggestions(
    places.map((place: any) => {
      const formattedAddress = sanitizeString(place.formatted_address || place.description || place.name);
      const displayLabel =
        sanitizeString(place.main_text)
        || sanitizeString(place.structured_formatting?.main_text)
        || sanitizeString(place.name)
        || extractPrimaryStreetText(formattedAddress)
        || 'Address';

      return {
        place_id: normalizePlaceId(place),
        name: displayLabel,
        displayLabel,
        main_text: displayLabel,
        secondary_text:
          sanitizeString(place.secondary_text)
          || sanitizeString(place.structured_formatting?.secondary_text)
          || formattedAddress,
        formatted_address: formattedAddress,
        location: normalizeSuggestionLocation(place.location),
        types: Array.isArray(place.types) ? place.types : [],
        source: 'online',
        validation_source: 'online',
      };
    })
  );
}

export function selectPrimaryOnlineSuggestions(
  autocompleteRaw: any,
  searchPlacesRaw?: any
): AddressSuggestion[] {
  const predictions = normalizeOnlinePredictionSuggestions(autocompleteRaw);
  if (predictions.length > 0) {
    return predictions;
  }

  const autocompletePlaces = normalizeOnlinePlaceSuggestions(autocompleteRaw);
  if (autocompletePlaces.length > 0) {
    return autocompletePlaces;
  }

  return normalizeOnlinePlaceSuggestions(searchPlacesRaw);
}

function normalizeLocalPlaces(raw: any): AddressSuggestion[] {
  const places = Array.isArray(raw?.places)
    ? raw.places
    : Array.isArray(raw?.data?.places)
      ? raw.data.places
      : [];

  return places.map((place: any) => ({
    place_id: normalizePlaceId(place),
    name: sanitizeString(place.name || place.street_address || place.address) || 'Address',
    displayLabel: sanitizeString(place.name || place.street_address || place.address) || 'Address',
    main_text: sanitizeString(place.name || place.street_address || place.address) || 'Address',
    secondary_text: sanitizeString(place.formatted_address || place.city || place.postal_code || ''),
    formatted_address: sanitizeString(place.formatted_address || place.name || place.street_address),
    city: sanitizeString(place.city),
    postal_code: sanitizeString(place.postal_code),
    location:
      place.location &&
      Number.isFinite(place.location.lat) &&
      Number.isFinite(place.location.lng)
        ? { lat: Number(place.location.lat), lng: Number(place.location.lng) }
        : undefined,
    types: Array.isArray(place.types) ? place.types : [],
    verified: place?.verified === true,
    source: 'offline_cache',
    validation_source: 'offline_cache',
    resolved_street_number: sanitizeString(place.resolved_street_number) || undefined,
    address_fingerprint: sanitizeString(place.address_fingerprint) || undefined,
  }));
}

async function fetchOnlineSuggestions(
  query: string,
  options: SearchOptions
): Promise<AddressSuggestion[]> {
  const creds = await getResolvedTerminalCredentials();
  const language = resolveAddressLanguage(query);
  const payload = {
    query: query.trim(),
    branchId: options.branchId || creds.branchId || undefined,
    branch_id: options.branchId || creds.branchId || undefined,
    location: options.location || undefined,
    radius: options.radius || undefined,
    language,
    session_token: options.sessionToken || undefined,
  };

  try {
    const response = await posApiPost<any>('pos/address/autocomplete', payload);
    if (response.success) {
      const normalized = selectPrimaryOnlineSuggestions(response.data);
      if (normalized.length > 0) {
        return normalized
          .sort((a, b) => scoreSuggestion(query, b) - scoreSuggestion(query, a))
          .slice(0, options.limit || 5);
      }
    }
  } catch {
    // Continue to offline fallback.
  }

  return [];
}

async function fetchLocalSuggestions(
  query: string,
  options: SearchOptions
): Promise<AddressSuggestion[]> {
  const bridge = getBridge();
  const raw = await bridge.address.searchLocal({
    query,
    branchId: options.branchId || undefined,
    branch_id: options.branchId || undefined,
    limit: options.limit || 5,
  }).catch(() => ({ places: [] }));
  return normalizeLocalPlaces(raw)
    .filter((candidate) => candidate.verified === true)
    .sort((a, b) => scoreSuggestion(query, b) - scoreSuggestion(query, a))
    .slice(0, options.limit || 5);
}

export async function searchAddressSuggestions(
  query: string,
  options: SearchOptions = {}
): Promise<AddressSuggestion[]> {
  if (query.trim().length < 3) {
    return [];
  }

  await ensureAddressOfflineRuntime(options.branchId);

  if (isOnline()) {
    const online = await fetchOnlineSuggestions(query, options);
    if (online.length > 0) {
      return online;
    }
  }

  return fetchLocalSuggestions(query, options);
}

function extractFromAddressComponents(components: any[]): {
  route: string;
  streetNumber?: string;
  city: string;
  postalCode: string;
} {
  const findComp = (type: string) =>
    components.find((component: any) => Array.isArray(component?.types) && component.types.includes(type));

  const route = sanitizeString(findComp('route')?.long_name);
  const streetNumber = sanitizeString(findComp('street_number')?.long_name) || undefined;
  const city =
    sanitizeString(findComp('locality')?.long_name) ||
    sanitizeString(findComp('administrative_area_level_3')?.long_name) ||
    sanitizeString(findComp('administrative_area_level_2')?.long_name);
  const postalCode = sanitizeString(findComp('postal_code')?.long_name);

  return { route, streetNumber, city, postalCode };
}

export function buildResolvedAddressDetails(
  suggestion: AddressSuggestion,
  result: any
): ResolvedAddressDetails {
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  const extracted = extractFromAddressComponents(components);
  const geometry = result?.geometry?.location;
  const coordinates =
    geometry && Number.isFinite(geometry.lat) && Number.isFinite(geometry.lng)
      ? { lat: Number(geometry.lat), lng: Number(geometry.lng) }
      : suggestion.location;
  const selectedStreet = getSuggestionStreetLabel(suggestion);
  const formattedAddress = sanitizeString(result?.formatted_address || suggestion.formatted_address);
  const resolvedStreetNumber = selectResolvedStreetNumber(
    extracted.streetNumber,
    selectedStreet || extracted.route || formattedAddress,
    formattedAddress
  );
  const canonicalStreet =
    extracted.route && resolvedStreetNumber
      ? `${extracted.route} ${resolvedStreetNumber}`
      : extracted.route;
  const streetAddress =
    selectedStreet
    || canonicalStreet
    || extractPrimaryStreetText(formattedAddress)
    || 'Address';

  return {
    streetAddress,
    city: extracted.city,
    postalCode: extracted.postalCode,
    coordinates,
    placeId: sanitizeString(result?.place_id) || suggestion.place_id,
    formattedAddress,
    resolvedStreetNumber,
    addressFingerprint: buildAddressFingerprint(streetAddress, coordinates),
    validationSource: 'online',
  };
}

export async function resolveAddressSuggestion(
  suggestion: AddressSuggestion,
  input: string,
  options: ResolveOptions = {}
): Promise<ResolvedAddressDetails> {
  const coords = suggestion.location;
  const fallbackStreet = getSuggestionStreetLabel(suggestion) || extractPrimaryStreetText(suggestion.formatted_address);

  if (suggestion.source === 'offline_cache') {
    const street = fallbackStreet;
    const fingerprint = suggestion.address_fingerprint || buildAddressFingerprint(street, coords);
    return {
      streetAddress: street,
      city: suggestion.city || '',
      postalCode: suggestion.postal_code || '',
      coordinates: coords,
      placeId: suggestion.place_id,
      formattedAddress: suggestion.formatted_address,
      resolvedStreetNumber: selectResolvedStreetNumber(
        suggestion.resolved_street_number,
        street,
        suggestion.formatted_address
      ),
      addressFingerprint: fingerprint,
      validationSource: 'offline_cache',
    };
  }

  const language = resolveAddressLanguage(input, suggestion.formatted_address, getSuggestionStreetLabel(suggestion));
  const payload = {
    place_id: suggestion.place_id,
    location: suggestion.location || undefined,
    formatted_address: suggestion.formatted_address || undefined,
    language,
    session_token: options.sessionToken || undefined,
  };

  try {
    const response = await posApiPost<any>('pos/address/details', payload);
    if (response.success) {
      const result = response.data?.result || response.data;
      return buildResolvedAddressDetails(suggestion, result);
    }
  } catch {
    // Fall through to offline/caller error handling.
  }

  throw new Error('Unable to resolve suggestion details');
}

function normalizeDeliveryValidation(raw: any, fallbackSource: 'online' | 'offline_cache'): DeliveryValidationResult {
  const status: ValidationStatus =
    raw?.validation_status === 'module_disabled'
      ? 'module_disabled'
      : raw?.validation_status || (raw?.isValid ? 'in_zone' : 'out_of_zone');
  const requiresOverride = Boolean(
    raw?.requires_override ?? (status === 'out_of_zone' || status === 'unverified_offline')
  );
  return {
    success: raw?.success !== false,
    isValid: Boolean(raw?.isValid || status === 'in_zone' || status === 'module_disabled'),
    deliveryAvailable: Boolean(
      raw?.deliveryAvailable
        ?? raw?.delivery_available
        ?? raw?.isValid
        ?? (status === 'in_zone' || status === 'module_disabled')
    ),
    validation_status: status,
    requires_override: requiresOverride,
    house_number_match: Boolean(raw?.house_number_match ?? true),
    reason: sanitizeString(raw?.reason || raw?.message) || undefined,
    message: sanitizeString(raw?.message || raw?.reason) || undefined,
    suggestedAction: sanitizeString(raw?.suggestedAction),
    selectedZone: raw?.selectedZone,
    coordinates: raw?.coordinates,
    address_fingerprint: sanitizeString(raw?.address_fingerprint) || undefined,
    validation_source: raw?.validation_source || fallbackSource,
    meetsMinimumOrder: typeof raw?.meetsMinimumOrder === 'boolean' ? raw.meetsMinimumOrder : undefined,
    minimumOrderAmount: typeof raw?.minimumOrderAmount === 'number' ? raw.minimumOrderAmount : undefined,
  };
}

export async function validateAddressForDelivery(
  address: string,
  options: ValidateOptions = {}
): Promise<DeliveryValidationResult> {
  const creds = await getResolvedTerminalCredentials();
  const payload = {
    address,
    orderAmount: options.orderAmount ?? 0,
    coordinates: options.coordinates || undefined,
    branchId: options.branchId || creds.branchId || undefined,
    place_id: options.placeId || undefined,
    input_street_number: options.inputStreetNumber || extractStreetNumber(address) || undefined,
    resolved_street_number: options.resolvedStreetNumber || undefined,
    address_fingerprint:
      options.addressFingerprint || buildAddressFingerprint(address, options.coordinates),
    validation_source: options.validationSource || 'online',
  };

  if (isOnline()) {
    try {
      const onlineResponse = await posApiPost<any>('pos/delivery-zones/validate', payload);
      if (onlineResponse.success && onlineResponse.data) {
        return normalizeDeliveryValidation(onlineResponse.data, 'online');
      }
    } catch {
      // Fall through to offline path.
    }
  }

  const bridge = getBridge();
  const local = await bridge.deliveryZones.validateLocal({
    ...payload,
    validation_source: 'offline_cache',
  }).catch(() => null);

  if (local) {
    return normalizeDeliveryValidation(local, 'offline_cache');
  }

  return {
    success: false,
    isValid: false,
    deliveryAvailable: false,
    validation_status: 'unverified_offline',
    requires_override: true,
    house_number_match: true,
    reason: 'Unable to validate address right now',
    message: 'Unable to validate address right now',
    address_fingerprint: payload.address_fingerprint,
    validation_source: 'offline_cache',
  };
}

export async function upsertVerifiedLocalCandidate(payload: Record<string, unknown>): Promise<void> {
  const bridge = getBridge();
  await bridge.address.upsertLocalCandidate(payload).catch(() => null);
}
