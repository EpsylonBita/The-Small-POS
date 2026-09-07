import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getLocal, handlers, onEvent, offEvent } = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  return {
    getLocal: vi.fn(), handlers,
    onEvent: vi.fn((event: string, callback: () => void) => handlers.set(event, callback)),
    offEvent: vi.fn((event: string) => handlers.delete(event)),
  };
});
vi.mock('../../../lib', () => ({
  getBridge: () => ({ settings: { getLocal } }), onEvent, offEvent,
}));

import { applySavedAppAudioPreference, isAppAudioEnabled, playAppAudioFile, playAppAudioTest, subscribeAppAudio } from '../appAudio';

let dispose: (() => void) | undefined;
let audios: FakeAudio[];
let contexts: FakeAudioContext[];

class FakeAudio {
  preload = '';
  volume = 0;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  removeAttribute = vi.fn();
  constructor(_url: string) { audios.push(this); }
}
class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  createOscillator = vi.fn(() => ({ type: '', frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(), start: vi.fn(), stop: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }));
  constructor() { contexts.push(this); }
}

async function settle() { await Promise.resolve(); await Promise.resolve(); }
async function mount(settings: unknown) {
  getLocal.mockResolvedValue(settings);
  dispose = subscribeAppAudio(vi.fn());
  await settle();
}
async function update(settings: unknown) {
  getLocal.mockResolvedValue(settings);
  handlers.get('terminal-settings-updated')?.();
  await settle();
}

describe('live POS audio preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audios = [];
    contexts = [];
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.unstubAllGlobals();
  });

  it('waits for the saved value and enables sound when the setting is absent', async () => {
    expect(isAppAudioEnabled()).toBe(false);
    playAppAudioTest();
    expect(contexts).toHaveLength(0);
    await mount({});
    expect(isAppAudioEnabled()).toBe(true);
    playAppAudioFile('/alert.mp3');
    playAppAudioTest();
    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith('terminal-settings-updated', expect.any(Function));
  });

  it('immediately applies a persisted mute, stops current sound and ignores an older read', async () => {
    await mount({});
    playAppAudioFile('/alert.mp3');
    let resolveRead!: (settings: unknown) => void;
    getLocal.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    handlers.get('terminal-settings-updated')?.();
    applySavedAppAudioPreference(false);
    expect(isAppAudioEnabled()).toBe(false);
    expect(audios[0].pause).toHaveBeenCalledOnce();
    resolveRead({ ui: { audio_enabled: true } });
    await settle();
    expect(isAppAudioEnabled()).toBe(false);
  });

  it.each([false, 0, 'false', '0', 'off', 'NO', 'disabled'])('honors saved false form %s without constructing audio', async (value) => {
    await mount({ ui: { audio_enabled: value } });
    playAppAudioFile('/alert.mp3');
    playAppAudioTest();
    expect(isAppAudioEnabled()).toBe(false);
    expect(audios).toHaveLength(0);
    expect(contexts).toHaveLength(0);
  });

  it('uses legacy terminal values, with explicit UI values taking precedence', async () => {
    await mount({ 'terminal.audio_enabled': 'false' });
    expect(isAppAudioEnabled()).toBe(false);
    await update({ terminal: { audio_enabled: false }, 'ui.audio_enabled': 'yes' });
    expect(isAppAudioEnabled()).toBe(true);
  });

  it('stops playing files and tones on a live disable, suppresses further sounds, then allows re-enable', async () => {
    await mount({});
    playAppAudioFile('/alert.mp3');
    playAppAudioTest();
    await update({ ui: { audio_enabled: false } });
    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    playAppAudioFile('/repeat.mp3');
    playAppAudioTest();
    expect(audios).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    await update({ ui: { audio_enabled: true } });
    playAppAudioFile('/new.mp3');
    expect(audios).toHaveLength(2);
  });

  it('does not invoke a fallback tone after a pending file play rejects while muted', async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, no) => { reject = no; });
    const failure = vi.fn(() => playAppAudioTest());
    class PendingAudio extends FakeAudio { play = vi.fn(() => pending); }
    vi.stubGlobal('Audio', PendingAudio);
    await mount({});
    playAppAudioFile('/alert.mp3', { onError: failure });
    await update({ ui: { audio_enabled: false } });
    reject(new Error('play interrupted'));
    await settle();
    expect(failure).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(0);
  });

  it('ignores an older settings response after a newer mute value', async () => {
    let resolve!: (value: unknown) => void;
    getLocal.mockReturnValue(new Promise(yes => { resolve = yes; }));
    dispose = subscribeAppAudio(vi.fn());
    await update({ ui: { audio_enabled: false } });
    resolve({ ui: { audio_enabled: true } });
    await settle();
    expect(isAppAudioEnabled()).toBe(false);
  });

  it('shares one settings subscription and stops audio when its last consumer unmounts', async () => {
    await mount({});
    const otherDispose = subscribeAppAudio(vi.fn());
    expect(getLocal).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    playAppAudioFile('/alert.mp3');
    otherDispose();
    expect(audios[0].pause).not.toHaveBeenCalled();
    dispose?.();
    dispose = undefined;
    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(offEvent).toHaveBeenCalledTimes(1);
  });
});
