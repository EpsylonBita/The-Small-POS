import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportBannerView } from '../SupportBanner';
import { SupportBannerSnapshotSchema } from '../../../hooks/useSupportSession';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { reason?: string }) => `${key}${args?.reason ? `: ${args.reason}` : ''}` }) }));
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('technician evidence on the pill', () => {
  it.each([['till_screenshot', false, 'screenshot'], ['till_logs', true, 'personalData']])('shows the %s action and reason without opening details', (activity, personal, label) => {
    const snapshot = SupportBannerSnapshotSchema.parse({ state: 'executing', activity, personal_data_open: personal, evidence_reason: 'Review the failed order', remaining_ms: 60000 });
    render(<SupportBannerView snapshot={snapshot} onEnd={vi.fn()} onExtend={vi.fn()} />);
    expect(screen.getByTestId('support-evidence-reason')).toHaveTextContent(`support.evidence.${label}: Review the failed order`);
    expect(screen.getByRole('button', { name: 'support.banner.end' })).toBeEnabled();
  });
  it.each(['el', 'en', 'de', 'fr', 'it', 'sq'])('has the same reason placeholders in %s', lang => {
    const locale = JSON.parse(readFileSync(`src/locales/support/${lang}.json`, 'utf8'));
    expect(locale.evidence.screenshot).toContain('{{reason}}');
    expect(locale.evidence.personalData).toContain('{{reason}}');
    expect(locale.evidence.screenshot).not.toMatch(/\?\?\?/);
  });
});

const source = readFileSync('src-tauri/src/support/screenshot_guard.js', 'utf8');
type GuardWindow = Window & { __supportCaptureGuard?: { changed: boolean; observer: MutationObserver } };
function guard() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  return new Function('window', 'document', 'getComputedStyle', 'Element', 'MutationObserver', `return ${source}`)(window, document, getComputedStyle, Element, MutationObserver) as string;
}
describe('actual native screenshot privacy script', () => {
  it.each(['<input type="password" value="1234">', '<div data-support-secret>ABCD-EFGH</div>', '<div data-support-secret><input type="tel" value="1"></div>', '<p>token=your-secret</p>', '<p>4111 1111 1111 1111</p>'])('refuses a secret surface: %s', html => {
    document.body.innerHTML = html;
    expect(guard()).toBe('SCREEN_CONTAINS_SECRETS');
  });
  it('refuses an uninspectable embedded surface', () => {
    document.body.innerHTML = '<iframe></iframe>';
    expect(guard()).toBe('SCREEN_CAPTURE_UNAVAILABLE');
  });
  it('keeps ordinary clock updates captureable', async () => {
    document.body.innerHTML = '<main>12:30</main>';
    expect(guard()).toBe('ready');
    document.querySelector('main')!.textContent = '12:31';
    await Promise.resolve();
    const state = (window as GuardWindow).__supportCaptureGuard!;
    expect(state.changed).toBe(false); state.observer.disconnect();
  });
  it('invalidates pixels even if a secret mounts and disappears between capture callbacks', async () => {
    document.body.innerHTML = '<main>Open orders</main>';
    expect(guard()).toBe('ready');
    const secret = document.createElement('input'); secret.type = 'password';
    document.body.append(secret); secret.remove();
    await Promise.resolve();
    const state = (window as GuardWindow).__supportCaptureGuard!;
    expect(state.changed).toBe(true); state.observer.disconnect();
  });
});
