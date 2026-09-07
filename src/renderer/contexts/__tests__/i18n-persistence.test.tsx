import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLanguage: vi.fn(),
  setLanguage: vi.fn(),
  i18n: { language: 'en', changeLanguage: vi.fn() },
}));
vi.mock('../../../lib', () => {
  const bridge = { settings: { getLanguage: mocks.getLanguage, setLanguage: mocks.setLanguage } };
  return { getBridge: () => bridge };
});
vi.mock('../../../lib/i18n', () => ({ default: mocks.i18n }));
vi.mock('react-i18next', () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
  useTranslation: () => ({ t: (key: string) => key, i18n: mocks.i18n }),
}));

import { I18nProvider, useI18n } from '../i18n-context';

let api: ReturnType<typeof useI18n>;
function Consumer() {
  api = useI18n();
  return <output data-testid="language">{api.language}</output>;
}

async function mountProvider() {
  await act(async () => { render(<I18nProvider><Consumer /></I18nProvider>); });
}

beforeEach(() => {
  localStorage.clear();
  mocks.getLanguage.mockReset().mockResolvedValue('en');
  mocks.setLanguage.mockReset().mockResolvedValue({ success: true });
  mocks.i18n.language = 'en';
  mocks.i18n.changeLanguage.mockReset().mockImplementation(async (language: string) => { mocks.i18n.language = language; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

describe('language persistence', () => {
  it.each(['rejection', 'false-envelope'])('keeps the visible locale/cache unchanged after native %s', async (failure) => {
    await mountProvider();
    if (failure === 'rejection') mocks.setLanguage.mockRejectedValue(new Error('native save failed'));
    else mocks.setLanguage.mockResolvedValue({ success: false, error: 'native save failed' });

    await act(async () => { await expect(api.setLanguage('de')).rejects.toThrow('native save failed'); });
    expect(screen.getByTestId('language')).toHaveTextContent('en');
    expect(localStorage.getItem('language')).toBe('en');
    expect(mocks.i18n.changeLanguage).not.toHaveBeenCalled();
  });

  it('does not finish the save or update state/cache until translation activation finishes', async () => {
    await mountProvider();
    let finish!: () => void;
    mocks.i18n.changeLanguage.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    let settled = false;
    let saving!: Promise<void>;
    await act(async () => { saving = api.setLanguage('fr').then(() => { settled = true; }); });
    expect(mocks.setLanguage).toHaveBeenCalledWith('fr');
    expect(settled).toBe(false);
    expect(screen.getByTestId('language')).toHaveTextContent('en');
    expect(localStorage.getItem('language')).toBe('en');
    await act(async () => { finish(); await saving; });
    expect(screen.getByTestId('language')).toHaveTextContent('fr');
    expect(localStorage.getItem('language')).toBe('fr');
  });

  it('uses native persistence when cache writes fail and removes a stale startup override', async () => {
    await mountProvider();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    await act(async () => { await expect(api.setLanguage('it')).resolves.toBeUndefined(); });
    expect(mocks.setLanguage).toHaveBeenCalledWith('it');
    expect(screen.getByTestId('language')).toHaveTextContent('it');
    expect(localStorage.getItem('language')).toBeNull();
  });

  it('restores native preference and rejects when translation activation fails', async () => {
    await mountProvider();
    mocks.i18n.changeLanguage.mockRejectedValue(new Error('translation failed'));
    await act(async () => { await expect(api.setLanguage('fr')).rejects.toThrow('translation failed'); });
    expect(mocks.setLanguage.mock.calls.map(([language]) => language)).toEqual(['fr', 'en']);
    expect(screen.getByTestId('language')).toHaveTextContent('en');
    expect(localStorage.getItem('language')).toBe('en');
  });

  it('preserves valid cached-language priority during startup', async () => {
    localStorage.setItem('language', 'el');
    await mountProvider();
    expect(mocks.setLanguage).toHaveBeenCalledWith('el');
    expect(screen.getByTestId('language')).toHaveTextContent('el');
  });

  it('loads the native language when reading browser storage fails', async () => {
    mocks.getLanguage.mockResolvedValue('de');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    await mountProvider();
    expect(screen.getByTestId('language')).toHaveTextContent('de');
    expect(mocks.setLanguage).not.toHaveBeenCalled();
  });
});
