import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportConsentScreen } from '../SupportConsentScreen';
import type { ConsentFetchRes } from '../../../../../../shared/pos/support/consent';
import type { SupportActor } from '../../../hooks/useSupportSession';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { name?: string }) => options?.name === undefined ? key : `${key}=${options.name}`,
}) }));
const text: NonNullable<ConsentFetchRes['text']> = {
  text_id: '50000000-0000-4000-a000-000000000005', version: 'v1', locale: 'el',
  body: 'Published consent text', body_sha256: 'a'.repeat(64),
};
const consent: ConsentFetchRes = { state: 'missing', text, accepting_base_roles: ['owner', 'admin', 'manager', 'cashier'] };
const person = (base_role: string, name = 'Μαρία'): SupportActor => ({ staff_id: '88888888-8888-4888-8888-888888888888', name, base_role });
afterEach(cleanup);

describe.each(['light', 'dark'])('support consent in %s theme', (theme) => {
  it.each(['missing', 'outdated', 'withdrawn', 'text_unavailable'] as const)('explains %s and exposes named controls', (state) => {
    document.documentElement.className = theme;
    render(<SupportConsentScreen consent={{ ...consent, state, text: state === 'text_unavailable' ? null : text }}
      actor={person('admin')} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'support.consent.title' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'support.consent.decline' })).toBeVisible();
    expect(screen.getByText(`support.consent.${({ missing: 'required', outdated: 'outdated', withdrawn: 'withdrawn', text_unavailable: 'textUnavailable' })[state]}`)).toBeVisible();
    if (!text || state === 'text_unavailable') {
      expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
    }
  });

  it('requires the full text to be displayed, and resets that gate for a new version', () => {
    const onAccept = vi.fn();
    const props = { consent, actor: person('admin'), busy: false, onAccept, onDecline: vi.fn() };
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

  it('shows the accepting-roles and store-admin guidance to a waiter', () => {
    render(<SupportConsentScreen consent={consent} actor={person('waiter')} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText('support.consent.onlyOwnerAdmin')).toBeVisible();
    expect(screen.getByText('support.consent.storeAdminAlternative')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
  });

  it('refuses everyone when native named no acting person', () => {
    render(<SupportConsentScreen consent={consent} actor={null} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
    expect(screen.queryByTestId('support-consent-actor')).toBeNull();
    expect(screen.getByText('support.consent.onlyOwnerAdmin')).toBeVisible();
  });

  it.each(['cashier', 'manager'])('offers «Συμφωνώ» to a %s because the server lists the role', (role) => {
    render(<SupportConsentScreen consent={consent} actor={person(role)} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'support.consent.agree' })).toBeVisible();
    expect(screen.queryByText('support.consent.onlyOwnerAdmin')).toBeNull();
  });

  it('offers «Συμφωνώ» to a waiter who also holds a listed role, as the server accepts any of them', () => {
    render(<SupportConsentScreen consent={consent} actor={{ ...person('waiter'), base_roles: ['waiter', 'cashier'] }} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'support.consent.agree' })).toBeVisible();
    expect(screen.queryByText('support.consent.onlyOwnerAdmin')).toBeNull();
  });

  it('refuses a waiter whose roles are all unlisted', () => {
    render(<SupportConsentScreen consent={consent} actor={{ ...person('waiter'), base_roles: ['waiter', 'driver'] }} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
    expect(screen.getByText('support.consent.onlyOwnerAdmin')).toBeVisible();
  });

  it('follows only the server list: a cashier is refused when the server does not list the role', () => {
    render(<SupportConsentScreen consent={{ ...consent, accepting_base_roles: ['owner', 'admin'] }} actor={person('cashier')} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'support.consent.agree' })).toBeNull();
    expect(screen.getByText('support.consent.onlyOwnerAdmin')).toBeVisible();
  });

  it('names the acting person as given, and falls back to the role for an empty name', () => {
    const { rerender } = render(<SupportConsentScreen consent={consent} actor={person('cashier')} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByTestId('support-consent-actor')).toHaveTextContent('support.consent.acceptingAs=Μαρία');
    expect(screen.getByTestId('support-consent-actor').tagName).toBe('P');
    rerender(<SupportConsentScreen consent={consent} actor={person('cashier', '  ')} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByTestId('support-consent-actor')).toHaveTextContent('support.consent.acceptingAs=cashier');
  });

  it('lets a refused person hand over to someone else on shift with one tap', () => {
    const onChangeActor = vi.fn();
    render(<SupportConsentScreen consent={consent} actor={person('waiter')} busy={false} onAccept={vi.fn()} onDecline={vi.fn()} onChangeActor={onChangeActor} />);
    const change = screen.getByRole('button', { name: 'support.consent.acceptingAs=Μαρία' });
    expect(change.className).toContain('min-h-[48px]');
    fireEvent.click(change);
    expect(onChangeActor).toHaveBeenCalledOnce();
  });
});
