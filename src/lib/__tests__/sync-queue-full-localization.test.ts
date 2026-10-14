import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import el from '../../locales/el.json';
import de from '../../locales/de.json';
import fr from '../../locales/fr.json';
import it_ from '../../locales/it.json';
import sq from '../../locales/sq.json';
import {
  formatSyncQueueFullMessage,
  SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE,
  SYNC_QUEUE_FULL_ERROR_CODE,
  syncQueueFullErrorCode,
} from '../sync-queue-full';

// Offline-week audit (13/10/2026): at its ceiling the till's offline queue
// refuses a sale or change typed (`SYNC_QUEUE_FULL` /
// `SYNC_QUEUE_CONFLICTS_FULL`, sync_queue.rs). The cashier used to read the
// native English "Sync queue is full (5000/5000). Clear or process pending
// items…"; the refusal is now said in the store's language with what to do.

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

const translatorFor = async (lng: Lng) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: false,
    resources: { [lng]: { translation: LOCALES[lng] } },
    interpolation: { escapeValue: false },
  });
  return instance.t;
};

// What the native checkout answers, wrapped by its caller.
const queueFull = new Error(
  'enqueue parity sync: SYNC_QUEUE_FULL: Sync queue is full (20000/20000). New sales stop until this terminal reconnects and the queue drains; nothing already queued is lost.',
);
const conflictsFull =
  'SYNC_QUEUE_CONFLICTS_FULL: Sync queue conflict backlog is full (1000/1000). Resolve conflicted items before enqueuing more.';

describe('a write the full offline queue refused', () => {
  it.each(Object.keys(LOCALES) as Lng[])('is said in %s, never in the native English', async (lng) => {
    const t = await translatorFor(lng);
    const full = formatSyncQueueFullMessage(queueFull, t);
    expect(full).toBe(LOCALES[lng].sync.capacity.full);
    expect(full).not.toContain('SYNC_QUEUE_FULL');
    const conflicts = formatSyncQueueFullMessage(conflictsFull, t);
    expect(conflicts).toBe(LOCALES[lng].sync.capacity.conflictsFull);
    if (lng !== 'en') {
      expect(full).not.toBe(en.sync.capacity.full);
      expect(conflicts).not.toBe(en.sync.capacity.conflictsFull);
    }
  });

  it('names which ceiling refused, wherever the code sits in the error', () => {
    expect(syncQueueFullErrorCode(queueFull)).toBe(SYNC_QUEUE_FULL_ERROR_CODE);
    expect(syncQueueFullErrorCode({ message: queueFull.message })).toBe(SYNC_QUEUE_FULL_ERROR_CODE);
    expect(syncQueueFullErrorCode(conflictsFull)).toBe(SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE);
    expect(syncQueueFullErrorCode({ error: conflictsFull })).toBe(SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE);
  });

  it('leaves every other error to its own handling', async () => {
    const t = await translatorFor('en');
    expect(syncQueueFullErrorCode(new Error('Missing order payload'))).toBeNull();
    expect(syncQueueFullErrorCode('REPAIR_QUEUE_CAPACITY_EXHAUSTED')).toBeNull();
    expect(syncQueueFullErrorCode(undefined)).toBeNull();
    expect(formatSyncQueueFullMessage('Order must contain at least one item', t)).toBeNull();
  });
});
