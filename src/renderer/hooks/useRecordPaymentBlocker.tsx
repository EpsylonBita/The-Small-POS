import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { UnsettledPaymentBlocker } from '../../lib/ipc-contracts';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { formatCurrency } from '../utils/format';
import { extractPrivilegedActionError } from '../utils/privileged-actions';

export type RecordBlockerMethod = 'cash' | 'card';

/** What a "Record cash" / "Record card" tap came to. */
export type RecordPaymentBlockerOutcome =
  | { kind: 'recorded'; result: any }
  | { kind: 'already_recorded'; result: any }
  /** The till refused it (the answer says why); nothing was recorded. */
  | { kind: 'refused'; result: any }
  /** The operator closed the confirmation or the PIN prompt. */
  | { kind: 'cancelled' }
  /** No cashier or manager is checked in on this terminal. */
  | { kind: 'shift_required' }
  | { kind: 'failed'; error: unknown };

type RunWithPrivilegedConfirmation = <T>(request: {
  scope: 'cash_drawer_control';
  action: () => Promise<T>;
  title?: string;
  subtitle?: string;
}) => Promise<T>;

interface UseRecordPaymentBlockerOptions {
  runWithPrivilegedConfirmation: RunWithPrivilegedConfirmation;
  /**
   * The record itself (`reports.resolvePaymentBlocker`), with the amount the
   * operator confirmed. It must send `amountCents`: the till keys the record
   * `z-record:<order>:<cents>` and refuses it if the balance changed.
   */
  record: (
    blocker: UnsettledPaymentBlocker,
    method: RecordBlockerMethod,
    amountCents: number,
  ) => Promise<any>;
  onOutcome: (
    blocker: UnsettledPaymentBlocker,
    method: RecordBlockerMethod,
    outcome: RecordPaymentBlockerOutcome,
  ) => void;
  /** The panel's busy key while one record runs (`<orderId>:<method>`). */
  setBusyKey?: (key: string | null) => void;
  formatMoney?: (amount: number) => string;
}

/** The balance the operator confirms recording, in cents. */
export function blockerRecordAmountCents(blocker: UnsettledPaymentBlocker): number {
  const outstanding = Math.max(
    Number(blocker.totalAmount || 0) - Number(blocker.settledAmount || 0),
    0,
  );
  return Math.round(outstanding * 100);
}

export function recordBlockerBusyKey(
  blocker: Pick<UnsettledPaymentBlocker, 'orderId'>,
  method: RecordBlockerMethod,
): string {
  return `${blocker.orderId}:${method}`;
}

function isShiftRequired(error: unknown): boolean {
  const privileged = extractPrivilegedActionError(error, 'cash_drawer_control');
  if (privileged?.code === 'UNAUTHORIZED' && /shift/i.test(privileged.reason ?? '')) {
    return true;
  }
  return error instanceof Error && /cashier or manager shift required/i.test(error.message);
}

/**
 * "Record cash" / "Record card" on a payment blocker (the Z and the shift
 * checkout): recording money no one collected is a sensitive action, so it
 * is confirmed first, then approved like the desktop's other money actions
 * (a cashier or manager shift on this terminal and a fresh PIN), and the till
 * writes an audit entry naming who recorded it, with `charged: false`. Item
 * F, fix review 30/09/2026; parity with Android's "Record the payment".
 * Nothing is ever charged.
 */
export function useRecordPaymentBlocker({
  runWithPrivilegedConfirmation,
  record,
  onOutcome,
  setBusyKey,
  formatMoney = formatCurrency,
}: UseRecordPaymentBlockerOptions) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{
    blocker: UnsettledPaymentBlocker;
    method: RecordBlockerMethod;
    amountCents: number;
  } | null>(null);
  const runningRef = useRef(false);

  const requestRecord = useCallback(
    (blocker: UnsettledPaymentBlocker, method: RecordBlockerMethod) => {
      if (runningRef.current) return;
      setPending({ blocker, method, amountCents: blockerRecordAmountCents(blocker) });
    },
    [],
  );

  const cancel = useCallback(() => {
    const current = pending;
    setPending(null);
    if (current) onOutcome(current.blocker, current.method, { kind: 'cancelled' });
  }, [onOutcome, pending]);

  const confirm = useCallback(async () => {
    const current = pending;
    setPending(null);
    if (!current || runningRef.current) return;
    const { blocker, method, amountCents } = current;
    runningRef.current = true;
    setBusyKey?.(recordBlockerBusyKey(blocker, method));
    let outcome: RecordPaymentBlockerOutcome;
    try {
      const result = await runWithPrivilegedConfirmation({
        scope: 'cash_drawer_control',
        action: () => record(blocker, method, amountCents),
        title: t('modals.zReport.recordApprovalTitle', {
          defaultValue: 'Approve recording the payment',
        }),
        subtitle: t('modals.zReport.recordApprovalSubtitle', {
          defaultValue: 'Enter the cashier or manager PIN. Nothing is charged.',
        }),
      });
      if (result?.success === false) {
        outcome = { kind: 'refused', result };
      } else if (result?.alreadyRecorded) {
        outcome = { kind: 'already_recorded', result };
      } else {
        outcome = { kind: 'recorded', result };
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Privileged action confirmation cancelled') {
        outcome = { kind: 'cancelled' };
      } else if (isShiftRequired(error)) {
        outcome = { kind: 'shift_required' };
      } else {
        outcome = { kind: 'failed', error };
      }
    } finally {
      runningRef.current = false;
      setBusyKey?.(null);
    }
    onOutcome(blocker, method, outcome);
  }, [onOutcome, pending, record, runWithPrivilegedConfirmation, setBusyKey, t]);

  const methodLabel = (method: RecordBlockerMethod) =>
    t(method === 'cash' ? 'modals.zReport.cash' : 'modals.zReport.card').toLowerCase();

  const confirmDialog = pending ? (
    <ConfirmDialog
      isOpen
      onClose={cancel}
      onConfirm={() => {
        void confirm();
      }}
      variant="warning"
      title={t('modals.zReport.recordConfirmTitle', {
        defaultValue: 'Record this payment?',
      })}
      message={t('modals.zReport.recordConfirmMessage', {
        amount: formatMoney(pending.amountCents / 100),
        method: methodLabel(pending.method),
        order: pending.blocker.orderNumber,
        defaultValue:
          'Record {{amount}} ({{method}}) for order {{order}} only if the customer already paid it. Nothing is charged, and the record keeps your name.',
      })}
      confirmText={t('modals.zReport.recordConfirmAction', { defaultValue: 'Record it' })}
      cancelText={t('common.actions.cancel', { defaultValue: 'Cancel' })}
    />
  ) : null;

  return { requestRecord, confirmDialog };
}

export default useRecordPaymentBlocker;
