import { posApiPost } from './api-helpers'

export interface StoreMapOrigin {
  label: string
  address: string | null
  coordinates: { lat: number; lng: number } | null
}

export interface DeliveryRouteStopPayload {
  orderId?: string | null
  orderNumber?: string | null
  label?: string | null
  address?: string | null
  coordinates?: { lat: number; lng: number } | null
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
  optimizationMethod: string
  warnings: string[]
}

type TerminalSettingGetter = <T = unknown>(category: string, key: string, defaultValue?: T) => T | undefined

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

function resolveAddressFromObject(value: Record<string, unknown>): string | null {
  return (
    normalizeText(value.formatted)
    || formatAddressParts([
      normalizeText(value.street),
      normalizeText(value.city),
      normalizeText(value.postalCode),
      normalizeText(value.postal_code),
      normalizeText(value.floor),
    ])
    || normalizeText(value.address)
  )
}

function resolveCoordinatesFromObject(value: Record<string, unknown>): { lat: number; lng: number } | null {
  const lat = normalizeNumber(value.lat)
  const lng = normalizeNumber(value.lng)
  if (lat === null || lng === null) {
    return null
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null
  }

  if (!hasUsableCoordinates(lat, lng)) {
    return null
  }

  return { lat, lng }
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

export function resolveOrderDeliveryAddress(order: unknown): string | null {
  if (!order || typeof order !== 'object') {
    return null
  }

  const record = order as Record<string, unknown>
  const directAddress =
    normalizeText(record.delivery_address)
    || normalizeText(record.deliveryAddress)

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

    const resolved = resolveAddressFromObject(candidate as Record<string, unknown>)
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
  }
}

function locationToMapsValue(location: { address: string | null; coordinates: { lat: number; lng: number } | null }): string {
  if (location.coordinates) {
    return `${location.coordinates.lat},${location.coordinates.lng}`
  }

  return location.address || ''
}

export function buildGoogleMapsDirectionsUrl(
  origin: StoreMapOrigin,
  stop: DeliveryRouteStopPayload,
): string | null {
  const destination = stop.coordinates
    ? `${stop.coordinates.lat},${stop.coordinates.lng}`
    : normalizeText(stop.address)

  if (!destination) {
    return null
  }

  const originValue = locationToMapsValue(origin)
  if (!originValue) {
    return null
  }

  const params = new URLSearchParams({
    api: '1',
    origin: originValue,
    destination,
    travelmode: 'driving',
  })

  return `https://www.google.com/maps/dir/?${params.toString()}`
}

export async function requestOptimizedDeliveryRoute(
  stops: DeliveryRouteStopPayload[],
): Promise<{ success: true; route: OptimizedDeliveryRoutePlan } | { success: false; error: string }> {
  const response = await posApiPost<{ success: boolean; route?: OptimizedDeliveryRoutePlan; error?: string }>(
    '/api/pos/delivery/optimize-route',
    { stops },
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
