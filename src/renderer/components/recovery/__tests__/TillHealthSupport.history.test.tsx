import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryActionLogEntry } from '../../../../lib';
import i18n from '../../../../lib/i18n';
import { TillHealthSupport } from '../TillHealthSupport';

vi.mock('../../../../lib', () => ({ getBridge: () => ({ diagnostics: {} }) }));
vi.mock('../../support/SupportConnectAction', () => ({ SupportConnectAction: () => null }));
vi.mock('../../support/SupportDetailsPanel', () => ({ SupportDetailsPanel: () => null }));
vi.mock('../RecoveryPanel', () => ({ RecoveryPanel: () => null }));
vi.mock('../TableAttemptRecoveryNotice', () => ({ TableAttemptRecoveryNotice: () => null }));

const entry = (over: Partial<RecoveryActionLogEntry>): RecoveryActionLogEntry => ({
  id: 'row', actionId: 'hydrate_food_print_items', issueCode: 'food_order_items_pending', success: true,
  timestamp: '2026-11-23T10:05:12Z', actor: { staffId: null, staffName: null }, targetRefs: {}, ...over,
});

// What the Windows till of Το Μικρό Παρίσι listed on 23/11/2026, as the till now types it.
const ORDER = '0b6f0f6e-6a53-4f6e-9d1c-1f2f6a1e2b11';
const history: RecoveryActionLogEntry[] = [
  entry({ id: 'h3', outcome: 'resolved', timestamp: '2026-11-23T18:40:00Z', message: 'Structured food items recovered', targetRefs: { orderId: ORDER } }),
  entry({ id: 'm1', actionId: 'manual_payment_method_correction', issueCode: 'MANUAL_PAYMENT_METHOD_CORRECTION', timestamp: '2026-11-23T18:00:00Z', actor: { staffId: 's1', staffName: 'Μαρία' } }),
  entry({ id: 'h2', outcome: 'failed', success: false, timestamp: '2026-11-23T17:00:00Z', message: 'Structured food items still unavailable' }),
  entry({ id: 'c1', actionId: 'platform_cash_at_assignment', issueCode: 'platform_cash_at_assignment', timestamp: '2026-11-23T16:00:00Z' }),
  entry({ id: 'h1', outcome: 'resolved', timestamp: '2026-11-23T12:10:00Z', message: 'Structured food items recovered' }),
  entry({ id: 'h0', outcome: 'resolved', timestamp: '2026-11-23T11:00:00Z', message: 'Structured food items recovered' }),
  entry({ id: 'x1', actionId: 'order_header_edit', issueCode: 'ORDER_HEADER_CORRECTION', timestamp: '2026-11-23T09:00:00Z', actor: { staffId: 's2', staffName: null } }),
];

const show = async (language: string, recentActions: RecoveryActionLogEntry[]) => {
  await act(async () => { await i18n.changeLanguage(language); });
  render(<I18nextProvider i18n={i18n}>
    <TillHealthSupport issues={[]} recentActions={recentActions} online stale={false} busy={false}
      supportTools={null} diagnostics={null} previousReports={[]} lastReport={null} sending={false}
      onReport={() => {}} onOpenCopy={() => {}} onIssueAction={() => {}} />
  </I18nextProvider>);
  return screen.getAllByTestId('till-health-history-row');
};

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('Health history in the support section', () => {
  it('tells an automatic repair in plain Greek, folded, with its codes behind the details', async () => {
    const rows = await show('el', history);
    expect(rows.map(row => row.getAttribute('data-history-state')))
      .toEqual(['resolved', 'recorded', 'failed', 'recorded', 'unknown']);

    // Three finished fetches of one day are one row, by the till itself.
    const fetched = within(rows[0]);
    expect(fetched.getByText('Αυτόματα')).toBeVisible();
    expect(fetched.getByText(/Η εκτύπωση 3 παραγγελιών πλατφόρμας περίμενε τα είδη τους/)).toBeVisible();
    expect(fetched.getByText('Ολοκληρώθηκε')).toHaveAttribute('data-health-tone', 'ok');
    expect(rows[0].textContent).not.toContain('Η αποκατάσταση δεν έχει επιβεβαιωθεί');
    expect(rows[0].textContent).not.toContain('Ο υπάλληλος δεν ταυτοποιήθηκε');

    // The codes and the English evidence exist, closed, one line per fetch.
    const code = fetched.getAllByText(/hydrate_food_print_items/);
    expect(code).toHaveLength(3);
    code.forEach(line => expect(line).not.toBeVisible());
    expect(code[0].textContent).toContain('food_order_items_pending');
    expect(code[0].textContent).toContain('Structured food items recovered');
    expect(code[0].textContent).toContain(ORDER);
    const details = rows[0].querySelector('details') as HTMLDetailsElement;
    expect(within(details).getByText('Στοιχεία για την υποστήριξη')).toBeVisible();
    act(() => { details.open = true; });
    code.forEach(line => expect(line).toBeVisible());

    // A person's action names the person and reads as recorded, not unconfirmed.
    expect(within(rows[1]).getByText('Μαρία')).toBeVisible();
    expect(within(rows[1]).getByText(/Άλλαξε ο τρόπος πληρωμής σε μια πληρωμή/)).toBeVisible();
    expect(within(rows[1]).getByText('Καταγράφηκε')).toBeVisible();

    // A fetch that did not get the items stays its own row and says what to do.
    expect(within(rows[2]).getByText('Αυτόματα')).toBeVisible();
    expect(within(rows[2]).getByText(/άργησαν να φτάσουν στο ταμείο/)).toBeVisible();
    expect(within(rows[2]).getByText('Δεν ολοκληρώθηκε')).toHaveAttribute('data-health-tone', 'bad');

    expect(within(rows[3]).getByText('Αυτόματα')).toBeVisible();
    expect(within(rows[3]).getByText(/Το ταμείο κατέγραψε τα μετρητά στη βάρδια του/)).toBeVisible();

    // An unlisted row with a staff id and no name keeps the careful wording, without its raw id.
    expect(within(rows[4]).getByText('Ο υπάλληλος δεν ταυτοποιήθηκε')).toBeVisible();
    expect(within(rows[4]).getByText(/Άλλη ενέργεια στο ταμείο/)).toBeVisible();
    expect(within(rows[4]).getByText('Δεν επιβεβαιώθηκε')).toHaveAttribute('data-health-tone', 'warn');
    expect(within(rows[4]).getByText(/order_header_edit/)).not.toBeVisible();

    // Outside the closed details no row shows a code, an id or the English evidence.
    for (const row of rows) {
      const staffView = row.cloneNode(true) as Element;
      staffView.querySelectorAll('details').forEach(details => details.remove());
      expect(staffView.textContent).not.toMatch(/[A-Za-z0-9]+_[A-Za-z0-9_]+|[0-9a-f]{8}-[0-9a-f]{4}|Structured|hydration/);
    }
  });

  it.each(['el', 'en', 'de', 'fr', 'it', 'sq'])('renders every state of the automatic fetch in %s', async language => {
    const rows = await show(language, (['resolved', 'pending', 'failed', 'unknown'] as const).map((outcome, index) =>
      entry({ id: outcome, outcome, success: outcome === 'resolved', timestamp: `2026-11-2${index}T10:00:00Z` })));
    expect(rows).toHaveLength(4);
    rows.forEach((row, index) => {
      const outcome = (['resolved', 'pending', 'failed', 'unknown'] as const)[index];
      const key = `tillHealth.history.kinds.orderItems.${outcome}`;
      const sentence = i18n.t(key, { count: 1 });
      expect(sentence).not.toBe(key);
      expect(within(row).getByText(new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();
      expect(within(row).getByText(i18n.t(`tillHealth.history.state.${outcome}`))).toBeVisible();
      expect(within(row).getByText(i18n.t('tillHealth.support.automaticActor'))).toBeVisible();
    });
  });

  it('keeps the existing label of an operator action and the empty state', async () => {
    const rows = await show('en', [entry({ id: 'op', actionId: 'retryParityItem', issueCode: 'parity_item_failed', outcome: 'unknown', success: true })]);
    expect(within(rows[0]).getByText(new RegExp(i18n.t('recovery.actions.retryParityItem.label')))).toBeVisible();
    expect(within(rows[0]).getByText(i18n.t('tillHealth.support.unknownActor'))).toBeVisible();
    cleanup();
    await act(async () => { await i18n.changeLanguage('en'); });
    render(<I18nextProvider i18n={i18n}>
      <TillHealthSupport issues={[]} recentActions={[]} online stale={false} busy={false}
        supportTools={null} diagnostics={null} previousReports={[]} lastReport={null} sending={false}
        onReport={() => {}} onOpenCopy={() => {}} onIssueAction={() => {}} />
    </I18nextProvider>);
    expect(screen.queryAllByTestId('till-health-history-row')).toHaveLength(0);
    expect(screen.getByText(i18n.t('recovery.center.noRecentActions'))).toBeVisible();
  });
});
