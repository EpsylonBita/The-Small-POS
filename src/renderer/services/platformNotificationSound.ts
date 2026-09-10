import { useSyncExternalStore } from 'react';
import { playAppAudioFile } from './appAudio';
import {
  createIndexedDbPlatformSoundStore,
  type PlatformSoundPresetId,
  type PlatformSoundSelectionId,
  type PlatformSoundStore,
  type PlatformSoundStoredRecord,
} from './platformNotificationSoundStorage';

export type { PlatformSoundPresetId, PlatformSoundSelectionId } from './platformNotificationSoundStorage';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_DURATION_SECONDS = 30;
const METADATA_TIMEOUT_MS = 5000;
const ALLOWED_EXTENSIONS = ['.mp3', '.wav'];
const ALLOWED_MIME_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'];

export interface PlatformSoundPreset {
  id: PlatformSoundPresetId;
  url: string;
  labelKey: string;
  defaultLabel: string;
}

// Vite only statically discovers `new URL('literal', import.meta.url)` when the
// first argument is a string literal at each call site, so these cannot be
// produced by a shared helper function without breaking the production build.
export const PLATFORM_SOUND_PRESETS: readonly PlatformSoundPreset[] = [
  {
    id: 'default',
    url: new URL('../assets/sounds/incoming-order.mp3', import.meta.url).href,
    labelKey: 'settings.platforms.sound.presets.default',
    defaultLabel: 'Incoming order (default)',
  },
  {
    id: 'spiderman',
    url: new URL('../assets/sounds/spiderman.mp3', import.meta.url).href,
    labelKey: 'settings.platforms.sound.presets.spiderman',
    defaultLabel: 'Spider-Man',
  },
  {
    id: 'one_piece',
    url: new URL('../assets/sounds/one_piece.mp3', import.meta.url).href,
    labelKey: 'settings.platforms.sound.presets.onePiece',
    defaultLabel: 'One Piece',
  },
  {
    id: 'super_mario',
    url: new URL('../assets/sounds/super_mario.mp3', import.meta.url).href,
    labelKey: 'settings.platforms.sound.presets.superMario',
    defaultLabel: 'Super Mario',
  },
];

const DEFAULT_PRESET = PLATFORM_SOUND_PRESETS[0];

function getPresetById(id: PlatformSoundPresetId): PlatformSoundPreset {
  return PLATFORM_SOUND_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}

export interface PlatformSoundSnapshot {
  loaded: boolean;
  selectedId: PlatformSoundSelectionId;
  importedName: string | null;
  hasImportedClip: boolean;
  storageUnavailable: boolean;
  /** Which option (if any) is currently being previewed; shared so any owner can reset the UI. */
  previewingId: PlatformSoundSelectionId | null;
}

const INITIAL_SNAPSHOT: PlatformSoundSnapshot = {
  loaded: false,
  selectedId: 'default',
  importedName: null,
  hasImportedClip: false,
  storageUnavailable: false,
  previewingId: null,
};

type StopAudio = () => void;

let store: PlatformSoundStore = createIndexedDbPlatformSoundStore();
let snapshot: PlatformSoundSnapshot = INITIAL_SNAPSHOT;
let importedBlob: Blob | null = null;
let customObjectUrl: string | null = null;
let initPromise: Promise<void> | null = null;
let initGeneration = 0;
const listeners = new Set<() => void>();

// Serializes every mutation (preset select / reselect-import / import) onto a
// single chain so an in-flight import can never be raced by a selection (or
// another import) reading/writing the shared importedBlob concurrently.
let mutationQueue: Promise<void> = Promise.resolve();
function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Playback ownership: an active order alert always wins over a preview, and a
// preview can never start (or resurrect) while an order alert owns playback.
let orderOwnerToken = 0;
let orderActive = false;
let activePreviewStop: StopAudio | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function revokeCustomObjectUrl(): void {
  if (customObjectUrl) {
    URL.revokeObjectURL(customObjectUrl);
    customObjectUrl = null;
  }
}

function stopActivePreview(): void {
  const stopFn = activePreviewStop;
  activePreviewStop = null;
  stopFn?.();
  if (snapshot.previewingId !== null) {
    snapshot = { ...snapshot, previewingId: null };
    notify();
  }
}

function applyRecord(record: PlatformSoundStoredRecord | null): void {
  revokeCustomObjectUrl();
  importedBlob = record?.importedBlob ?? null;
  snapshot = {
    ...INITIAL_SNAPSHOT,
    loaded: true,
    selectedId: record?.selectedId ?? 'default',
    importedName: record?.importedName ?? null,
    hasImportedClip: Boolean(record?.importedBlob),
  };
}

function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  const myGeneration = initGeneration;
  initPromise = store
    .read()
    .then((record) => {
      if (myGeneration !== initGeneration) return;
      applyRecord(record);
      notify();
    })
    .catch(() => {
      if (myGeneration !== initGeneration) return;
      snapshot = { ...INITIAL_SNAPSHOT, loaded: true, storageUnavailable: true };
      notify();
    });
  return initPromise;
}

export function subscribePlatformNotificationSound(listener: () => void): () => void {
  listeners.add(listener);
  void ensureInitialized();
  return () => {
    listeners.delete(listener);
  };
}

export function getPlatformNotificationSoundSnapshot(): PlatformSoundSnapshot {
  return snapshot;
}

export function usePlatformNotificationSoundSelection(): PlatformSoundSnapshot {
  return useSyncExternalStore(
    subscribePlatformNotificationSound,
    getPlatformNotificationSoundSnapshot,
    () => INITIAL_SNAPSHOT,
  );
}

export interface PlatformSoundActionResult {
  ok: boolean;
  error?: string;
}

async function doSelectPreset(id: PlatformSoundPresetId): Promise<PlatformSoundActionResult> {
  await ensureInitialized();
  stopActivePreview();
  const record: PlatformSoundStoredRecord = {
    selectedId: id,
    importedName: snapshot.importedName,
    importedBlob,
  };
  try {
    await store.write(record);
  } catch {
    return { ok: false, error: 'settings.platforms.sound.errors.saveFailed' };
  }
  snapshot = { ...snapshot, loaded: true, selectedId: id, storageUnavailable: false };
  notify();
  return { ok: true };
}

export function selectPlatformSoundPreset(id: PlatformSoundPresetId): Promise<PlatformSoundActionResult> {
  return enqueueMutation(() => doSelectPreset(id));
}

async function doSelectImported(): Promise<PlatformSoundActionResult> {
  await ensureInitialized();
  stopActivePreview();
  if (!importedBlob) {
    return { ok: false, error: 'settings.platforms.sound.errors.noImportedClip' };
  }
  const record: PlatformSoundStoredRecord = {
    selectedId: 'custom',
    importedName: snapshot.importedName,
    importedBlob,
  };
  try {
    await store.write(record);
  } catch {
    return { ok: false, error: 'settings.platforms.sound.errors.saveFailed' };
  }
  snapshot = { ...snapshot, loaded: true, selectedId: 'custom', storageUnavailable: false };
  notify();
  return { ok: true };
}

export function selectImportedPlatformSound(): Promise<PlatformSoundActionResult> {
  return enqueueMutation(() => doSelectImported());
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function readAudioDuration(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      // Fully release the decoder/buffer tied to the object URL, not just the URL itself.
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      run();
    };
    const onLoaded = () => {
      // Releasing the media source resets duration to NaN in WebView2/Chromium.
      const duration = audio.duration;
      finish(() => resolve(duration));
    };
    const onError = () => finish(() => reject(new Error('decode-failed')));
    const onAbort = () => finish(() => reject(new Error('aborted')));
    timer = setTimeout(() => finish(() => reject(new Error('metadata-timeout'))), METADATA_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('error', onError);
    audio.preload = 'metadata';
    audio.src = url;
  });
}

async function doImportFile(file: File, signal?: AbortSignal): Promise<PlatformSoundActionResult> {
  await ensureInitialized();
  if (!hasAllowedExtension(file.name) && !ALLOWED_MIME_TYPES.includes(file.type)) {
    return { ok: false, error: 'settings.platforms.sound.errors.invalidType' };
  }
  if (file.size === 0) {
    return { ok: false, error: 'settings.platforms.sound.errors.invalidType' };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return { ok: false, error: 'settings.platforms.sound.errors.tooLarge' };
  }

  let duration: number;
  try {
    duration = await readAudioDuration(file, signal);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.message === 'aborted')) {
      return { ok: false, error: 'settings.platforms.sound.errors.cancelled' };
    }
    return { ok: false, error: 'settings.platforms.sound.errors.decodeFailed' };
  }
  if (signal?.aborted) {
    return { ok: false, error: 'settings.platforms.sound.errors.cancelled' };
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: 'settings.platforms.sound.errors.decodeFailed' };
  }
  if (duration > MAX_IMPORT_DURATION_SECONDS) {
    return { ok: false, error: 'settings.platforms.sound.errors.tooLong' };
  }

  stopActivePreview();
  const record: PlatformSoundStoredRecord = {
    selectedId: 'custom',
    importedName: file.name,
    importedBlob: file,
  };
  try {
    await store.write(record);
  } catch {
    return { ok: false, error: 'settings.platforms.sound.errors.saveFailed' };
  }

  // Replacing the imported clip must not accumulate old object URLs.
  revokeCustomObjectUrl();
  importedBlob = file;
  snapshot = {
    ...snapshot,
    loaded: true,
    selectedId: 'custom',
    importedName: file.name,
    hasImportedClip: true,
    storageUnavailable: false,
  };
  notify();
  return { ok: true };
}

/** Invalid input, cancellation, or a failed durable write leaves the prior selection/import untouched. */
export function importPlatformSoundFile(file: File, signal?: AbortSignal): Promise<PlatformSoundActionResult> {
  return enqueueMutation(() => doImportFile(file, signal));
}

function getCustomPlaybackUrl(): string | null {
  if (!importedBlob) return null;
  if (!customObjectUrl) customObjectUrl = URL.createObjectURL(importedBlob);
  return customObjectUrl;
}

export function getActivePlatformSoundUrl(): string {
  if (snapshot.selectedId === 'custom') {
    const url = getCustomPlaybackUrl();
    if (url) return url;
  } else {
    return getPresetById(snapshot.selectedId).url;
  }
  return DEFAULT_PRESET.url;
}

/**
 * Starts (or stops) previewing one option. Returns false without starting
 * anything while an order alert owns playback, so a preview can never
 * interrupt an active order alert.
 */
export function previewPlatformSound(id: PlatformSoundSelectionId): boolean {
  if (orderActive) return false;
  stopActivePreview();
  const url = id === 'custom' ? getCustomPlaybackUrl() : getPresetById(id).url;
  if (!url) return false;
  const resetIfCurrent = () => {
    activePreviewStop = null;
    if (snapshot.previewingId === id) {
      snapshot = { ...snapshot, previewingId: null };
      notify();
    }
  };
  const stopFn = playAppAudioFile(url, { volume: 0.9, onEnded: resetIfCurrent, onError: resetIfCurrent });
  activePreviewStop = stopFn;
  snapshot = { ...snapshot, previewingId: id };
  notify();
  return true;
}

export function stopPlatformSoundPreview(): void {
  stopActivePreview();
}

export interface PlaySelectedPlatformSoundOptions {
  volume?: number;
  /** Called when both the selected clip and the built-in default fail; returns the fallback's own stop handle so it stays under this call's ownership. */
  onFallbackToTones?: () => StopAudio;
}

/**
 * Plays the terminal's selected platform alert sound, waiting for the
 * persisted selection to load first (so the very first alert after a
 * restart uses the saved choice, not a default that "loads in" later).
 * Falls back to the built-in default clip on playback failure, then to the
 * caller's tone fallback. `stopped` is checked before every async step
 * (including after the initial load) so a caller that stops (or mute
 * suppresses playback) before a step runs can never have it start audio.
 * An active order alert always takes ownership over any running preview.
 */
export function playSelectedPlatformSound(options: PlaySelectedPlatformSoundOptions = {}): StopAudio {
  let stopped = false;
  let currentStop: StopAudio = () => {};
  const myToken = ++orderOwnerToken;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    currentStop();
    if (orderOwnerToken === myToken) orderActive = false;
  };

  stopActivePreview();
  orderActive = true;

  const playDefault = () => {
    if (stopped) return;
    currentStop = playAppAudioFile(DEFAULT_PRESET.url, {
      volume: options.volume,
      onError: () => {
        if (stopped) return;
        currentStop = options.onFallbackToTones?.() ?? (() => {});
      },
    });
  };

  const start = () => {
    if (stopped) return;
    const url = getActivePlatformSoundUrl();
    if (url === DEFAULT_PRESET.url) {
      playDefault();
    } else {
      currentStop = playAppAudioFile(url, { volume: options.volume, onError: playDefault });
    }
  };

  void ensureInitialized().then(() => {
    if (stopped) return;
    start();
  });

  return stop;
}

/** Test-only seam: swap the durable storage boundary and reset in-memory state. */
export function __setPlatformSoundStoreForTests(nextStore: PlatformSoundStore): void {
  store = nextStore;
  initPromise = null;
  initGeneration += 1;
  mutationQueue = Promise.resolve();
  revokeCustomObjectUrl();
  importedBlob = null;
  activePreviewStop = null;
  orderActive = false;
  snapshot = INITIAL_SNAPSHOT;
}
