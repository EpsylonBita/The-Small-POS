import { useSyncExternalStore } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';

type StopAudio = () => void;
type Tone = { frequency: number; start: number; duration: number };
const listeners = new Set<() => void>();
const playing = new Set<StopAudio>();
let enabled = true;
let ready = false;
let generation = 0;

function parseEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  }
  return true;
}

export function isAppAudioEnabled(): boolean {
  // Wait for saved settings before playing the first sound after startup.
  return ready && enabled;
}

function stopPlaying(): void {
  for (const stop of [...playing]) stop();
}

/** Apply a value only after its native write succeeds; no read-after-write dependency. */
export function applySavedAppAudioPreference(value: boolean): void {
  generation += 1;
  enabled = value;
  ready = true;
  if (!enabled) stopPlaying();
  for (const listener of listeners) listener();
}

export async function refreshAppAudioPreference(): Promise<void> {
  const request = ++generation;
  try {
    const settings = await getBridge().settings.getLocal();
    if (request !== generation || listeners.size === 0) return;
    const values = settings as Record<string, any> | null;
    enabled = parseEnabled(values?.['ui.audio_enabled'] ?? values?.ui?.audio_enabled
      ?? values?.['terminal.audio_enabled'] ?? values?.terminal?.audio_enabled);
    ready = true;
    if (!enabled) stopPlaying();
    for (const listener of listeners) listener();
  } catch {
    // A failed read keeps the last known preference. On first load stay quiet;
    // the next settings event can recover without an unsolicited alert.
  }
}

const onSettingsUpdated = () => { void refreshAppAudioPreference(); };

export function subscribeAppAudio(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // Rust settings_update_local and terminal sync emit this canonical event.
    onEvent('terminal-settings-updated', onSettingsUpdated);
    void refreshAppAudioPreference();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      offEvent('terminal-settings-updated', onSettingsUpdated);
      generation += 1;
      stopPlaying();
      enabled = true;
      ready = false;
    }
  };
}

export function useAppAudioEnabled(): boolean {
  return useSyncExternalStore(subscribeAppAudio, isAppAudioEnabled, () => false);
}

export function playAppAudioFile(
  url: string,
  options: { volume?: number; onError?: (error: unknown) => void } = {},
): StopAudio {
  if (!isAppAudioEnabled()) return () => {};
  let audio: HTMLAudioElement | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    playing.delete(stop);
    if (audio) {
      audio.removeEventListener('ended', stop);
      audio.pause();
      audio.removeAttribute('src');
    }
  };
  const failed = (error: unknown) => {
    if (stopped) return;
    stop();
    if (isAppAudioEnabled()) options.onError?.(error);
  };
  try {
    audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = options.volume ?? 0.9;
    audio.addEventListener('ended', stop, { once: true });
    playing.add(stop);
    void audio.play().catch(failed);
  } catch (error) {
    // Keep fallback callbacks asynchronous even when constructing Audio throws,
    // so callers can retain the returned stop handle before fallback playback.
    void Promise.resolve().then(() => failed(error));
  }
  return stop;
}

export function playAppAudioTones(notes: readonly Tone[], volume = 0.12): StopAudio {
  if (!isAppAudioEnabled() || typeof window === 'undefined' || notes.length === 0) return () => {};
  const AudioCtx = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return () => {};
  let context: AudioContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    playing.delete(stop);
    clearTimeout(timer);
    void context?.close().catch(() => undefined);
  };
  try {
    context = new AudioCtx();
    playing.add(stop);
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + note.start;
      const end = start + note.duration;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
    if (context.state === 'suspended') void context.resume().catch(stop);
    timer = setTimeout(stop, (Math.max(...notes.map(note => note.start + note.duration)) + 0.1) * 1000);
  } catch {
    stop();
  }
  return stop;
}

export function playAppAudioTest(): StopAudio {
  return playAppAudioTones([{ frequency: 660, start: 0, duration: 0.25 }]);
}
