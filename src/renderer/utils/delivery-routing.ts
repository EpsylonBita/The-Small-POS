import { posApiPost } from './api-helpers'

export interface StoreMapOrigin {
  label: string
  address: string | null
  coordinates: { lat: number; lng: number } | null
}

export interface BranchOriginFallbackPayload extends StoreMapOrigin {
  branchId: string
}

export interface DeliveryRouteStopPayload {
  orderId?: string | null
  orderNumber?: string | null
  label?: string | null
  address?: string | null
  coordinates?: { lat: number; lng: number } | null
  createdAt?: string | null
}

export interface OptimizedRouteLaunch {
  index: number
  stopCount: number
  url: string
}

export interface OptimizedDeliveryRoutePlan {
  origin: {
    label: string
    address: string | null
    coordinates: { lat: number; lng: number } | null
  }
  orderedStops: DeliveryRouteStopPayload[]
  launches: OptimizedRouteLaunch[]
  chunked: boolean
  chunkCount: number
  originSource: 'branch-db' | 'synced-branch-fallback'
  optimizationMethod: string
  warnings: string[]
}

type TerminalSettingGetter = <T = unknown>(category: string, key: string, defaultValue?: T) => T | undefined
type TerminalSettingsSource = Record<string, unknown> | null | undefined

export function createTerminalSettingGetter(settings: TerminalSettingsSource): TerminalSettingGetter {
  return <T = unknown>(category: string, key: string, defaultValue?: T): T | undefined => {
    if (!settings) {
      return defaultValue
    }

    const flatKey = `${category}.${key}`
    if (Object.prototype.hasOwnProperty.call(settings, flatKey)) {
      return settings[flatKey] as T
    }

    const categoryValue = settings[category]
    if (
      categoryValue
      && typeof categoryValue === 'object'
      && !Array.isArray(categoryValue)
      && Object.prototype.hasOwnProperty.call(categoryValue, key)
    ) {
      return (categoryValue as Record<string, unknown>)[key] as T
    }

    return defaultValue
  }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeNumber(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function hasUsableCoordinates(lat: number, lng: number): boolean {
  return !(Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001)
}

function formatAddressParts(parts: Array<string | null | undefined>): string | null {
  const filtered = parts
    .map((part) => normalizeText(part))
    .filter((part): part is string => Boolean(part))

  if (filtered.length === 0) {
    return null
  }

  return filtered.join(', ')
}

function normalizeComparableText(value: string | null | undefined): string {
  if (!value) {
    return ''
  }

  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[.,;|/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCompactText(value: string | null | undefined): string {
  return normalizeComparableText(value).replace(/\s+/g, '')
}

function addressAlreadyContainsPart(address: string | null | undefined, part: string | null | undefined): boolean {
  const normalizedAddress = normalizeComparableText(address)
  const normalizedPart = normalizeComparableText(part)
  if (!normalizedAddress || !normalizedPart) {
    return false
  }

  return (
    normalizedAddress.includes(normalizedPart)
    || normalizeCompactText(address).includes(normalizeCompactText(part))
  )
}

function buildFullDeliveryAddress(
  address: string | null | undefined,
  city: string | null | undefined,
  postalCode: string | null | undefined,
): string | null {
  const baseAddress = normalizeText(address)
  const resolvedCity = normalizeText(city)
  const resolvedPostalCode = normalizeText(postalCode)
  const parts: string[] = []

  if (baseAddress) {
    parts.push(baseAddress)
  }
  if (resolvedCity && !addressAlreadyContainsPart(baseAddress, resolvedCity)) {
    parts.push(resolvedCity)
  }
  if (resolvedPostalCode && !addressAlreadyContainsPart(baseAddress, resolvedPostalCode)) {
    parts.push(resolvedPostalCode)
  }

  return formatAddressParts(parts)
}

function resolveAddressFromObject(value: Record<string, unknown>): string | null {
  const objectAddress =
    normalizeText(value.formatted)
    || buildFullDeliveryAddress(
      normalizeText(value.street) || normalizeText(value.street_address) || normalizeText(value.address),
      normalizeText(value.city),
      normalizeText(value.postalCode) || normalizeText(value.postal_code),
    )

  return objectAddress || normalizeText(value.address)
}

function resolveCoordinatesFromObject(value: Record<string, unknown>): { lat: number; lng: number } | null {
  const coordinatePairs = [
    { lat: normalizeNumber(value.lat), lng: normalizeNumber(value.lng) },
    { lat: normalizeNumber(value.latitude), lng: normalizeNumber(value.longitude) },
  ]

  for (const pair of coordinatePairs) {
    if (pair.lat === null || pair.lng === null) {
      continue
    }

    if (pair.lat < -90 || pair.lat > 90 || pair.lng < -180 || pair.lng > 180) {
      continue
    }

    if (!hasUsableCoordinates(pair.lat, pair.lng)) {
      continue
    }

    return { lat: pair.lat, lng: pair.lng }
  }

  const nestedCoordinates = value.coordinates
  if (nestedCoordinates && typeof nestedCoordinates === 'object' && !Array.isArray(nestedCoordinates)) {
    const resolvedNestedCoordinates = resolveCoordinatesFromObject(nestedCoordinates as Record<string, unknown>)
    if (resolvedNestedCoordinates) {
      return resolvedNestedCoordinates
    }
  }

  const nestedLocation = value.location
  if (nestedLocation && typeof nestedLocation === 'object' && !Array.isArray(nestedLocation)) {
    const resolvedLocationCoordinates = resolveCoordinatesFromObject(nestedLocation as Record<string, unknown>)
    if (resolvedLocationCoordinates) {
      return resolvedLocationCoordinates
    }
  }

  if (
    Array.isArray(nestedCoordinates)
    && nestedCoordinates.length >= 2
  ) {
    const lng = normalizeNumber(nestedCoordinates[0])
    const lat = normalizeNumber(nestedCoordinates[1])
    if (
      lat !== null
      && lng !== null
      && lat >= -90
      && lat <= 90
      && lng >= -180
      && lng <= 180
      && hasUsableCoordinates(lat, lng)
    ) {
      return { lat, lng }
    }
  }

  return null
}

export function resolveStoreMapOrigin(getSetting: TerminalSettingGetter): StoreMapOrigin | null {
  const address = (
    normalizeText(getSetting('terminal', 'store_address', ''))
    || normalizeText(getSetting('restaurant', 'address', ''))
  )
  const latitude = (
    normalizeNumber(getSetting('terminal', 'store_latitude', ''))
    ?? normalizeNumber(getSetting('restaurant', 'latitude', ''))
  )
  const longitude = (
    normalizeNumber(getSetting('terminal', 'store_longitude', ''))
    ?? normalizeNumber(getSetting('restaurant', 'longitude', ''))
  )
  const coordinates = latitude !== null && longitude !== null && hasUsableCoordinates(latitude, longitude)
    ? { lat: latitude, lng: longitude }
    : null

  if (!address && !coordinates) {
    return null
  }

  return {
    label:
      normalizeText(getSetting('terminal', 'store_name', ''))
      || normalizeText(getSetting('restaurant', 'name', ''))
      || 'Store',
    address,
    coordinates,
  }
}

export function resolveSyncedBranchOriginFallback(
  getSetting: TerminalSettingGetter,
  branchId: string | null | undefined,
): BranchOriginFallbackPayload | null {
  const normalizedBranchId = (
    normalizeText(branchId)
    || normalizeText(getSetting('terminal', 'branch_id', ''))
  )
  const origin = resolveStoreMapOrigin(getSetting)

  if (!normalizedBranchId || !origin) {
    return null
  }

  return {
    branchId: normalizedBranchId,
    label: origin.label,
    address: origin.address,
    coordinates: origin.coordinates,
  }
}

export function resolveOrderDeliveryAddress(order: unknown): string | null {
  if (!order || typeof order !== 'object') {
    return null
  }

  const record = order as Record<string, unknown>
  const directAddress = buildFullDeliveryAddress(
    normalizeText(record.delivery_address)
      || normalizeText(record.deliveryAddress),
    normalizeText(record.delivery_city) || normalizeText(record.deliveryCity),
    normalizeText(record.delivery_postal_code) || normalizeText(record.deliveryPostalCode),
  )

  if (directAddress) {
    return directAddress
  }

  const candidates = [
    record.address,
    record.delivery_address,
    record.deliveryAddress,
  ]

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue
    }

    const resolved = buildFullDeliveryAddress(
      resolveAddressFromObject(candidate as Record<string, unknown>),
      normalizeText(record.delivery_city) || normalizeText(record.deliveryCity),
      normalizeText(record.delivery_postal_code) || normalizeText(record.deliveryPostalCode),
    )
    if (resolved) {
      return resolved
    }
  }

  return null
}

export function buildSingleDeliveryRouteStop(order: unknown): DeliveryRouteStopPayload | null {
  if (!order || typeof order !== 'object') {
    return null
  }

  const record = order as Record<string, unknown>
  const address = resolveOrderDeliveryAddress(record)
  const coordinatesCandidates = [
    record.delivery_coordinates,
    record.deliveryCoordinates,
    record.coordinates,
    record.delivery_address,
    record.deliveryAddress,
    record.address,
  ]

  let coordinates: { lat: number; lng: number } | null = null
  for (const candidate of coordinatesCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue
    }

    coordinates = resolveCoordinatesFromObject(candidate as Record<string, unknown>)
    if (coordinates) {
      break
    }
  }

  if (!address && !coordinates) {
    return null
  }

  return {
    orderId: normalizeText(record.id),
    orderNumber: normalizeText(record.order_number) || normalizeText(record.orderNumber),
    label:
      normalizeText(record.customer_name)
      || normalizeText(record.customerName)
      || normalizeText(record.order_number)
      || normalizeText(record.orderNumber)
      || 'Delivery stop',
    address,
    coordinates,
    createdAt: normalizeText(record.created_at) || normalizeText(record.createdAt),
  }
}

function locationToMapsValue(location: { address: string | null; coordinates: { lat: number; lng: number } | null }): string {
  if (location.coordinates) {
    return `${location.coordinates.lat},${location.coordinates.lng}`
  }

  return location.address || ''
}

export function buildGoogleMapsDirectionsUrl(
  origin: StoreMapOrigin | null | undefined,
  stop: DeliveryRouteStopPayload,
): string | null {
  const destination = stop.coordinates
    ? `${stop.coordinates.lat},${stop.coordinates.lng}`
    : normalizeText(stop.address)

  if (!destination) {
    return null
  }

  const params = new URLSearchParams({
    api: '1',
    destination,
    travelmode: 'driving',
  })

  const originValue = origin ? locationToMapsValue(origin) : ''
  if (originValue) {
    params.set('origin', originValue)
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`
}

export async function requestOptimizedDeliveryRoute(
  args: {
    stops: DeliveryRouteStopPayload[]
    originFallback?: BranchOriginFallbackPayload | null
  },
): Promise<{ success: true; route: OptimizedDeliveryRoutePlan } | { success: false; error: string }> {
  const response = await posApiPost<{ success: boolean; route?: OptimizedDeliveryRoutePlan; error?: string }>(
    '/api/pos/delivery/optimize-route',
    {
      stops: args.stops,
      originFallback: args.originFallback ?? undefined,
    },
  )

  if (!response.success) {
    return {
      success: false,
      error: response.error || 'Failed to optimize delivery route',
    }
  }

  if (!response.data?.success || !response.data.route) {
    return {
      success: false,
      error: response.data?.error || 'Delivery route optimization returned no route',
    }
  }

  return {
    success: true,
    route: response.data.route,
  }
}
