import React, { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { emitCompatEvent, getBridge } from '../../lib';
import { useI18n } from '../contexts/i18n-context';
import { TableReleaseOwedModal } from '../components/tables/TableReleaseOwedModal';
import type { RestaurantTable } from '../types/tables';
import { extractPrivilegedActionError } from '../utils/privileged-actions';
import { formatTableDisplayNumber } from '../utils/table-display';
import { isRetryableTableServiceError } from '../utils/tableSessionOfflineQueue';
import {
  cancelRefusalFromSnapshot,
  findCancelRefusals,
  ORDER_HAS_PAYMENTS,
  ORDER_PAYMENT_NOT_RECORDED,
  type OrderCancelRefusalCode,
} from '../utils/orderCancelGuard';

type RunWithPrivilegedConfirmation = <T>(request: {
  scope: 'cash_drawer_control';
  action: (pin?: string) => Promise<T>;
  title?: string;
  subtitle?: string;
}) => Promise<T>;

interface UseTableReleaseGuardOptions {
  runWithPrivilegedConfirmation: RunWithPrivilegedConfirmation;
  /** Open the table's check to collect the payment. */
  onCollect: (table: RestaurantTable) => void;
}

interface PendingRelease {
  table: RestaurantTable;
  orderId: string | null;
  outstandingAmount: number;
  /** Why the till refuses to cancel the order, known before any reason. */
  cancelRefusal: OrderCancelRefusalCode | null;
  release: () => Promise<unknown>;
}

/** Release projections only from the acknowledged whole-order transition. */
export function emitCanonicalTableCancellation(result: unknown, tableId: string, orderId: string, tableSessionId?: string | null) {
  const reply = result as { success?: boolean; data?: { workflow?: { affected_table_ids?: unknown; affected_session_ids?: unknown } } } | null;
  const workflow = reply?.data?.workflow;
  const tableIds = Array.isArray(workflow?.affected_table_ids) ? workflow.affected_table_ids.filter((id): id is string => typeof id === 'string') : [];
  const sessionIds = Array.isArray(workflow?.affected_session_ids) ? workflow.affected_session_ids.filter((id): id is string => typeof id === 'string') : [];
  if (reply?.success !== true || !tableIds.includes(tableId) || (tableSessionId && !sessionIds.includes(tableSessionId))) {
    throw new Error('Canonical cancellation was not acknowledged. Refresh before releasing the table.');
  }
  for (const affectedTableId of tableIds) {
    emitCompatEvent('table-session-settled', {
      tableId: affectedTableId, orderId, tableSessionId: affectedTableId === tableId ? tableSessionId : undefined,
      releaseStatus: 'available', affectedSessionIds: sessionIds,
    });
  }
}

const readMoney = (value: unknown): number => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const errorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
};

type Translate = (key: string, options?: Record<string, unknown>) => unknown;

/** The operator closed the PIN prompt: nothing happened, nothing to say. */
export function isOwingCancelDismissed(error: unknown): boolean {
  return error instanceof Error && error.message === 'Privileged action confirmation cancelled';
}

/**
 * What the operator is told when cancelling an order that owes money did not
 * happen: money was taken on it (void or refund it from the order first, or
 * collect the rest; the same rule as Android), no cashier or manager on
 * shift to approve it, or a plain failure. The table stays as it was.
 */
export function owingCancelFailureMessage(error: unknown, t: Translate): string {
  if (errorText(error).includes('ORIGINAL_CANCEL_APPROVER_REQUIRED')) {
    return String(t('tableCheckManager.errors.originalCancelApproverRequired', {
      defaultValue: 'A cancellation attempt is pending. Its original approving staff member must retry after reconnecting. The table was not released.',
    }));
  }
  if (errorText(error).includes('TABLE_CANCEL_SYNC_REQUIRED') || isRetryableTableServiceError(error)) {
    return String(t('tableCheckManager.errors.canonicalCancelSyncRequired', {
      defaultValue: 'Reconnect and finish syncing or resolve this order’s pending changes before cancelling. The table was not released.',
    }));
  }
  // Founder rule 01/10/2026: a paid label with no payment record here is
  // restored from the server or recorded first, never charged again.
  if (errorText(error).includes(ORDER_PAYMENT_NOT_RECORDED)) {
    return String(
      t('tableRelease.cancelRefusedNotRecorded', {
        defaultValue:
          'This order is marked paid, but its payment is not recorded on this till. Restore it from the server with Sync Now, or record the payment from the Z Report, then cancel.',
      }),
    );
  }
  if (errorText(error).includes(ORDER_HAS_PAYMENTS)) {
    return String(
      t('tableRelease.cancelRefusedPaid', {
        defaultValue:
          'Money was taken on this order. Void or refund it from the order first, or collect the rest.',
      }),
    );
  }
  const privileged = extractPrivilegedActionError(error, 'cash_drawer_control');
  const shiftRequired =
    (privileged?.code === 'UNAUTHORIZED' && /shift/i.test(privileged.reason ?? '')) ||
    /cashier or manager shift required/i.test(errorText(error));
  return String(
    shiftRequired
      ? t('tableRelease.shiftRequired', {
          defaultValue: 'A cashier or manager has to be checked in on this terminal to approve it.',
        })
      : t('tableRelease.cancelFailed', {
          defaultValue: 'The order could not be cancelled. The table was not released.',
        }),
  );
}

/**
 * Asked before the cancel reason (founder rule 30/09 and 01/10/2026: a
 * refusal comes before any reason or PIN): true when the till refuses to
 * cancel the order (money was taken on it, or it is labelled paid with no
 * payment record here), and the operator has been told why. An order whose
 * ledger cannot be read is left to the till, which refuses it again.
 */
export async function refuseOwingCancelUpFront(orderId: string, t: Translate): Promise<boolean> {
  const refusals = await findCancelRefusals([orderId]);
  const code = refusals.notRecorded.length > 0
    ? ORDER_PAYMENT_NOT_RECORDED
    : refusals.hasPayments.length > 0
      ? ORDER_HAS_PAYMENTS
      : null;
  if (!code) return false;
  toast.error(owingCancelFailureMessage(code, t));
  return true;
}

/** What the table's order still owes, from the local ledger when it can be read. */
async function resolveOutstanding(table: RestaurantTable): Promise<{
  orderId: string | null;
  outstandingAmount: number;
  cancelRefusal: OrderCancelRefusalCode | null;
}> {
  const orderId =
    (typeof table.currentOrderId === 'string' && table.currentOrderId.trim()) ||
    (typeof (table as { current_order_id?: unknown }).current_order_id === 'string'
      ? String((table as { current_order_id?: unknown }).current_order_id).trim()
      : '') ||
    null;
  const tableOutstanding = Math.max(
    readMoney(table.unpaidBalance ?? table.balance?.outstanding_balance),
    0,
  );
  if (!orderId) {
    return { orderId: null, outstandingAmount: tableOutstanding, cancelRefusal: null };
  }
  try {
    const snapshot = await getBridge().payments.getSettlementSnapshot(orderId);
    const ledgerOutstanding = Math.max(readMoney(snapshot?.outstandingAmount), 0);
    return {
      orderId,
      outstandingAmount: ledgerOutstanding,
      cancelRefusal: cancelRefusalFromSnapshot(snapshot),
    };
  } catch (error) {
    // The local ledger could not be read: the table's own balance decides,
    // never "nothing owed" by default. The till still refuses a cancel it
    // must refuse.
    console.warn('[useTableReleaseGuard] Reading the order balance failed:', error);
    return { orderId, outstandingAmount: tableOutstanding, cancelRefusal: null };
  }
}

/**
 * Releasing a table (Set available, Cleaned, a reservation released) whose
 * order still owes money (item D1, fix review 30/09/2026). The server frees
 * the table and ends its session but leaves an owing order open; the till
 * used to rely on the server to cancel it, so the order lingered as an orphan
 * across days. Now the operator decides first: collect the payment, cancel
 * the order explicitly (a reason and the manager's approval), or keep it as
 * an open tab. A table whose order owes nothing is released at once.
 */
export function useTableReleaseGuard({
  runWithPrivilegedConfirmation,
  onCollect,
}: UseTableReleaseGuardOptions) {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingRelease | null>(null);
  const [busy, setBusy] = useState(false);
  const checkingRef = useRef(false);

  const guardRelease = useCallback(
    async (table: RestaurantTable, release: () => Promise<unknown>): Promise<void> => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const { orderId, outstandingAmount, cancelRefusal } = await resolveOutstanding(table);
        if (outstandingAmount <= 0.009) {
          await release();
          return;
        }
        setPending({ table, orderId, outstandingAmount, cancelRefusal, release });
      } finally {
        checkingRef.current = false;
      }
    },
    [],
  );

  const close = useCallback(() => {
    if (busy) return;
    setPending(null);
  }, [busy]);

  const collect = useCallback(() => {
    const current = pending;
    setPending(null);
    if (current) onCollect(current.table);
  }, [onCollect, pending]);

  const keepOpenTab = useCallback(async () => {
    const current = pending;
    if (!current) return;
    setBusy(true);
    try {
      // The release says how it went; the order stays open by choice.
      await current.release();
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, [pending]);

  const cancelOrder = useCallback(
    async (reason: string) => {
      const current = pending;
      if (!current?.orderId) return;
      setBusy(true);
      try {
        const result = await runWithPrivilegedConfirmation({
          scope: 'cash_drawer_control',
          action: (managerPin) =>
            getBridge().orders.cancelWithApproval({ orderId: current.orderId as string, reason,
              tableSessionId: current.table.tableSessionId || undefined, managerPin }),
          title: t('tableRelease.cancelApprovalTitle', {
            defaultValue: 'Approve cancelling the order',
          }),
          subtitle: t('tableRelease.cancelApprovalSubtitle', {
            defaultValue: 'Enter the cashier or manager PIN. Nothing is charged.',
          }),
        });
        emitCanonicalTableCancellation(result, current.table.id, current.orderId as string, current.table.tableSessionId);
        toast.success(
          t('tableRelease.orderCancelled', {
            defaultValue: 'Order cancelled and table released.',
          }),
        );
        setPending(null);
      } catch (error) {
        if (isOwingCancelDismissed(error)) {
          return;
        }
        toast.error(owingCancelFailureMessage(error, t));
      } finally {
        setBusy(false);
      }
    },
    [pending, runWithPrivilegedConfirmation, t],
  );

  const modal = pending ? (
    <TableReleaseOwedModal
      isOpen
      tableLabel={formatTableDisplayNumber(pending.table.tableNumber)}
      outstandingAmount={pending.outstandingAmount}
      canCancel={Boolean(pending.orderId)}
      cancelRefusal={pending.cancelRefusal}
      busy={busy}
      onCollect={collect}
      onKeepOpenTab={() => {
        void keepOpenTab();
      }}
      onCancelOrder={(reason) => {
        void cancelOrder(reason);
      }}
      onClose={close}
    />
  ) : null;

  return { guardRelease, modal };
}

export default useTableReleaseGuard;
