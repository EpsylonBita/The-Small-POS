export interface PosModuleCacheEntry {
  moduleId: string;
  warmPaths: string[];
  cachePrefixes: string[];
  syncTables: string[];
}

export const POS_MODULE_CACHE_ENTRIES: PosModuleCacheEntry[] = [
  { moduleId: 'plugin_integrations', warmPaths: ['/api/pos/integrations', '/api/pos/mydata/config'], cachePrefixes: ['/api/pos/integrations', '/api/pos/mydata/config'], syncTables: [] },
  // The persistent CustomerDisplayProvider owns reconciliation while page/projection is active.
  { moduleId: 'customer_display', warmPaths: [], cachePrefixes: [], syncTables: [] },
  { moduleId: 'kiosk', warmPaths: ['/api/pos/kiosk/status', '/api/pos/kiosk/orders?limit=10'], cachePrefixes: ['/api/pos/kiosk/status', '/api/pos/kiosk/orders'], syncTables: [] },
  { moduleId: 'analytics', warmPaths: ['/api/pos/analytics?time_range=today', '/api/pos/analytics?time_range=week', '/api/pos/analytics?time_range=month'], cachePrefixes: ['/api/pos/analytics'], syncTables: [] },
  // Analytics already embeds its map aggregate. The Pro Map page fetches its own
  // endpoint when opened; never warm a second /map-analytics aggregate here.
  { moduleId: 'delivery_zones', warmPaths: ['/api/pos/delivery-zones'], cachePrefixes: ['/api/pos/delivery-zones'], syncTables: [] },
  { moduleId: 'inventory', warmPaths: ['/api/pos/sync/inventory_items?limit=2000'], cachePrefixes: ['/api/pos/sync/inventory_items'], syncTables: [] },
  { moduleId: 'coupons', warmPaths: ['/api/pos/coupons'], cachePrefixes: ['/api/pos/coupons'], syncTables: [] },
  {
    moduleId: 'reservations',
    warmPaths: [],
    cachePrefixes: ['/api/pos/reservations'],
    syncTables: ['reservations'],
  },
  {
    moduleId: 'appointments',
    warmPaths: [
      '/api/pos/appointments?include_services=true',
      '/api/pos/sync/appointments?limit=2000',
      '/api/pos/sync/appointment_services?limit=2000',
      '/api/pos/sync/appointment_resources?limit=2000',
    ],
    cachePrefixes: [
      '/api/pos/appointments',
      '/api/pos/sync/appointments',
      '/api/pos/sync/appointment_services',
      '/api/pos/sync/appointment_resources',
    ],
    syncTables: ['appointments', 'appointment_services', 'appointment_resources'],
  },
  {
    moduleId: 'drive_through',
    warmPaths: [],
    cachePrefixes: ['/api/pos/drive-through'],
    syncTables: ['drive_thru_lanes', 'drive_thru_orders'],
  },
  {
    moduleId: 'services',
    warmPaths: [
      '/api/pos/services?is_active=true',
      '/api/pos/service-categories?is_active=true',
      '/api/pos/resources?is_active=true',
      '/api/pos/sync/services?limit=2000',
      '/api/pos/sync/service_categories?limit=2000',
      '/api/pos/sync/resources?limit=2000',
    ],
    cachePrefixes: [
      '/api/pos/services',
      '/api/pos/service-categories',
      '/api/pos/resources',
      '/api/pos/sync/services',
      '/api/pos/sync/service_categories',
      '/api/pos/sync/resources',
    ],
    syncTables: ['services', 'service_categories', 'resources'],
  },
  {
    moduleId: 'rooms',
    warmPaths: [
      '/api/pos/rooms',
      '/api/pos/sync/rooms?limit=2000',
    ],
    cachePrefixes: ['/api/pos/rooms', '/api/pos/sync/rooms'],
    syncTables: ['rooms'],
  },
  {
    moduleId: 'housekeeping',
    warmPaths: [
      '/api/pos/housekeeping?status=all',
      '/api/pos/sync/housekeeping_tasks?limit=2000',
    ],
    cachePrefixes: ['/api/pos/housekeeping', '/api/pos/sync/housekeeping_tasks'],
    syncTables: ['housekeeping_tasks'],
  },
  {
    moduleId: 'guest_billing',
    warmPaths: [
      '/api/pos/guest-billing?status=all',
      '/api/pos/sync/guest_folios?limit=2000',
      '/api/pos/sync/folio_charges?limit=2000',
    ],
    cachePrefixes: [
      '/api/pos/guest-billing',
      '/api/pos/sync/guest_folios',
      '/api/pos/sync/folio_charges',
    ],
    syncTables: ['guest_folios', 'folio_charges'],
  },
  {
    // procurement-loop Task 10.1: keep the raw PO snapshot warm in the
    // Rust admin-GET cache so offline rendering has a stable fallback
    // source. Cursor-based delta sync lives in purchase-order-snapshot.ts
    // (delta paths are deliberately not cacheable Rust-side).
    moduleId: 'suppliers',
    // The dedicated snapshot pull also populates the native HTTP cache.
    warmPaths: ['/api/pos/suppliers'],
    cachePrefixes: ['/api/pos/purchase-orders', '/api/pos/suppliers'],
    syncTables: [],
  },
  {
    moduleId: 'product_catalog',
    warmPaths: [
      '/api/pos/products?is_active=true&limit=500&offset=0',
      '/api/pos/product-categories',
      '/api/pos/products/low-stock',
      '/api/pos/sync/retail_products?limit=2000',
      '/api/pos/sync/retail_product_variants?limit=2000',
      '/api/pos/sync/retail_product_categories?limit=2000',
    ],
    cachePrefixes: [
      '/api/pos/products',
      '/api/pos/product-categories',
      '/api/pos/products/low-stock',
      '/api/pos/sync/retail_products',
      '/api/pos/sync/retail_product_variants',
      '/api/pos/sync/retail_product_categories',
    ],
    syncTables: [
      'retail_products',
      'retail_product_variants',
      'retail_product_categories',
    ],
  },
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function getPosModuleWarmPaths(enabledModules?: ReadonlySet<string>): string[] {
  const paths = POS_MODULE_CACHE_ENTRIES
    .filter(entry => !enabledModules || enabledModules.has(entry.moduleId))
    .flatMap((entry) => entry.warmPaths);
  return unique([
    ...paths.filter((path) => !path.startsWith('/api/pos/sync/')),
    ...paths.filter((path) => path.startsWith('/api/pos/sync/')),
  ]);
}

export function getPosModuleCachePrefixes(enabledModules?: ReadonlySet<string>): string[] {
  const preferredOrder = [
    '/api/pos/reservations',
    '/api/pos/appointments',
    '/api/pos/drive-through',
    '/api/pos/rooms',
    '/api/pos/housekeeping',
    '/api/pos/guest-billing',
    '/api/pos/products',
    '/api/pos/product-categories',
    '/api/pos/services',
    '/api/pos/service-categories',
    '/api/pos/resources',
    '/api/pos/products/low-stock',
    '/api/pos/sync/appointments',
    '/api/pos/sync/appointment_services',
    '/api/pos/sync/appointment_resources',
    '/api/pos/sync/services',
    '/api/pos/sync/service_categories',
    '/api/pos/sync/resources',
    '/api/pos/sync/rooms',
    '/api/pos/sync/housekeeping_tasks',
    '/api/pos/sync/guest_folios',
    '/api/pos/sync/folio_charges',
    '/api/pos/sync/retail_products',
    '/api/pos/sync/retail_product_variants',
    '/api/pos/sync/retail_product_categories',
  ];
  const prefixes = unique(POS_MODULE_CACHE_ENTRIES
    .filter(entry => !enabledModules || enabledModules.has(entry.moduleId))
    .flatMap((entry) => entry.cachePrefixes));
  return [
    ...preferredOrder.filter((prefix) => prefixes.includes(prefix)),
    ...prefixes.filter((prefix) => !preferredOrder.includes(prefix)),
  ];
}

export function getPosModuleSyncTables(): string[] {
  return unique(POS_MODULE_CACHE_ENTRIES.flatMap((entry) => entry.syncTables));
}

/** Cached response existence is never evidence of current module access. */
export function canWarmPosModulePath(path: string, enabledModules: ReadonlySet<string>): boolean {
  // The dedicated delta-aware snapshot owns this path, including the native cache.
  if (path === '/api/pos/purchase-orders' || path.startsWith('/api/pos/purchase-orders?')) return false;
  // Match complete route boundaries, not lookalikes such as /rooms-admin.
  return POS_MODULE_CACHE_ENTRIES.some(entry => enabledModules.has(entry.moduleId) &&
    entry.cachePrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}/`)));
}
