import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getLocal } = vi.hoisted(() => ({ getLocal: vi.fn().mockResolvedValue({ ui: { audio_enabled: true } }) }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ settings: { getLocal } }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

import { applySavedAppAudioPreference } from '../appAudio';
import {
  __setPlatformSoundStoreForTests,
  getActivePlatformSoundUrl,
  importPlatformSoundFile,
  MAX_IMPORT_BYTES,
  playSelectedPlatformSound,
  previewPlatformSound,
  selectImportedPlatformSound,
  selectPlatformSoundPreset,
  subscribePlatformNotificationSound,
  getPlatformNotificationSoundSnapshot,
} from '../platformNotificationSound';
import type { PlatformSoundStoredRecord, PlatformSoundStore } from '../platformNotificationSoundStorage';

class InMemoryStore implements PlatformSoundStore {
  record: PlatformSoundStoredRecord | null = null;
  failWrites = false;
  async read() {
    return this.record;
  }
  async write(record: PlatformSoundStoredRecord) {
    if (this.failWrites) throw new Error('write failed');
    this.record = record;
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = '';
  volume = 0;
  src = '';
  duration = 5;
  listeners = new Map<string, () => void>();
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn(() => { this.duration = Number.NaN; });
  constructor(url?: string) {
    if (url) this.src = url;
    FakeAudio.instances.push(this);
  }
  addEventListener(event: string, handler: () => void) {
    this.listeners.set(event, handler);
  }
  removeEventListener(event: string) {
    this.listeners.delete(event);
  }
  fire(event: string) {
    this.listeners.get(event)?.();
  }
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let store: InMemoryStore;

describe('platformNotificationSound', () => {
  beforeEach(() => {
    store = new InMemoryStore();
    __setPlatformSoundStoreForTests(store);
    FakeAudio.instances = [];
    vi.stubGlobal('Audio', FakeAudio);
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = vi.fn(() => 'blob:fake-url');
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = vi.fn();
    applySavedAppAudioPreference(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists a preset selection and reloads it as a fresh module read', async () => {
    const result = await selectPlatformSoundPreset('spiderman');
    expect(result.ok).toBe(true);
    expect(store.record?.selectedId).toBe('spiderman');

    // Simulate a reload by pointing a fresh in-memory state at the same durable store.
    __setPlatformSoundStoreForTests(store);
    const dispose = subscribePlatformNotificationSound(() => {});
    await settle();
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('spiderman');
    dispose();
  });

  it('keeps the previous selection when a write fails', async () => {
    await selectPlatformSoundPreset('one_piece');
    store.failWrites = true;
    const result = await selectPlatformSoundPreset('super_mario');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('one_piece');
  });

  it('rejects an oversized import and keeps the previous choice', async () => {
    await selectPlatformSoundPreset('spiderman');
    const bigFile = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], 'clip.mp3', { type: 'audio/mpeg' });
    const result = await importPlatformSoundFile(bigFile);
    expect(result.ok).toBe(false);
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('spiderman');
  });

  it('rejects an unsupported file type', async () => {
    const file = new File([new Uint8Array(10)], 'clip.txt', { type: 'text/plain' });
    const result = await importPlatformSoundFile(file);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalidType');
  });

  it('imports a valid clip, selects it, and allows reselecting a preset then the import again', async () => {
    const file = new File([new Uint8Array(10)], 'my clip.mp3', { type: 'audio/mpeg' });
    const importing = importPlatformSoundFile(file);
    await settle();
    FakeAudio.instances[0].duration = 10;
    FakeAudio.instances[0].fire('loadedmetadata');
    const result = await importing;
    expect(result.ok).toBe(true);
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('custom');
    expect(getPlatformNotificationSoundSnapshot().importedName).toBe('my clip.mp3');

    await selectPlatformSoundPreset('super_mario');
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('super_mario');
    expect(getPlatformNotificationSoundSnapshot().hasImportedClip).toBe(true);

    const reselect = await selectImportedPlatformSound();
    expect(reselect.ok).toBe(true);
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('custom');
  });

  it('rejects a clip longer than the maximum duration', async () => {
    const file = new File([new Uint8Array(10)], 'long.mp3', { type: 'audio/mpeg' });
    const importing = importPlatformSoundFile(file);
    await settle();
    FakeAudio.instances[0].duration = 31;
    FakeAudio.instances[0].fire('loadedmetadata');
    const result = await importing;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tooLong');
  });

  it('resolves the active playback URL to the default preset before load and after selection', async () => {
    expect(getActivePlatformSoundUrl()).toContain('incoming-order');
    await selectPlatformSoundPreset('one_piece');
    expect(getActivePlatformSoundUrl()).toContain('one_piece');
  });

  it('falls back to the default clip, then to tones, when the selected clip and the default both fail to play', async () => {
    await selectPlatformSoundPreset('spiderman');
    class RejectingAudio extends FakeAudio {
      play = vi.fn(async () => {
        throw new Error('play failed');
      });
    }
    vi.stubGlobal('Audio', RejectingAudio);
    const onFallbackToTones = vi.fn();
    playSelectedPlatformSound({ onFallbackToTones });
    await settle();
    // The selected (non-default) clip fails, then the default clip is attempted, then tones.
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0].src).toContain('spiderman');
    expect(FakeAudio.instances[1].src).toContain('incoming-order');
    expect(onFallbackToTones).toHaveBeenCalledOnce();
  });

  it('stop ownership prevents a late fallback from resurrecting audio after stop() is called', async () => {
    await selectPlatformSoundPreset('spiderman');
    let rejectPlay!: (reason: unknown) => void;
    class RejectingAudio extends FakeAudio {
      play = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    }
    vi.stubGlobal('Audio', RejectingAudio);
    const onFallbackToTones = vi.fn();
    const stop = playSelectedPlatformSound({ onFallbackToTones });
    await settle();
    stop();
    rejectPlay(new Error('late failure'));
    await settle();
    expect(onFallbackToTones).not.toHaveBeenCalled();
  });

  it('does not invoke the fallback while muted', async () => {
    await selectPlatformSoundPreset('spiderman');
    let rejectPlay!: (reason: unknown) => void;
    class RejectingAudio extends FakeAudio {
      play = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    }
    vi.stubGlobal('Audio', RejectingAudio);
    const onFallbackToTones = vi.fn();
    playSelectedPlatformSound({ onFallbackToTones });
    await settle();
    applySavedAppAudioPreference(false);
    rejectPlay(new Error('failure while muted'));
    await settle();
    expect(onFallbackToTones).not.toHaveBeenCalled();
  });

  it('the fallback chain stop handle is owned by the outer stop, so stopping after the tone fallback engages still stops it', async () => {
    await selectPlatformSoundPreset('spiderman');
    class RejectingAudio extends FakeAudio {
      play = vi.fn(async () => {
        throw new Error('play failed');
      });
    }
    vi.stubGlobal('Audio', RejectingAudio);
    const toneStop = vi.fn();
    const onFallbackToTones = vi.fn(() => toneStop);
    const stop = playSelectedPlatformSound({ onFallbackToTones });
    await settle();
    expect(onFallbackToTones).toHaveBeenCalledOnce();
    stop();
    expect(toneStop).toHaveBeenCalledOnce();
  });

  it('uses the persisted selection for the very first alert, before any subscriber has read it', async () => {
    store.record = { selectedId: 'one_piece', importedName: null, importedBlob: null };
    // No subscribe/select call happened yet; this is the first thing the module does.
    const onFallbackToTones = vi.fn();
    playSelectedPlatformSound({ onFallbackToTones });
    await settle();
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toContain('one_piece');
  });

  it('never starts audio if stop() is called before the persisted selection finishes loading', async () => {
    let resolveRead!: (record: PlatformSoundStoredRecord | null) => void;
    store.read = () => new Promise((resolve) => { resolveRead = resolve; });
    const onFallbackToTones = vi.fn();
    const stop = playSelectedPlatformSound({ onFallbackToTones });
    stop();
    resolveRead({ selectedId: 'spiderman', importedName: null, importedBlob: null });
    await settle();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('an order alert stops an active preview and blocks new previews while it owns playback', async () => {
    await selectPlatformSoundPreset('spiderman');
    const started = previewPlatformSound('one_piece');
    expect(started).toBe(true);
    expect(getPlatformNotificationSoundSnapshot().previewingId).toBe('one_piece');

    const stop = playSelectedPlatformSound({});
    await settle();
    expect(getPlatformNotificationSoundSnapshot().previewingId).toBeNull();

    expect(previewPlatformSound('super_mario')).toBe(false);
    expect(getPlatformNotificationSoundSnapshot().previewingId).toBeNull();

    stop();
    expect(previewPlatformSound('super_mario')).toBe(true);
  });

  it('serializes a selection and an import so they cannot race and leave a stale imported blob', async () => {
    const file = new File([new Uint8Array(10)], 'clip.mp3', { type: 'audio/mpeg' });
    const selecting = selectPlatformSoundPreset('spiderman');
    const importing = importPlatformSoundFile(file);
    for (let i = 0; i < 10 && FakeAudio.instances.length === 0; i += 1) {
      await settle();
    }
    // The selection ahead of it in the queue writes no audio; only the
    // import's metadata decode constructs an Audio, and only one at a time.
    expect(FakeAudio.instances).toHaveLength(1);
    FakeAudio.instances[0].fire('loadedmetadata');
    const [selectResult, importResult] = await Promise.all([selecting, importing]);
    expect(selectResult.ok).toBe(true);
    expect(importResult.ok).toBe(true);
    expect(getPlatformNotificationSoundSnapshot().selectedId).toBe('custom');
    expect(store.record?.selectedId).toBe('custom');
  });
});
