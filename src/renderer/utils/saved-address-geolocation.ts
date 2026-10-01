import {
  createAddressSessionToken,
  extractStreetNumber,
  resolveAddressSuggestion,
  searchAddressSuggestions,
  type AddressSuggestion,
  type ResolvedAddressDetails,
} from '../services/address-workflow';
import { readSavedAddressPoint, toValidLatLng, type LatLng } from './coordinates';
import { parseSpecialAddressInput } from './specialAddress';

export interface SavedAddressLike {
  id?: unknown;
  google_place_id?: string | null;
  place_id?: string | null;
  coordinate_source?: string | null;
  geocoded_at?: string | null;
  street_address?: string | null;
  street?: string | null;
  city?: string | null;
  postal_code?: string | null;
  postalCode?: string | null;
  latitude?: unknown;
  longitude?: unknown;
  lat?: unknown;
  lng?: unknown;
  coordinates?: unknown;
}

export interface ResolvedSavedAddress {
  coordinates: LatLng;
  /**
   * 'saved': the address already carried a real point.
   * 'geocoded': found by text search and accepted because its area matched.
   * Only a geocoded point is written back to the address.
   */
  source: 'saved' | 'geocoded';
  addressFingerprint?: string;
  placeId?: string;
  resolvedStreetNumber?: string;
  validationSource?: 'online' | 'offline_cache';
}

/**
 * Details lookups per address: each one can be a billable Google call, and
 * the best-ranked suggestions are tried first. Same cap as Android
 * (MAX_GEOLOCATION_DETAILS_LOOKUPS in POSSystemMobile deliveryZoneCheck.ts).
 */
const MAX_DETAIL_LOOKUPS = 2;
/** A located point is remembered longer than a miss (same TTLs as Android). */
const GEOLOCATION_MATCH_TTL_MS = 30 * 60 * 1000;
const GEOLOCATION_MISS_TTL_MS = 5 * 60 * 1000;
const GEOLOCATION_MEMO_LIMIT = 500;

/**
 * The longest a caller waits for automatic geolocation. Each lookup sits
 * behind the 30 s admin-fetch timeout, so a hanging admin API would otherwise
 * keep the menu's checkout disabled for up to about two minutes. After the
 * budget the answer is "not located" (the zone is "not checked", never
 * blocking); a lookup that finishes later is still remembered for the next
 * order.
 */
export const SAVED_ADDRESS_GEOLOCATION_BUDGET_MS = 8_000;

const geolocationMemo = new Map<string, { expiresAt: number; result: ResolvedSavedAddress | null }>();
const geolocationInFlight = new Map<string, Promise<ResolvedSavedAddress | null>>();

/** Forget remembered lookups (tests). */
export function clearSavedAddressGeolocationMemo(): void {
  geolocationMemo.clear();
  geolocationInFlight.clear();
}

/**
 * A value that changes only when the address's zone-relevant content changes.
 * Parents rebuild the address object on every render; effects keyed on this
 * do not re-run (and never re-search) for an identical address.
 */
export function savedAddressIdentityKey(address?: SavedAddressLike | null): string {
  if (!address) {
    return '';
  }
  const point = extractSavedAddressCoordinates(address);
  return JSON.stringify([
    typeof address.id === 'string' ? address.id : null,
    savedStreet(address),
    String(address.city || '').trim(),
    savedPostalCode(address),
    point ? point.lat : null,
    point ? point.lng : null,
    address.coordinate_source ?? null,
    address.geocoded_at ?? null,
    address.google_place_id ?? address.place_id ?? null,
  ]);
}

// ---------------------------------------------------------------------------
// Area rule: the same rule as Android (POSSystemMobile/src/utils/
// deliveryZoneCheck.ts, placeDetailsMatchSavedAddress). Keep the two in step;
// the parity case table in __tests__/saved-address-geolocation.test.ts
// mirrors the Android test cases.
// ---------------------------------------------------------------------------

const GREEK_TONOS: Record<string, string> = {
  'ά': 'α', // ά -> α
  'έ': 'ε', // έ -> ε
  'ή': 'η', // ή -> η
  'ί': 'ι', // ί -> ι
  'ϊ': 'ι', // ϊ -> ι
  'ΐ': 'ι', // ΐ -> ι
  'ό': 'ο', // ό -> ο
  'ύ': 'υ', // ύ -> υ
  'ϋ': 'υ', // ϋ -> υ
  'ΰ': 'υ', // ΰ -> υ
  'ώ': 'ω', // ώ -> ω
  'ς': 'σ', // ς -> σ
};

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Lowercase, accent-free, letters and digits separated by single spaces.
 * Written with \u escapes on purpose: the combining-mark range is invisible
 * in editors and diffs, and a normalizing editor could silently change it.
 */
export function normalizeAreaText(value: unknown): string {
  let text = textValue(value).toLowerCase();
  try {
    text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // normalize() unavailable: the tonos map below still applies.
  }
  text = text.replace(
    /[άέήίϊΐόύϋΰώς]/g,
    (char) => GREEK_TONOS[char] || char
  );
  return text.replace(/[^0-9a-zà-ɏͰ-Ͽἀ-῿]+/g, ' ').trim();
}

function postalDigits(value: unknown): string {
  return textValue(value).replace(/\D+/g, '');
}

/** "Καλαμαριά" / "Δήμος Καλαμαριάς": equal, or one name inside the other. */
function areaNamesMatch(saved: unknown, found: unknown): boolean {
  const a = normalizeAreaText(saved).replace(/\s+/g, '');
  const b = normalizeAreaText(found).replace(/\s+/g, '');
  if (a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  return (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
}

// Street-type words say nothing about which street it is.
const GENERIC_STREET_WORDS = new Set([
  'οδοσ', // οδοσ
  'παροδοσ', // παροδοσ
  'λεωφοροσ', // λεωφοροσ
  'πλατεια', // πλατεια
  'odos',
  'leoforos',
  'plateia',
  'street',
  'road',
  'avenue',
  'square',
  'strasse',
  'rruga',
]);

function streetTokens(value: unknown): string[] {
  return normalizeAreaText(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token) && !GENERIC_STREET_WORDS.has(token));
}

function sharesStreetToken(savedTokens: string[], found: unknown): boolean {
  const foundTokens = streetTokens(found);
  return savedTokens.some((saved) =>
    foundTokens.some((token) => token === saved || token.includes(saved) || saved.includes(token))
  );
}

/** The house number's digits ("12Α" -> "12"), or null. */
function houseNumberDigits(value: unknown): string | null {
  const raw = extractStreetNumber(textValue(value));
  const digits = raw ? raw.match(/\d+/)?.[0] : undefined;
  return digits ? String(Number(digits)) : null;
}

function savedStreet(address: SavedAddressLike): string {
  return String(address.street_address || address.street || '').trim();
}

function savedPostalCode(address: SavedAddressLike): string {
  return postalDigits(address.postal_code || address.postalCode);
}

function isZoneSkippedAddress(address: SavedAddressLike): boolean {
  return parseSpecialAddressInput(savedStreet(address)).shouldSkipZoneValidation;
}

/**
 * Founder rule (2026-09-29): a geocoded point is accepted only when the
 * resolved place is in the saved address's postal code or municipality. The
 * same street name exists in several municipalities, so a street-text match
 * alone could save a point kilometres away.
 *
 * - both postal codes known (4+ digits): they must be equal;
 * - otherwise the saved municipality must match one of the place's area
 *   names (accents, case and "Δήμος …" genitive tolerated);
 * - a saved address with neither is never confirmed.
 */
export function savedAddressAreaMatches(
  address: Pick<SavedAddressLike, 'city' | 'postal_code' | 'postalCode'>,
  resolved: Pick<ResolvedAddressDetails, 'city' | 'postalCode'> & { areaNames?: string[] }
): boolean {
  const savedPostal = postalDigits(address.postal_code || address.postalCode);
  const resolvedPostal = postalDigits(resolved.postalCode);
  if (savedPostal.length >= 4 && resolvedPostal.length >= 4) {
    return savedPostal === resolvedPostal;
  }

  const savedCity = textValue(address.city);
  if (!savedCity) {
    return false;
  }
  const names = [resolved.city, ...(Array.isArray(resolved.areaNames) ? resolved.areaNames : [])];
  return names.some((name) => areaNamesMatch(savedCity, name));
}

/**
 * Whether a resolved place IS the saved address: its area matches (above),
 * it carries the saved house number when the saved street has one, and it
 * shares a street-name word with the saved street.
 */
export function resolvedPlaceMatchesSavedAddress(
  address: SavedAddressLike,
  resolved: Pick<ResolvedAddressDetails, 'city' | 'postalCode' | 'streetAddress' | 'resolvedStreetNumber'> & {
    route?: string;
    areaNames?: string[];
  }
): boolean {
  if (!savedAddressAreaMatches(address, resolved)) {
    return false;
  }

  const street = savedStreet(address);
  const expectedNumber = houseNumberDigits(street);
  if (expectedNumber) {
    const foundNumber = houseNumberDigits(resolved.resolvedStreetNumber) ?? houseNumberDigits(resolved.streetAddress);
    if (foundNumber !== expectedNumber) {
      return false;
    }
  }

  const savedTokens = streetTokens(street);
  if (savedTokens.length > 0) {
    const foundStreet = textValue(resolved.route) || textValue(resolved.streetAddress);
    if (!sharesStreetToken(savedTokens, foundStreet)) {
      return false;
    }
  }

  return true;
}

/**
 * The point to zone-check a saved address with, or null when it has none.
 * Null means "the delivery zone was not checked", never out of zone. A
 * "#label" special address skips zone validation and has no point here.
 */
export function extractSavedAddressCoordinates(
  address?: SavedAddressLike | null
): LatLng | null {
  if (!address) {
    return null;
  }
  if (isZoneSkippedAddress(address)) {
    return null;
  }
  if ((address.coordinate_source === 'google' || address.google_place_id || address.place_id)
    && address.coordinate_source !== 'manual' && address.coordinate_source !== 'provider') {
    const fetchedAt = Date.parse(address.geocoded_at || '');
    if (!Number.isFinite(fetchedAt) || fetchedAt > Date.now()
      || Date.now() - fetchedAt >= 28 * 86_400_000) {
      return null;
    }
  }
  return readSavedAddressPoint(address);
}

/**
 * True for a saved address the zone check cannot run on: no real point and
 * not a "#label" special address. Its zone is "not checked" unless automatic
 * geolocation locates it; a text-only zone request could only answer
 * requires_selection, so callers answer it locally instead.
 */
export function isUnlocatedZoneAddress(address?: SavedAddressLike | null): boolean {
  if (!address) {
    return false;
  }
  return !isZoneSkippedAddress(address) && !extractSavedAddressCoordinates(address);
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

function suggestionAreaText(suggestion: AddressSuggestion): string {
  return normalizeAreaText(
    [suggestion.secondary_text, suggestion.formatted_address, suggestion.city, suggestion.postal_code]
      .filter(Boolean)
      .join(' ')
  );
}

function suggestionStreetText(suggestion: AddressSuggestion): string {
  return [
    suggestion.displayLabel,
    suggestion.main_text,
    suggestion.name,
    suggestion.formatted_address,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Ranks a text-search suggestion for a saved address; only the best
 * MAX_DETAIL_LOOKUPS are looked up. -1 = never tried: the suggestion shares
 * no street-name word with the saved street (the details check would reject
 * it anyway, so it is not worth a billable lookup). The ranking only picks
 * what to look up; acceptance is resolvedPlaceMatchesSavedAddress.
 */
function scoreSuggestion(address: SavedAddressLike, suggestion: AddressSuggestion): number {
  const savedTokens = streetTokens(savedStreet(address));
  if (savedTokens.length > 0 && !sharesStreetToken(savedTokens, suggestionStreetText(suggestion))) {
    return -1;
  }

  let score = 0;
  const areaText = suggestionAreaText(suggestion);
  const postal = savedPostalCode(address);
  if (postal.length >= 4 && areaText.replace(/\s+/g, '').includes(postal)) {
    score += 4;
  } else if (textValue(address.city) && areaNamesMatch(address.city, areaText)) {
    score += 4;
  }

  const expectedNumber = houseNumberDigits(savedStreet(address));
  if (expectedNumber) {
    const candidateNumber =
      houseNumberDigits(suggestion.resolved_street_number)
      ?? houseNumberDigits(suggestion.displayLabel || suggestion.main_text || suggestion.name || '');
    if (candidateNumber === expectedNumber) {
      score += 2;
    }
  }

  return score;
}

function isKnownOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function readMemo(key: string): ResolvedSavedAddress | null | undefined {
  const entry = geolocationMemo.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    geolocationMemo.delete(key);
    return undefined;
  }
  return entry.result;
}

function writeMemo(key: string | null, result: ResolvedSavedAddress | null): void {
  // No branch, no memo: a verdict must never answer for another store.
  if (!key) {
    return;
  }
  geolocationMemo.delete(key);
  geolocationMemo.set(key, {
    expiresAt: Date.now() + (result ? GEOLOCATION_MATCH_TTL_MS : GEOLOCATION_MISS_TTL_MS),
    result,
  });
  while (geolocationMemo.size > GEOLOCATION_MEMO_LIMIT) {
    const oldest = geolocationMemo.keys().next().value;
    if (oldest === undefined) break;
    geolocationMemo.delete(oldest);
  }
}

function withinBudget<T>(lookup: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    return lookup;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), timeoutMs);
  });
  return Promise.race([lookup, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The point to zone-check a saved address with. A saved point is returned as
 * is. An address without one is geocoded by its text and the result is
 * accepted ONLY when the place is the saved address in its postal code or
 * municipality (resolvedPlaceMatchesSavedAddress). Otherwise null: the order
 * continues with the zone "not checked". Answers within
 * SAVED_ADDRESS_GEOLOCATION_BUDGET_MS (null after that).
 */
export async function resolveSavedAddressCoordinates(
  address: SavedAddressLike,
  branchId?: string,
  options: { timeoutMs?: number } = {}
): Promise<ResolvedSavedAddress | null> {
  const existingCoordinates = extractSavedAddressCoordinates(address);
  if (existingCoordinates) {
    return {
      coordinates: existingCoordinates,
      source: 'saved',
    };
  }

  const query = buildSavedAddressQuery(address);
  if (!query || !savedStreet(address) || isZoneSkippedAddress(address)) {
    return null;
  }

  // Nothing to confirm a text match against: never guess (and never pay for
  // a search whose answer could not be accepted).
  if (!savedPostalCode(address) && !textValue(address.city)) {
    return null;
  }

  const memoKey = branchId ? `${branchId}|${normalizeAreaText(query)}` : null;
  if (memoKey) {
    const memoized = readMemo(memoKey);
    if (memoized !== undefined) {
      return memoized;
    }
  }
  const inFlightKey = memoKey ?? `|${normalizeAreaText(query)}`;
  let lookup = geolocationInFlight.get(inFlightKey);
  if (!lookup) {
    const started = geolocateSavedAddress(address, query, memoKey, branchId);
    lookup = started;
    geolocationInFlight.set(inFlightKey, started);
    void started
      .catch(() => null)
      .finally(() => {
        if (geolocationInFlight.get(inFlightKey) === started) {
          geolocationInFlight.delete(inFlightKey);
        }
      });
  }

  return withinBudget(lookup, options.timeoutMs ?? SAVED_ADDRESS_GEOLOCATION_BUDGET_MS, null);
}

async function geolocateSavedAddress(
  address: SavedAddressLike,
  query: string,
  memoKey: string | null,
  branchId?: string
): Promise<ResolvedSavedAddress | null> {
  const sessionToken = createAddressSessionToken();
  const suggestions = await searchAddressSuggestions(query, {
    branchId,
    limit: 5,
    sessionToken,
  });

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    // Offline, an empty answer says nothing about the address: ask again.
    if (!isKnownOffline()) {
      writeMemo(memoKey, null);
    }
    return null;
  }

  const candidates = suggestions
    .map((suggestion, index) => ({ suggestion, index, score: scoreSuggestion(address, suggestion) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_DETAIL_LOOKUPS);

  let lookupFailed = false;
  for (const { suggestion } of candidates) {
    let resolved: ResolvedAddressDetails;
    try {
      resolved = await resolveAddressSuggestion(suggestion, query, {
        branchId,
        sessionToken,
      });
    } catch {
      lookupFailed = true;
      continue;
    }

    const point = toValidLatLng(resolved.coordinates);
    if (!point) {
      continue;
    }
    if (!resolvedPlaceMatchesSavedAddress(address, resolved)) {
      continue;
    }

    const accepted: ResolvedSavedAddress = {
      coordinates: point,
      source: 'geocoded',
      addressFingerprint: resolved.addressFingerprint,
      placeId: resolved.placeId,
      resolvedStreetNumber: resolved.resolvedStreetNumber,
      validationSource: resolved.validationSource,
    };
    writeMemo(memoKey, accepted);
    return accepted;
  }

  // A lookup that failed on the network may succeed later: only a definitive
  // "no acceptable match" is remembered.
  if (!lookupFailed) {
    writeMemo(memoKey, null);
  }
  return null;
}

type AddressUpdater = (
  addressId: string,
  updates: Record<string, unknown>,
  expectedVersion: number
) => Promise<unknown>;

/**
 * Ids that have no server row to patch yet. Mirrors
 * sync_queue::is_local_placeholder_id in pos-tauri/src-tauri: Rust recreates
 * a `local-*` / `legacy:*` address through POST, and a coordinates-only
 * payload would create a street-less default address.
 */
const LOCAL_PLACEHOLDER_ADDRESS_ID = /^(local-|legacy:)/i;

/**
 * Writes a geocoded point back to the saved address so the next order does
 * not search again. Only for a point accepted by the area rule above, found
 * ONLINE, for an address that already has a server row, while the terminal is
 * online. The payload carries coordinates only, so every deferred path in
 * Rust (offline, 5xx, a write folded into a queued insert) would have to
 * merge it into the cached address; writing only when the PATCH can go
 * straight to the server keeps the cached street and area intact.
 */
export async function persistGeocodedSavedAddressCoordinates(options: {
  address: (SavedAddressLike & { id?: unknown; version?: unknown; customer_id?: unknown }) | null | undefined;
  customerId: string | null | undefined;
  resolved: ResolvedSavedAddress | null | undefined;
  isLegacyFallback: boolean;
  updateAddress: AddressUpdater;
}): Promise<boolean> {
  const { address, customerId, resolved, isLegacyFallback, updateAddress } = options;
  if (!address || !resolved || resolved.source !== 'geocoded' || isLegacyFallback) {
    return false;
  }
  if (typeof address.id !== 'string' || !address.id || !customerId) {
    return false;
  }
  if (LOCAL_PLACEHOLDER_ADDRESS_ID.test(address.id)) {
    return false;
  }
  if (resolved.validationSource === 'offline_cache' || isKnownOffline()) {
    return false;
  }
  const version = Number(address.version);
  await updateAddress(
    address.id,
    {
      customer_id: customerId,
      coordinates: resolved.coordinates,
      latitude: resolved.coordinates.lat,
      longitude: resolved.coordinates.lng,
    },
    Number.isFinite(version) ? version : -1
  );
  return true;
}
