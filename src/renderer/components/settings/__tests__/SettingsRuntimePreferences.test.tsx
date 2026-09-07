import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge, state } = vi.hoisted(() => ({
  state: { enabled: true },
  bridge: { settings: { getLocal: vi.fn(), updateLocal: vi.fn() }, system: { openSettings: vi.fn() } },
}));
vi.mock('../../../../lib', () => ({ getBridge: () => bridge, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

import { SettingsRuntimePreferences } from '../SettingsRuntimePreferences';

async function renderReady(props = {}) {
  render(<SettingsRuntimePreferences {...props} />);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'POS notification sounds' })).toHaveAttribute('aria-checked', String(state.enabled)));
}

describe('SettingsRuntimePreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = true;
    bridge.settings.getLocal.mockImplementation(async () => ({ ui: { audio_enabled: state.enabled } }));
    bridge.settings.updateLocal.mockImplementation(async (request) => {
      state.enabled = request.settings.audio_enabled;
      return { success: true };
    });
    bridge.system.openSettings.mockImplementation(async (section) => ({ success: true, section }));
  });
  afterEach(cleanup);

  it('saves the sound switch immediately and gates test playback using the saved preference', async () => {
    await renderReady();
    expect(screen.getByRole('button', { name: 'Test sound' })).toBeEnabled();
    fireEvent.click(screen.getByRole('switch', { name: 'POS notification sounds' }));
    await waitFor(() => expect(bridge.settings.updateLocal).toHaveBeenCalledWith({
      settingType: 'ui', settings: { audio_enabled: false },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test sound' })).toBeDisabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('reverts a rejected native failure envelope and shows the error', async () => {
    bridge.settings.updateLocal.mockResolvedValue({ success: false, error: 'Access denied' });
    await renderReady();
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Test sound' })).toBeEnabled();
  });

  it('applies a successfully saved mute even when the settings read service becomes unavailable', async () => {
    await renderReady();
    bridge.settings.getLocal.mockRejectedValue(new Error('Read unavailable'));
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Test sound' })).toBeDisabled();
  });

  it('prevents duplicate saves and sound tests while saving', async () => {
    let resolve!: (value: unknown) => void;
    bridge.settings.updateLocal.mockReturnValue(new Promise(yes => { resolve = yes; }));
    await renderReady();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test sound' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    fireEvent.click(screen.getByRole('switch'));
    expect(bridge.settings.updateLocal).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: false, error: 'Try again' }));
    expect(screen.getByRole('switch')).toBeEnabled();
  });

  it.each([
    ['Display and brightness', 'display'], ['Speakers and volume', 'sound'],
    ['Pointer and touch feedback', 'touch'], ['Screen sleep and power', 'power'],
  ])('opens %s through the fixed native section', async (label, section) => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(bridge.system.openSettings).toHaveBeenCalledExactlyOnceWith(section));
    expect(bridge.settings.updateLocal).not.toHaveBeenCalled();
  });

  it('shows unsupported Windows launch errors and restores its buttons', async () => {
    bridge.system.openSettings.mockRejectedValue(new Error('Supported only on Windows'));
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Display and brightness' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Supported only on Windows');
    expect(screen.getByRole('button', { name: 'Display and brightness' })).toBeEnabled();
  });

  it('offers navigation to actual receipt and security settings', async () => {
    const onOpenPrinterSettings = vi.fn();
    const onOpenSecurity = vi.fn();
    await renderReady({ onOpenPrinterSettings, onOpenSecurity });
    fireEvent.click(screen.getByRole('button', { name: 'Receipt and printer settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'PIN and security settings' }));
    expect(onOpenPrinterSettings).toHaveBeenCalledOnce();
    expect(onOpenSecurity).toHaveBeenCalledOnce();
  });
});
