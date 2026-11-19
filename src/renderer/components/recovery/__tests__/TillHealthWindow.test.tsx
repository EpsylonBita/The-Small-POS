import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../../../lib/i18n';
import { TillHealthWindow } from '../TillHealthWindow';
import { buildSyncRecoveryIssues } from '../sync-recovery-issues';
import { buildTillHealthCards, tillHealthReportStatus } from '../till-health-model';
import { CORRECTION_ROW, OFFICIAL_REFUSAL, ORDER_ID, OTHER_ORDER, OTHER_ROW, CHECKED, correctionHealth, fixtures, refusedHealth, refusedRow, tillHealthFixture } from './till-health-fixtures';

const actions = () => ({
  onClose: vi.fn(), onRefresh: vi.fn(), onAskSupport: vi.fn(),
  onCardAction: vi.fn(), onDismissSolved: vi.fn(),
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('Till health window', () => {
  it.each(fixtures.flatMap(state => ['el', 'en'].map(language => ({ state, language }))))('renders $state in $language without technical copy outside support', async ({ state, language }) => {
    await act(async () => { await i18n.changeLanguage(language); });
    const callbacks = actions();
    render(<I18nextProvider i18n={i18n}>
      <TillHealthWindow {...tillHealthFixture(state)} {...callbacks}
        support={<code>{OFFICIAL_REFUSAL} {CORRECTION_ROW} {OTHER_ORDER}</code>} />
    </I18nextProvider>);
    const dialog = screen.getByRole('dialog', { name: i18n.t('tillHealth.title') });
    expect(dialog).toHaveAttribute('data-health-state', state);
    expect(screen.getByRole('heading', { name: i18n.t(`tillHealth.states.${state}.title`) })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: i18n.t('tillHealth.action.recheck') })).toBeVisible();
    expect(within(dialog).getAllByTestId(/^health-service-/)).toHaveLength(6);
    const support = screen.getByRole('button', { name: new RegExp(i18n.t('tillHealth.support.title')) });
    expect(support).toHaveAttribute('aria-expanded', 'false');
    const forbidden = /\b(?:server|sync|queue|conflict|recovery|retry)\b|διακομιστ|συγχρονισ|\bουρ[άα]|σύγκρουσ|ανάκτησ|[A-Z0-9]+(?:_[A-Z0-9]+){2,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu;
    expect(dialog.textContent).not.toMatch(forbidden);
    if (state === 'support') {
      const card = within(dialog).getByTestId('till-health-card');
      expect(within(card).getAllByRole('button')).toHaveLength(1);
      expect(within(card).queryByRole('button', { name: i18n.t('tillHealth.action.saveAgain') })).toBeNull();
      fireEvent.click(within(card).getByRole('button', { name: i18n.t('tillHealth.action.askSupport') }));
      expect(callbacks.onAskSupport).toHaveBeenCalledOnce();
    } else {
      fireEvent.click(support);
    }
    expect(support).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(new RegExp(OFFICIAL_REFUSAL))).toBeVisible();
    const staffView = dialog.cloneNode(true) as Element;
    staffView.querySelector('.till-health-support-content')?.remove();
    expect(staffView.textContent).not.toMatch(forbidden);
  });

  it('uses business-event identity to collapse three collectors and retain two distinct incidents', () => {
    const shared = refusedRow();
    const systemHealth = refusedHealth([shared]);
    const first = buildSyncRecoveryIssues({ systemHealth, lastParitySync: systemHealth.lastParitySync, parityItems: [shared] }).issues;
    expect(first).toHaveLength(1);
    expect(first[0].collectorIssueIds).toEqual(expect.arrayContaining([
      expect.stringContaining('parity-module'), expect.stringContaining('parity-processor'),
    ]));
    const second = refusedRow(CORRECTION_ROW, ORDER_ID);
    const issues = buildSyncRecoveryIssues({ systemHealth: refusedHealth([shared, second]), parityItems: [shared, second] }).issues;
    expect(issues.map(issue => issue.businessEventKey)).toEqual([`parity_sync_queue:${OTHER_ROW}`, `parity_sync_queue:${CORRECTION_ROW}`]);
    const input = { attempts: [], problem: 'ready' as const, printerNeedsAttention: false, canSend: false };
    expect(buildTillHealthCards({ ...input, issues: first })).toHaveLength(1);
    expect(buildTillHealthCards({ ...input, issues })).toHaveLength(2);
  });

  it('puts the known decision before a refusal and puts an explicitly opened order first', () => {
    const issues = buildSyncRecoveryIssues({
      systemHealth: { ...refusedHealth(), orderNotices: correctionHealth.orderNotices }, parityItems: [refusedRow()],
    }).issues;
    const input = { issues, attempts: [], problem: 'ready' as const, printerNeedsAttention: false, canSend: false };
    expect(buildTillHealthCards(input)[0].issue?.orderId).toBe(ORDER_ID);
    const cards = buildTillHealthCards({ ...input, focus: { orderId: OTHER_ORDER } });
    expect(cards[0].issue?.orderId).toBe(OTHER_ORDER);
    render(<TillHealthWindow {...tillHealthFixture('issue')} {...actions()} cards={cards} focusKey={OTHER_ORDER} supportFlowOpen={false} support={<p>{OFFICIAL_REFUSAL}</p>} />);
    expect(screen.getAllByTestId('till-health-card')[0]).toHaveTextContent('#00092');
    expect(screen.queryByText(OFFICIAL_REFUSAL)).not.toBeInTheDocument();
  });

  it.each([
    [{ result: { success: true, bundleStored: true, incidentId: 'receipt' }, at: CHECKED }, 'sent'],
    [{ result: { success: true, bundleStored: true, incidentId: 'receipt' }, at: CHECKED, automatic: true }, 'automatic'],
    [{ result: { success: false, localPrepared: true, path: 'C:/test/report.zip' }, at: CHECKED }, 'local'],
    [{ result: { success: true, bundleStored: true }, at: CHECKED }, 'failed'],
    [{ result: { success: false }, at: CHECKED }, 'failed'],
  ] as const)('checks the receipt before describing the last report as %j', (report, expected) => {
    expect(tillHealthReportStatus(report)).toBe(expected);
  });
});
