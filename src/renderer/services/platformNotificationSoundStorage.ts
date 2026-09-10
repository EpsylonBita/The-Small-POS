export type PlatformSoundPresetId = 'default' | 'spiderman' | 'one_piece' | 'super_mario';
export type PlatformSoundSelectionId = PlatformSoundPresetId | 'custom';

export interface PlatformSoundStoredRecord {
  selectedId: PlatformSoundSelectionId;
  importedName: string | null;
  importedBlob: Blob | null;
}

export interface PlatformSoundStore {
  read(): Promise<PlatformSoundStoredRecord | null>;
  write(record: PlatformSoundStoredRecord): Promise<void>;
}

const DB_NAME = 'pos-platform-notification-sound';
const DB_VERSION = 1;
const STORE_NAME = 'selection';
const RECORD_KEY = 'selection';
const OPEN_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    // A blocked upgrade (another tab holding an older-version connection open)
    // would otherwise hang the open request indefinitely.
    request.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
  return withTimeout(attempt, OPEN_TIMEOUT_MS, 'indexedDB open timed out');
}

/**
 * Resolves only on transaction completion (not per-request success) so a
 * selection/import is never observed as saved before it is actually durable.
 */
export function createIndexedDbPlatformSoundStore(): PlatformSoundStore {
  return {
    async read() {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        let result: PlatformSoundStoredRecord | null = null;
        request.onsuccess = () => {
          result = (request.result as PlatformSoundStoredRecord | undefined) ?? null;
        };
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('read failed'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('read aborted'));
        };
      });
    },
    async write(record) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('write failed'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('write aborted'));
        };
      });
    },
  };
}
