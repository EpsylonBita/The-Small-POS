/**
 * procurement-loop Task 10.5: locale runtime-variant audit.
 *
 * The purchase-orders surface builds keys dynamically from statuses
 * (`procurement.status.${status}`) and flavors
 * (`procurement.flavor.${flavor}`), so every runtime variant must exist
 * in ALL five pos-tauri locale files — a missing variant would render a
 * raw key at the counter. Complements `npm run locale:parity`, which
 * checks whole-file key parity against `en.json`. [R15.2, R15.3]
 */
import { describe, expect, it } from 'vitest';

import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import it_ from '../../../locales/it.json';

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ['en', en as Record<string, unknown>],
  ['el', el as Record<string, unknown>],
  ['de', de as Record<string, unknown>],
  ['fr', fr as Record<string, unknown>],
  ['it', it_ as Record<string, unknown>],
];

/** Every PurchaseOrderStatus variant (mirrors shared/types/procurement.ts). */
const STATUS_VARIANTS = [
  'draft',
  'ordered',
  'partially_received',
  'received_closed',
  'cancelled',
] as const;

/** Every PoItemFlavor variant (mirrors shared/types/procurement.ts). */
const FLAVOR_VARIANTS = ['inventory', 'retail', 'legacy'] as const;

/** Static keys the tab, receive dialog, and pending overlay consume. */
const STATIC_KEYS = [
  'procurement.tab',
  'procurement.empty',
  'procurement.searchPlaceholder',
  'procurement.filterAll',
  'procurement.supplier',
  'procurement.expected',
  'procurement.progress',
  'procurement.lastSynced',
  'procurement.neverSynced',
  'procurement.detail.items',
  'procurement.detail.orderedQty',
  'procurement.detail.receivedQty',
  'procurement.detail.remainingQty',
  'procurement.detail.unplanned',
  'procurement.detail.notes',
  'procurement.detail.back',
  'procurement.receive.action',
  'procurement.receive.title',
  'procurement.receive.quantity',
  'procurement.receive.unitCost',
  'procurement.receive.confirmOverReceipt',
  'procurement.receive.notesPlaceholder',
  'procurement.receive.submit',
  'procurement.receive.submitting',
  'procurement.receive.queuedOffline',
  'procurement.receive.recorded',
  'procurement.receive.replayed',
  'procurement.receive.noStaff',
  'procurement.receive.noLines',
  'procurement.receive.failed',
  'procurement.receive.conflict',
  'procurement.receive.moduleRequired',
  'procurement.receive.confirmationRequired',
  'procurement.pending.title',
  'procurement.pending.entry',
  'procurement.pending.parked',
  'procurement.pending.conflictTitle',
  'procurement.pending.conflictBody',
  'procurement.pending.retry',
  'procurement.pending.retryQueued',
  'procurement.pending.quantities',
  'procurement.offline.receiveNote',
] as const;

function resolve(locale: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, locale);
}

describe('procurement locale runtime variants', () => {
  it.each(LOCALES.map(([name]) => name))(
    '%s carries every dynamic procurement.status.* variant',
    (name) => {
      const locale = LOCALES.find(([localeName]) => localeName === name)![1];
      for (const status of STATUS_VARIANTS) {
        const value = resolve(locale, `procurement.status.${status}`);
        expect(value, `${name}: procurement.status.${status}`).toBeTypeOf('string');
        expect(String(value).trim(), `${name}: procurement.status.${status}`).not.toBe('');
      }
    },
  );

  it.each(LOCALES.map(([name]) => name))(
    '%s carries every dynamic procurement.flavor.* variant',
    (name) => {
      const locale = LOCALES.find(([localeName]) => localeName === name)![1];
      for (const flavor of FLAVOR_VARIANTS) {
        const value = resolve(locale, `procurement.flavor.${flavor}`);
        expect(value, `${name}: procurement.flavor.${flavor}`).toBeTypeOf('string');
        expect(String(value).trim(), `${name}: procurement.flavor.${flavor}`).not.toBe('');
      }
    },
  );

  it.each(LOCALES.map(([name]) => name))('%s carries the full static key set', (name) => {
    const locale = LOCALES.find(([localeName]) => localeName === name)![1];
    for (const key of STATIC_KEYS) {
      const value = resolve(locale, key);
      expect(value, `${name}: ${key}`).toBeTypeOf('string');
      expect(String(value).trim(), `${name}: ${key}`).not.toBe('');
    }
  });
});
