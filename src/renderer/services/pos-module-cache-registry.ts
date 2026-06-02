export interface PosModuleCacheEntry {
  moduleId: string;
  warmPaths: string[];
  cachePrefixes: string[];
  syncTables: string[];
}

export const POS_MODULE_CACHE_ENTRIES: PosModuleCacheEntry[] = [
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
    moduleId: 'retail_products',
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

export function getPosModuleWarmPaths(): string[] {
  const paths = POS_MODULE_CACHE_ENTRIES.flatMap((entry) => entry.warmPaths);
  return unique([
    ...paths.filter((path) => !path.startsWith('/api/pos/sync/')),
    ...paths.filter((path) => path.startsWith('/api/pos/sync/')),
  ]);
}

export function getPosModuleCachePrefixes(): string[] {
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
  const prefixes = unique(POS_MODULE_CACHE_ENTRIES.flatMap((entry) => entry.cachePrefixes));
  return [
    ...preferredOrder.filter((prefix) => prefixes.includes(prefix)),
    ...prefixes.filter((prefix) => !preferredOrder.includes(prefix)),
  ];
}

export function getPosModuleSyncTables(): string[] {
  return unique(POS_MODULE_CACHE_ENTRIES.flatMap((entry) => entry.syncTables));
}
