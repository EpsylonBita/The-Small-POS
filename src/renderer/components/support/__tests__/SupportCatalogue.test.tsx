import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportOnsiteSheet, TierThreeOnsiteRequestSchema } from '../SupportOnsiteSheet';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: vi.fn() }) }));
vi.mock('../../../hooks/useSupportSession', () => ({ useSupportSession: () => null }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: vi.fn(), confirmationModal: null }) }));
const request = { request_id: 'your-request', session_id: 'your-session', title: 'support.onsite.title', description: '',
  needs_staff_pin: false, remaining_ms: 300000, catalogue: { action: 'cancel_one_uncertain_job', printer_name: '<b>Your printer</b>' } };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each(['light', 'dark'])('shows native catalogue facts safely with touch controls in %s', theme => {
  document.documentElement.className = theme;
  const decide = vi.fn();
  render(<SupportOnsiteSheet request={TierThreeOnsiteRequestSchema.parse(request)} deferred={false} canConfirm onShown={vi.fn()} onDecision={decide} />);
  expect(screen.getByTestId('support-catalogue-facts')).toBeVisible();
  expect(screen.getByText('<b>Your printer</b>')).toBeVisible();
  expect(screen.getByText('support.onsite.catalogueCancel')).toBeVisible();
  expect(screen.getByText('support.onsite.catalogueCancelScope')).toBeVisible();
  expect(screen.getByText('support.onsite.cataloguePaperWarning')).toBeVisible();
  expect(screen.getByTestId('support-catalogue-facts').querySelector('b')).toBeNull();
  const run = screen.getByText('support.onsite.execute'); expect(run).toBeDisabled();
  act(() => vi.advanceTimersByTime(2000)); fireEvent.click(run); expect(decide).toHaveBeenCalledWith('confirmed');
});
it('rejects unknown actions and mixed native request branches', () => {
  expect(TierThreeOnsiteRequestSchema.safeParse({ ...request, catalogue: { ...request.catalogue, action: 'purge' } }).success).toBe(false);
  expect(TierThreeOnsiteRequestSchema.safeParse({ ...request, terminal_command: { text: 'x', sha256: 'a'.repeat(64) } }).success).toBe(false);
});
it.each(['el', 'en', 'de', 'fr', 'it', 'sq'])('%s has catalogue warnings identical in both apps', locale => {
  const desktop = JSON.parse(readFileSync(`src/locales/support/${locale}.json`, 'utf8'));
  const mobile = JSON.parse(readFileSync(`../POSSystemMobile/src/locales/support/${locale}.json`, 'utf8'));
  for (const key of ['cataloguePause', 'catalogueResume', 'catalogueCancel', 'cataloguePauseScope', 'catalogueCancelScope', 'cataloguePaperWarning', 'catalogueResumeCheck']) {
    expect(desktop.onsite[key]).toEqual(expect.any(String));
    expect(desktop.onsite[key]).not.toMatch(/\uFFFD|\?{2,}/);
    expect(mobile.onsite[key]).toBe(desktop.onsite[key]);
  }
});
