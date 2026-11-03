import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportConsentScreen } from '../SupportConsentScreen';
import type { ConsentFetchRes } from '../../../../../../shared/pos/support/consent';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const text: NonNullable<ConsentFetchRes['text']> = {
  text_id: '50000000-0000-4000-a000-000000000005', version: 'v1', locale: 'el',
  body: 'Published consent text', body_sha256: 'a'.repeat(64),
};
const consent: ConsentFetchRes = { state: 'missing', text, accepting_base_roles: ['owner', 'admin'] };
afterEach(cleanup);

describe.each(['light', 'dark'])('support consent in %s theme', (theme) => {
  it.each(['missing', 'outdated', 'withdrawn', 'text_unavailable'] as const)('explains %s and exposes named controls', (state) => {
    document.documentElement.className = theme;
    render(<SupportConsentScreen consent={{ ...consent, state, text: state === 'text_unavailable' ? null : text }}
      staffRole="admin" busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'support.consent.title' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'support.consent.decline' })).toBeVisible();
    expect(screen.getByText(`support.consent.${({ missing: 'required', outdated: 'outdated', withdrawn: 'withdrawn', text_unavailable: 'textUnavailable' })[state]}`)).toBeVisible();
    if (!text || state === 'text_unavailable') {
      expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
    }
  });

  it('requires the full text to be displayed, and resets that gate for a new version', () => {
    const onAccept = vi.fn();
    const props = { consent, staffRole: 'admin', busy: false, onAccept, onDecline: vi.fn() };
    const { rerender } = render(<SupportConsentScreen {...props} />);
    const body = screen.getByTestId('support-consent-text');
    Object.defineProperties(body, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    fireEvent.scroll(body, { target: { scrollTop: 0 } });
    expect(screen.getByRole('button', { name: 'support.consent.agree' })).toBeDisabled();
    fireEvent.scroll(body, { target: { scrollTop: 800 } });
    fireEvent.click(screen.getByRole('button', { name: 'support.consent.agree' }));
    expect(onAccept).toHaveBeenCalledWith(text);
    rerender(<SupportConsentScreen {...props} consent={{ ...consent, state: 'outdated', text: { ...text, version: 'v2' } }} />);
    expect(screen.getByRole('button', { name: 'support.consent.agree' })).toBeDisabled();
  });

  it('shows owner/admin and store-admin guidance to a cashier', () => {
    render(<SupportConsentScreen consent={consent} staffRole="cashier" busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText('support.consent.onlyOwnerAdmin')).toBeVisible();
    expect(screen.getByText('support.consent.storeAdminAlternative')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
  });
});
