export type OfflinePageId =
  | 'appointments'
  | 'analytics'
  | 'coupons'
  | 'customer_display'
  | 'delivery_zones'
  | 'drive_through'
  | 'guest_billing'
  | 'housekeeping'
  | 'integrations'
  | 'inventory'
  | 'kiosk'
  | 'loyalty'
  | 'menu'
  | 'payment_terminals'
  | 'product_catalog'
  | 'reservations'
  | 'reports'
  | 'rooms'
  | 'staff_schedule'
  | 'settings'
  | 'suppliers'

export interface OfflineActionState {
  disabled: boolean
  message: string | null
}

interface OfflinePageCapability {
  bannerMessage: string
  actions?: Record<string, string>
}

const DEFAULT_READ_ONLY_MESSAGE =
  'Showing the last locally cached data. Reconnect to enable online-only changes and refreshes.'

const PAGE_CAPABILITIES: Record<OfflinePageId, OfflinePageCapability> = {
  appointments: {
    bannerMessage:
      'Appointments remain available offline from cached branch data. New appointments and status changes save locally and sync after reconnect.',
  },
  analytics: {
    bannerMessage:
      'Analytics remains readable offline from the last cached branch snapshot. Fresh trend data resumes after reconnect.',
  },
  coupons: {
    bannerMessage:
      'Coupons remain readable offline from cached branch data. Creates and status changes save locally and sync after reconnect. Delete still requires an online connection.',
    actions: {
      delete: 'Reconnect to delete coupons.',
    },
  },
  customer_display: {
    bannerMessage:
      'Customer display is read-only offline and uses the last cached display feed for this terminal.',
  },
  delivery_zones: {
    bannerMessage:
      'Delivery zones stay visible offline from cached branch data. Fresh map analytics resume after reconnect.',
  },
  drive_through: {
    bannerMessage:
      'Drive-through lanes remain usable offline from cached queue data. Stage changes save locally and sync after reconnect.',
  },
  guest_billing: {
    bannerMessage:
      'Guest billing stays readable offline from the last cached folio snapshot. Reconnect to refresh balances and settlements.',
  },
  housekeeping: {
    bannerMessage:
      'Housekeeping tasks remain available offline from cached hotel operations data. Status and assignment changes save locally and sync after reconnect.',
  },
  integrations: {
    bannerMessage:
      'Integration status uses the last cached admin response. Connecting, disconnecting, and saving integration or MyData changes requires an online connection.',
    actions: {
      toggle: 'Reconnect to connect or disconnect integrations.',
      save: 'Reconnect to save integration credentials or routing changes.',
      'mydata.save': 'Reconnect to save MyData configuration changes.',
    },
  },
  inventory: {
    bannerMessage:
      'Inventory stays readable offline from the cached admin snapshot. Stock adjustments save locally and sync after reconnect.',
  },
  kiosk: {
    bannerMessage:
      'Kiosk metrics stay readable offline from cached data. Enabling, disabling, or opening the live kiosk requires an online connection.',
    actions: {
      toggle: 'Reconnect to enable or disable kiosk ordering.',
      open: 'Reconnect to open the live kiosk page.',
    },
  },
  loyalty: {
    bannerMessage:
      'Loyalty data stays readable offline from the local loyalty cache. Syncing fresh loyalty settings and customers resumes when online.',
  },
  menu: {
    bannerMessage:
      'Menu management remains readable offline from the local menu cache. Availability changes save locally and sync after reconnect.',
  },
  payment_terminals: {
    bannerMessage:
      'Saved payment terminal profiles remain available offline. Discovery, connect, disconnect, and test-payment actions require an online connection.',
    actions: {
      discover: 'Reconnect to discover payment terminals.',
      connect: 'Reconnect to connect or disconnect payment terminals.',
      test: 'Reconnect to run live payment terminal tests.',
    },
  },
  product_catalog: {
    bannerMessage:
      'Product catalog stays available offline from cached retail data. Quantity changes save locally and sync after reconnect.',
  },
  reservations: {
    bannerMessage:
      'Reservations remain available offline from cached branch data. New reservations and table assignments save locally and sync after reconnect.',
  },
  reports: {
    bannerMessage:
      'Reports remain available offline from the local reporting cache. Reconnect to refresh reporting aggregates.',
  },
  rooms: {
    bannerMessage:
      'Rooms remain available offline from cached hotel data. Room status changes save locally and sync after reconnect.',
  },
  staff_schedule: {
    bannerMessage:
      'Staff schedules remain available offline from cached branch data. New shifts save locally and sync after reconnect.',
  },
  settings: {
    bannerMessage:
      'Local terminal settings can still be saved offline. Remote sync, admin refresh, and live device tests require an online connection.',
    actions: {
      'sync-now': 'Reconnect to run terminal sync.',
      'printer-test': 'Reconnect to run live printer tests.',
      'config-refresh': 'Reconnect to refresh admin terminal configuration.',
    },
  },
  suppliers: {
    bannerMessage:
      'Suppliers remain readable offline from the cached admin snapshot. Supplier changes still require an online connection.',
  },
}

const PAGE_ALIASES: Record<string, OfflinePageId> = {
  plugin_integrations: 'integrations',
}

function normalizePageId(pageId: string | null | undefined): OfflinePageId | null {
  if (!pageId) {
    return null
  }

  const trimmed = pageId.trim()
  if (!trimmed) {
    return null
  }

  const alias = PAGE_ALIASES[trimmed]
  if (alias) {
    return alias
  }

  return trimmed in PAGE_CAPABILITIES ? (trimmed as OfflinePageId) : null
}

export function isOfflineManagedPage(pageId: string | null | undefined): boolean {
  return normalizePageId(pageId) !== null
}

export function getOfflinePageBanner(
  pageId: string | null | undefined,
  isOffline: boolean,
): string | null {
  if (!isOffline) {
    return null
  }

  const normalizedPageId = normalizePageId(pageId)
  if (!normalizedPageId) {
    return null
  }

  return PAGE_CAPABILITIES[normalizedPageId]?.bannerMessage ?? DEFAULT_READ_ONLY_MESSAGE
}

export function getOfflineActionState(
  pageId: string | null | undefined,
  actionId: string,
  isOnline: boolean,
): OfflineActionState {
  if (isOnline) {
    return { disabled: false, message: null }
  }

  const normalizedPageId = normalizePageId(pageId)
  if (!normalizedPageId) {
    return { disabled: false, message: null }
  }

  const pageCapability = PAGE_CAPABILITIES[normalizedPageId]
  const message = pageCapability.actions?.[actionId]

  if (!message) {
    return { disabled: false, message: null }
  }

  return {
    disabled: true,
    message,
  }
}
