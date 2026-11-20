import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { foodDeliveryPlatform } from '../../../../shared/platforms/order-cancellation';
import { getBridge } from '../../lib';
import OrderCancellationModal from '../components/modals/OrderCancellationModal';
import { releaseRefusedTableCancellation } from '../services/TableManualCancellation';
import { isPlatformDriverCashAutoEnabled } from '../utils/orderCancelGuard';
import { usePrivilegedActionConfirmation } from './usePrivilegedActionConfirmation';
import { useTerminalSettings } from './useTerminalSettings';
import {
  prepareManualOrderCancellation, applyPreparedOrderCancellation,
  manualCancellationFailureKey, manualCancellationFailureOptions, type ManualCancellationPlan,
} from '../services/ManualOrderCancellation';

/** History has the same return/cancel modal and native commit as the dashboard.
 * Only an explicit provider-original refusal falls back to ordinary refund. */
export function useReturnedOrderCancellation(onCancelled: () => void | Promise<void>, order?: unknown) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { getSetting, error: terminalSettingsError } = useTerminalSettings();
  const [plan, setPlan] = useState<(ManualCancellationPlan & { platform: string | null }) | null>(null);
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  const requestCancellation = async (orderId: string): Promise<boolean> => {
    const platformCashAuto = !terminalSettingsError
      && isPlatformDriverCashAutoEnabled(getSetting('terminal', 'enabled_features'));
    try {
      const prepared = await prepareManualOrderCancellation(bridge, orderId);
      const platform = platformCashAuto && prepared.requiresReturn ? foodDeliveryPlatform(order) : null;
      setPlan({ ...prepared, platform });
      return true;
    } catch (error) {
      if (String(error).includes('ORIGINAL_PROVIDER_RETURN_REQUIRED')) return false;
      throw error;
    }
  };
  const modal = <>
    <OrderCancellationModal isOpen={plan !== null} orderCount={1}
      platformOrder={Boolean(plan?.platform && plan.platform !== 'box')}
      boxLocalCancellation={plan?.platform === 'box'}
      manualReturn={plan?.requiresReturn ? { amountCents: plan.amountCents, currency: plan.currency } : undefined}
      recovery={plan?.pending ? { reason: plan.reason || '', returnChannel: plan.returnChannel } : undefined}
      savedAttempt={plan?.pending && plan.tableSessionId ? { refused: Boolean(plan.refused), onRelease: async () => {
        try {
          await runWithPrivilegedConfirmation({ scope: 'cash_drawer_control',
            action: pin => releaseRefusedTableCancellation({ ...plan, tableSessionId: plan.tableSessionId! }, pin),
            title: t('tableRelease.clearAttemptTitle'), subtitle: t('tableRelease.clearAttemptSubtitle'),
          });
          setPlan(null);
          toast.success(t('modals.orderCancellation.attemptCleared'));
          await onCancelled();
        } catch (error) {
          if (error instanceof Error && error.message === 'Privileged action confirmation cancelled') return;
          toast.error(t(manualCancellationFailureKey(error), manualCancellationFailureOptions(error)));
        }
      } } : undefined}
      onClose={() => setPlan(null)}
      onConfirmCancel={async (reason, channel) => {
        if (!plan || (plan.requiresReturn && !channel)) return;
        try {
          await runWithPrivilegedConfirmation({ scope: 'cash_drawer_control',
            action: pin => applyPreparedOrderCancellation(bridge, plan, reason.trim(), channel || 'cash_drawer', pin),
            title: t('modals.orderCancellation.managerApprovalTitle'),
            approvalSubtitle: t('modals.orderCancellation.managerApprovalSubtitle'),
          });
          setPlan(null);
          toast.success(t('orderDashboard.ordersCancelled', { count: 1 }));
          await onCancelled();
        } catch (error) {
          if (error instanceof Error && error.message === 'Privileged action confirmation cancelled') return;
          toast.error(t(manualCancellationFailureKey(error), manualCancellationFailureOptions(error)));
        }
      }} />
    {confirmationModal}
  </>;
  return { requestCancellation, modal };
}
