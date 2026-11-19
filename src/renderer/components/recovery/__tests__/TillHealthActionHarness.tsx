import React, { useState } from 'react';
import type { RecoveryActionLogEntry, RecoveryIssue } from '../../../../lib';
import { HEALTHY_TEST_SERVICES, CHECKED } from './till-health-fixtures';
import { buildTillHealthCards, tillHealthState, type TillHealthReport } from '../till-health-model';
import { TillHealthConfirmation, TillHealthSupport } from '../TillHealthSupport';
import { TillHealthWindow } from '../TillHealthWindow';
import { useTillHealthActions } from '../useTillHealthActions';

export function TillHealthActionHarness({
  issues, diagnosticsStale = false, onNavigate = () => {}, onRefresh, recentActions,
}: {
  issues: RecoveryIssue[];
  recentActions: RecoveryActionLogEntry[];
  diagnosticsStale?: boolean;
  onRefresh: () => Promise<unknown>;
  onNavigate?: () => void;
}) {
  const [lastReport, setReport] = useState<TillHealthReport | null>(null);
  const [recorded, setRecorded] = useState<RecoveryActionLogEntry[]>([]);
  const entries = React.useMemo(() => [...recorded, ...recentActions], [recorded, recentActions]);
  const actions = useTillHealthActions({
    recentActions: entries, diagnosticsStale, onRefresh, onNavigate,
    onActionResolved: entry => setRecorded(current => [entry, ...current]),
    onReport: result => setReport({ result, at: CHECKED }),
  });
  const availability = diagnosticsStale ? 'stale' : 'ready';
  const cards = buildTillHealthCards({ issues, attempts: actions.attempts, problem: 'ready', printerNeedsAttention: false, canSend: false });
  return <TillHealthWindow id="action-harness" state={tillHealthState({ cards, availability, online: true, supportUnavailable: false })}
    availability={availability} cards={cards} services={HEALTHY_TEST_SERVICES} isShiftActive online
    lastChecked={CHECKED} dayStart={null} busy={actions.busy} canAskSupport
    supportUnavailable={false} supportFlowOpen onClose={onNavigate} onRefresh={() => void onRefresh()} onAskSupport={() => {}}
    onCardAction={(card, action) => { if (card.issue && action) actions.handleActionClick(card.issue, action); }}
    onDismissSolved={card => { if (card.issue) actions.dismissAttempt(card.issue.id); }}
    overlays={<TillHealthConfirmation confirmation={actions.confirmingAction} busy={actions.busy}
      onClose={() => actions.setConfirmingAction(null)} onConfirm={actions.handleConfirmDestructiveAction} />}
    support={<TillHealthSupport lastReport={lastReport} online stale={diagnosticsStale} busy={actions.busy}
      issues={issues} recentActions={[]} supportTools={null} diagnostics={null} previousReports={[]} sending={false}
      onOpenCopy={() => {}} onIssueAction={actions.handleActionClick}
      onReport={(issue, action) => { if (issue && action) actions.handleActionClick(issue, action); }} />} />;
}
