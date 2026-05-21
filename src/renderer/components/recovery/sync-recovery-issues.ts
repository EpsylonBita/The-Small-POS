import type {
  DiagnosticsLastParitySync,
  DiagnosticsSystemHealth,
  RecoveryActionDescriptor,
  RecoveryKnownSolution,
  RecoveryIssue,
  SyncFinancialIntegrityIssue,
  SyncFinancialIntegrityResponse,
  SyncFinancialQueueItem,
  UnsettledPaymentBlocker,
} from '../../../lib';
import type { SyncQueueItem } from '../../../../../shared/pos/sync-queue-types';

interface BuildSyncRecoveryIssuesInput {
  systemHealth: DiagnosticsSystemHealth | null;
  lastParitySync?: DiagnosticsLastParitySync | null;
  parityItems?: SyncQueueItem[];
  financialItems?: SyncFinancialQueueItem[];
  integrity?: SyncFinancialIntegrityResponse | null;
}

export interface BuildSyncRecoveryIssuesResult {
  issues: RecoveryIssue[];
  counts: {
    blocking: number;
    recovering: number;
    total: number;
  };
}

const MODULE_LABELS: Record<string, string> = {
  orders: 'Orders',
  customers: 'Customers',
  shifts: 'Shifts',
  financial: 'Financial',
  z_report: 'Z-report',
  loyalty: 'Loyalty',
};

const LEGACY_FINANCIAL_PARITY_TABLES = new Set(['payments', 'payment_adjustments']);
const WAITING_PARENT_BLOCKING_AGE_MS = 10 * 60 * 1000;

interface RecoveryRecipeDefinition extends RecoveryKnownSolution {
  actionId: string;
}

const RECOVERY_RECIPES = {
  checkoutPaymentOpenPayment: {
    recipeId: 'checkout-payment-blocker.open-payment',
    version: 1,
    actionId: 'openOrderPaymentFix',
    labelKey: 'recovery.recipes.checkoutPaymentOpenPayment.label',
    explanationKey: 'recovery.recipes.checkoutPaymentOpenPayment.explanation',
    verificationKey: 'recovery.recipes.checkoutPaymentOpenPayment.verification',
    requiresSnapshot: false,
  },
  paymentTotalConflictRepair: {
    recipeId: 'payment-total-conflict.repair',
    version: 1,
    actionId: 'repairPaymentTotalConflict',
    labelKey: 'recovery.recipes.paymentTotalConflictRepair.label',
    explanationKey: 'recovery.recipes.paymentTotalConflictRepair.explanation',
    verificationKey: 'recovery.recipes.paymentTotalConflictRepair.verification',
    requiresSnapshot: true,
  },
  invalidDriverOrderUpdateRepair: {
    recipeId: 'invalid-driver-order-update.repair',
    version: 1,
    actionId: 'repairInvalidDriverOrderUpdate',
    labelKey: 'recovery.recipes.invalidDriverOrderUpdateRepair.label',
    explanationKey: 'recovery.recipes.invalidDriverOrderUpdateRepair.explanation',
    verificationKey: 'recovery.recipes.invalidDriverOrderUpdateRepair.verification',
    requiresSnapshot: true,
  },
  orderUpdateReplayRepair: {
    recipeId: 'order-update-replay-blockers.repair',
    version: 1,
    actionId: 'repairOrderUpdateReplayBlockers',
    labelKey: 'recovery.recipes.orderUpdateReplayRepair.label',
    explanationKey: 'recovery.recipes.orderUpdateReplayRepair.explanation',
    verificationKey: 'recovery.recipes.orderUpdateReplayRepair.verification',
    requiresSnapshot: true,
  },
  catalogAvailabilityRetry: {
    recipeId: 'catalog-availability.retry',
    version: 1,
    actionId: 'retryParityItem',
    labelKey: 'recovery.recipes.catalogAvailabilityRetry.label',
    explanationKey: 'recovery.recipes.catalogAvailabilityRetry.explanation',
    verificationKey: 'recovery.recipes.catalogAvailabilityRetry.verification',
    requiresSnapshot: false,
  },
} as const satisfies Record<string, RecoveryRecipeDefinition>;

const knownSolutionFromRecipe = (
  recipe: RecoveryRecipeDefinition,
): RecoveryKnownSolution => ({
  recipeId: recipe.recipeId,
  version: recipe.version,
  labelKey: recipe.labelKey,
  explanationKey: recipe.explanationKey,
  verificationKey: recipe.verificationKey,
  requiresSnapshot: recipe.requiresSnapshot,
});

const withRecipe = <T extends RecoveryActionDescriptor>(
  action: T,
  recipe: RecoveryRecipeDefinition,
): T => ({
  ...action,
  recommended: true,
  descriptionKey: action.descriptionKey ?? recipe.explanationKey,
  recipeId: recipe.recipeId,
  recipeVersion: recipe.version,
  requiresSnapshot: recipe.requiresSnapshot,
});

const withKnownSolution = <T extends RecoveryIssue>(
  issue: T,
  recipe: RecoveryRecipeDefinition,
): T => ({
  ...issue,
  knownSolution: knownSolutionFromRecipe(recipe),
  actions: issue.actions.map((action) =>
    action.id === recipe.actionId ? withRecipe(action, recipe) : action,
  ),
});

const createAction = (
  id: string,
  labelKey: string,
  options: Partial<RecoveryActionDescriptor> = {},
): RecoveryActionDescriptor => ({
  id,
  labelKey,
  descriptionKey: options.descriptionKey,
  recommended: options.recommended ?? false,
  safetyLevel: options.safetyLevel ?? 'safe',
  requiresOnline: options.requiresOnline ?? false,
  requiresSnapshot: options.requiresSnapshot ?? false,
  recipeId: options.recipeId,
  recipeVersion: options.recipeVersion,
  confirmationRequired: options.confirmationRequired ?? false,
  confirmTitleKey: options.confirmTitleKey,
  confirmMessageKey: options.confirmMessageKey,
  confirmCheckboxKey: options.confirmCheckboxKey,
  routeTarget: options.routeTarget ?? null,
});

const createContactDevAction = (): RecoveryActionDescriptor =>
  createAction('contactDev', 'recovery.actions.contactDev.label', {
    descriptionKey: 'recovery.actions.contactDev.description',
  });

const createOpenConnectionSettingsAction = (): RecoveryActionDescriptor =>
  createAction('openConnectionSettings', 'recovery.actions.openConnectionSettings.label', {
    routeTarget: { screen: 'connectionSettings' },
  });

const createRunParitySyncAction = (): RecoveryActionDescriptor =>
  createAction('runParitySyncNow', 'recovery.actions.runParitySyncNow.label', {
    requiresOnline: true,
  });

const createRetryParityItemAction = (): RecoveryActionDescriptor =>
  createAction('retryParityItem', 'recovery.actions.retryParityItem.label');

const createRetryCatalogAvailabilityAction = (): RecoveryActionDescriptor =>
  createAction('retryParityItem', 'recovery.actions.retryCatalogAvailabilitySync.label', {
    descriptionKey: 'recovery.actions.retryCatalogAvailabilitySync.description',
    recommended: true,
    requiresOnline: true,
  });

const createRetryParityModuleAction = (): RecoveryActionDescriptor =>
  createAction('retryParityModule', 'recovery.actions.retryParityModule.label');

const createRepairPaymentTotalConflictAction = (): RecoveryActionDescriptor =>
  withRecipe(
    createAction(
      'repairPaymentTotalConflict',
      'recovery.actions.repairPaymentTotalConflict.label',
      {
        descriptionKey: 'recovery.actions.repairPaymentTotalConflict.description',
        recommended: true,
        requiresOnline: true,
        requiresSnapshot: true,
      },
    ),
    RECOVERY_RECIPES.paymentTotalConflictRepair,
  );

const createRepairInvalidDriverOrderUpdateAction = (): RecoveryActionDescriptor =>
  withRecipe(
    createAction(
      'repairInvalidDriverOrderUpdate',
      'recovery.actions.repairInvalidDriverOrderUpdate.label',
      {
        descriptionKey: 'recovery.actions.repairInvalidDriverOrderUpdate.description',
        recommended: true,
        requiresOnline: true,
        requiresSnapshot: true,
      },
    ),
    RECOVERY_RECIPES.invalidDriverOrderUpdateRepair,
  );

const createRepairOrderUpdateReplayBlockersAction = (): RecoveryActionDescriptor =>
  withRecipe(
    createAction(
      'repairOrderUpdateReplayBlockers',
      'recovery.actions.repairOrderUpdateReplayBlockers.label',
      {
        descriptionKey: 'recovery.actions.repairOrderUpdateReplayBlockers.description',
        recommended: true,
        requiresOnline: true,
        requiresSnapshot: true,
        confirmationRequired: true,
        confirmTitleKey: 'recovery.actions.repairOrderUpdateReplayBlockers.confirmTitle',
        confirmMessageKey: 'recovery.actions.repairOrderUpdateReplayBlockers.confirmMessage',
      },
    ),
    RECOVERY_RECIPES.orderUpdateReplayRepair,
  );

const createRetrySyncAction = (): RecoveryActionDescriptor =>
  createAction('retrySync', 'recovery.actions.retrySync.label');

const createValidatePendingOrdersAction = (): RecoveryActionDescriptor =>
  createAction('validatePendingOrders', 'recovery.actions.validatePendingOrders.label');

const createRemoveInvalidOrdersAction = (): RecoveryActionDescriptor =>
  createAction('removeInvalidOrders', 'recovery.actions.removeInvalidOrders.label', {
    safetyLevel: 'destructive_local',
    confirmationRequired: true,
    confirmTitleKey: 'recovery.actions.removeInvalidOrders.confirmTitle',
    confirmMessageKey: 'recovery.actions.removeInvalidOrders.confirmMessage',
  });

const createRetryFinancialItemAction = (): RecoveryActionDescriptor =>
  createAction('retryFinancialItem', 'recovery.actions.retryFinancialItem.label');

const createRetryAllFailedFinancialAction = (): RecoveryActionDescriptor =>
  createAction('retryAllFailedFinancial', 'recovery.actions.retryAllFailedFinancial.label');

const createOpenOrderPaymentFixAction = (
  blocker: UnsettledPaymentBlocker,
  method: 'cash' | 'card' | null,
): RecoveryActionDescriptor =>
  withRecipe(
    createAction(
      'openOrderPaymentFix',
      'recovery.actions.openOrderPaymentFix.label',
      {
        descriptionKey: 'recovery.actions.openOrderPaymentFix.description',
        recommended: true,
        routeTarget: {
          screen: 'orderPayment',
          orderId: blocker.orderId,
          orderNumber: blocker.orderNumber,
          params: {
            openPayment: true,
            reasonCode: blocker.reasonCode,
            paymentMethod: method ?? blocker.paymentMethod ?? null,
          },
        },
      },
    ),
    RECOVERY_RECIPES.checkoutPaymentOpenPayment,
  );

const createRepairOrphanedFinancialAction = (): RecoveryActionDescriptor =>
  createAction('repairOrphanedFinancial', 'recovery.actions.repairOrphanedFinancial.label', {
    requiresOnline: true,
  });

const createRepairWaitingParentPaymentsAction = (): RecoveryActionDescriptor =>
  createAction(
    'repairWaitingParentPayments',
    'recovery.actions.repairWaitingParentPayments.label',
  );

const createRepairWaitingParentAdjustmentsAction = (): RecoveryActionDescriptor =>
  createAction(
    'repairWaitingParentAdjustments',
    'recovery.actions.repairWaitingParentAdjustments.label',
  );

const createClearLegacyFinancialOrphanAction = (): RecoveryActionDescriptor =>
  createAction(
    'clearLegacyFinancialOrphan',
    'recovery.actions.clearLegacyFinancialOrphan.label',
    {
      safetyLevel: 'destructive_local',
      confirmationRequired: true,
      confirmTitleKey: 'recovery.actions.clearLegacyFinancialOrphan.confirmTitle',
      confirmMessageKey: 'recovery.actions.clearLegacyFinancialOrphan.confirmMessage',
      confirmCheckboxKey: 'recovery.actions.clearLegacyFinancialOrphan.confirmCheckbox',
    },
  );

const createRequeueFailedFinancialShiftRowsAction = (): RecoveryActionDescriptor =>
  createAction(
    'requeueFailedFinancialShiftRows',
    'recovery.actions.requeueFailedFinancialShiftRows.label',
  );

const createRequeueFailedAdjustmentMissingEndpointRowsAction =
  (): RecoveryActionDescriptor =>
    createAction(
      'requeueFailedAdjustmentMissingEndpointRows',
      'recovery.actions.requeueFailedAdjustmentMissingEndpointRows.label',
    );

const createRequeueFailedAdjustmentLegacyValidationRowsAction =
  (): RecoveryActionDescriptor =>
    createAction(
      'requeueFailedAdjustmentLegacyValidationRows',
      'recovery.actions.requeueFailedAdjustmentLegacyValidationRows.label',
    );

const actionableSyncBacklogTotal = (
  syncBacklog: DiagnosticsSystemHealth['syncBacklog'] | undefined,
): number => {
  if (!syncBacklog) return 0;
  return Object.values(syncBacklog).reduce((sum, statuses) => {
    return (
      sum +
      Object.entries(statuses).reduce((inner, [status, count]) => {
        if (status === 'synced' || status === 'applied') {
          return inner;
        }
        return inner + Number(count || 0);
      }, 0)
    );
  }, 0);
};

const describeModule = (moduleType?: string | null) =>
  MODULE_LABELS[moduleType || ''] ?? moduleType ?? 'Unknown module';

const isGenericParityFailureReason = (value?: string | null): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'legacy sync force failed';
};

const isDependencyParityReason = (value?: string | null): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('waiting for parent order sync') ||
    normalized.includes('waiting for parent payment sync') ||
    normalized.includes('waiting for parent') ||
    normalized.includes('parent order sync failed')
  );
};

const scoreParityItemReason = (item: SyncQueueItem): number => {
  const reason = item.errorMessage?.trim();
  if (!reason) {
    return -1;
  }

  if (item.status === 'failed' || item.status === 'conflict') {
    return 4;
  }

  if (!isDependencyParityReason(reason)) {
    return 3;
  }

  return 1;
};

export const getRepresentativeParityFailureReason = (
  lastParitySync?: DiagnosticsLastParitySync | null,
  parityItems: SyncQueueItem[] = [],
): string | null => {
  const parityItemReason =
    parityItems
      .filter((item) => typeof item.errorMessage === 'string' && item.errorMessage.trim())
      .sort((left, right) => scoreParityItemReason(right) - scoreParityItemReason(left))[0]
      ?.errorMessage?.trim() ?? null;
  const lastCycleReason = lastParitySync?.error?.trim() || lastParitySync?.reason?.trim() || null;

  if (parityItemReason && (!lastCycleReason || isGenericParityFailureReason(lastCycleReason))) {
    return parityItemReason;
  }

  return lastCycleReason || parityItemReason;
};

const pushIssue = (issues: RecoveryIssue[], issue: RecoveryIssue | null) => {
  if (!issue) return;
  if (issues.some((existing) => existing.id === issue.id)) {
    return;
  }
  issues.push(issue);
};

const buildInvalidOrdersIssue = (
  systemHealth: DiagnosticsSystemHealth,
): RecoveryIssue | null => {
  const invalidOrders = systemHealth.invalidOrders?.details ?? [];
  if (invalidOrders.length === 0) {
    return null;
  }

  return {
    id: 'invalid-orders',
    code: 'invalid_orders_pending',
    severity: 'critical',
    status: 'blocking',
    entityType: 'order',
    entityId: 'invalid-orders',
    titleKey: 'recovery.issues.invalidOrders.title',
    summaryKey: 'recovery.issues.invalidOrders.summary',
    guidanceKey: 'recovery.issues.invalidOrders.guidance',
    actions: [
      createValidatePendingOrdersAction(),
      createRemoveInvalidOrdersAction(),
    ],
    params: {
      count: invalidOrders.length,
      orderIds: invalidOrders.map((order) => order.order_id),
    },
  };
};

const buildSyncBlockerIssues = (
  systemHealth: DiagnosticsSystemHealth,
): RecoveryIssue[] => {
  return (systemHealth.syncBlockerDetails ?? []).map((blocker) => ({
    id: `sync-blocker-${blocker.queueId}`,
    code: blocker.blockerReason || 'sync_blocker',
    severity: 'error',
    status: 'blocking',
    entityType: blocker.entityType,
    entityId: blocker.entityId,
    titleKey: 'recovery.issues.syncBlocker.title',
    summaryKey: 'recovery.issues.syncBlocker.summary',
    guidanceKey: 'recovery.issues.syncBlocker.guidance',
    actions: [createRetrySyncAction(), createContactDevAction()],
    params: {
      blockerReason: blocker.blockerReason,
      queueStatus: blocker.queueStatus,
      lastError: blocker.lastError,
      entityType: blocker.entityType,
    },
    orderId: blocker.orderId ?? null,
    orderNumber: blocker.orderNumber ?? null,
    paymentId: blocker.paymentId ?? null,
    adjustmentId: blocker.adjustmentId ?? null,
    queueId: blocker.queueId,
  }));
};

const buildMissingCredentialIssue = (
  systemHealth: DiagnosticsSystemHealth,
  lastParitySync?: DiagnosticsLastParitySync | null,
): RecoveryIssue | null => {
  const credentialState = lastParitySync?.credentialState ?? systemHealth.credentialState;
  if (!credentialState || (credentialState.hasAdminUrl && credentialState.hasApiKey)) {
    return null;
  }

  const missing: string[] = [];
  if (!credentialState.hasAdminUrl) {
    missing.push('Admin URL');
  }
  if (!credentialState.hasApiKey) {
    missing.push('POS API key');
  }

  return {
    id: 'parity-missing-credentials',
    code: 'parity_missing_credentials',
    severity: 'critical',
    status: 'blocking',
    entityType: 'parity',
    entityId: 'processor',
    titleKey: 'recovery.issues.parityMissingCredentials.title',
    summaryKey: 'recovery.issues.parityMissingCredentials.summary',
    guidanceKey: 'recovery.issues.parityMissingCredentials.guidance',
    actions: [createOpenConnectionSettingsAction()],
    params: {
      missingItems: missing.join(', '),
    },
  };
};

const preferredCheckoutBlockerMethod = (
  blocker: UnsettledPaymentBlocker,
): 'cash' | 'card' | null => {
  if (
    blocker.reasonCode === 'missing_cash_payment' ||
    blocker.reasonCode === 'partial_cash_payment' ||
    blocker.paymentMethod === 'cash'
  ) {
    return 'cash';
  }

  if (
    blocker.reasonCode === 'missing_card_payment' ||
    blocker.reasonCode === 'partial_card_payment' ||
    blocker.paymentMethod === 'card'
  ) {
    return 'card';
  }

  return null;
};

const buildCheckoutPaymentBlockerIssues = (
  systemHealth: DiagnosticsSystemHealth,
): RecoveryIssue[] => {
  const blockerSnapshot = systemHealth.checkoutPaymentBlockers;
  const blockers = blockerSnapshot?.details ?? [];
  if (blockers.length === 0) {
    return [];
  }

  return blockers.map((blocker) => {
    const preferredMethod = preferredCheckoutBlockerMethod(blocker);
    const outstandingAmount = Math.max(
      Number(blocker.totalAmount || 0) - Number(blocker.settledAmount || 0),
      0,
    );
    const issue = {
      id: `checkout-payment-blocker-${blocker.orderId}`,
      code: blocker.reasonCode,
      severity: 'error',
      status: 'blocking',
      entityType: 'order',
      entityId: blocker.orderId,
      titleKey: 'recovery.issues.checkoutPaymentBlocker.title',
      summaryKey: 'recovery.issues.checkoutPaymentBlocker.summary',
      guidanceKey: 'recovery.issues.checkoutPaymentBlocker.guidance',
      actions: [
        createOpenOrderPaymentFixAction(blocker, preferredMethod),
        createContactDevAction(),
      ],
      params: {
        orderNumber: blocker.orderNumber,
        reasonCode: blocker.reasonCode,
        reasonText: blocker.reasonText,
        suggestedFix: blocker.suggestedFix,
        paymentMethod: blocker.paymentMethod,
        paymentStatus: blocker.paymentStatus,
        totalAmount: Number(blocker.totalAmount || 0).toFixed(2),
        settledAmount: Number(blocker.settledAmount || 0).toFixed(2),
        outstandingAmount: outstandingAmount.toFixed(2),
        preferredMethod,
        sourceWindow: blockerSnapshot?.sourceWindow ?? 'active_shift',
      },
      orderId: blocker.orderId,
      orderNumber: blocker.orderNumber,
    } satisfies RecoveryIssue;
    return withKnownSolution(issue, RECOVERY_RECIPES.checkoutPaymentOpenPayment);
  });
};

const buildParityProcessorIssue = (
  systemHealth: DiagnosticsSystemHealth,
  parityItems: SyncQueueItem[],
  lastParitySync?: DiagnosticsLastParitySync | null,
): RecoveryIssue | null => {
  const parityQueueStatus = systemHealth.parityQueueStatus;
  const total = parityQueueStatus?.total ?? 0;
  if (total <= 0) {
    return null;
  }

  const zeroProgress =
    lastParitySync?.status === 'completed' &&
    (lastParitySync.processed ?? 0) === 0 &&
    (lastParitySync.remaining ?? 0) > 0;

  const hasBlockedParityItems = parityItems.some((item) => {
    if (item.status === 'failed' || item.status === 'conflict' || item.status === 'processing') {
      return true;
    }

    return !item.nextRetryAt && typeof item.errorMessage === 'string' && item.errorMessage.trim().length > 0;
  });

  if ((!zeroProgress || !hasBlockedParityItems) && lastParitySync?.status !== 'failed') {
    return null;
  }

  const representativeReason = getRepresentativeParityFailureReason(lastParitySync, parityItems);
  const effectiveReason = representativeReason ?? 'Unknown parity failure';

  return {
    id: 'parity-processor-stalled',
    code: 'parity_processor_stalled_zero_progress',
    severity: 'error',
    status: 'blocking',
    entityType: 'parity',
    entityId: 'processor',
    titleKey: 'recovery.issues.parityProcessorStalled.title',
    summaryKey: 'recovery.issues.parityProcessorStalled.summary',
    guidanceKey: 'recovery.issues.parityProcessorStalled.guidance',
    actions: [createRunParitySyncAction(), createContactDevAction()],
    params: {
      processed: lastParitySync?.processed ?? 0,
      remaining: lastParitySync?.remaining ?? total,
      failed: parityQueueStatus?.failed ?? 0,
      pending: parityQueueStatus?.pending ?? 0,
      finishedAt: lastParitySync?.finishedAt ?? null,
      reason: effectiveReason,
    },
  };
};

const parseJsonPayload = (raw?: string | null): Record<string, unknown> => {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const payloadString = (
  payload: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const payloadNumber = (
  payload: Record<string, unknown>,
  keys: string[],
): number | null => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
};

const isPaymentTotalConflictMessage = (message?: string | null): boolean => {
  const normalized = message?.toLowerCase() ?? '';
  return normalized.includes('payment exceeds order total') ||
    (normalized.includes('http 422') && normalized.includes('existing completed'));
};

const isInvalidDriverOrderPatchFailure = (item: SyncQueueItem): boolean => {
  if (item.tableName !== 'orders' || item.operation !== 'UPDATE') {
    return false;
  }
  if (item.status !== 'failed' && item.status !== 'conflict') {
    return false;
  }
  const normalized = item.errorMessage?.toLowerCase() ?? '';
  return normalized.includes('invalid driver');
};

const isOrderUpdateReplayBlocker = (item: SyncQueueItem): boolean => {
  if (item.tableName !== 'orders' || item.operation !== 'UPDATE') {
    return false;
  }
  if (!['pending', 'failed', 'conflict', 'processing'].includes(item.status)) {
    return false;
  }
  const normalized = item.errorMessage?.toLowerCase() ?? '';
  return normalized.includes('failed to update order') ||
    normalized.includes('menu_item_id') ||
    normalized.includes('order_items');
};

const isPaymentWaitingForParentOrderUpdate = (item: SyncQueueItem): boolean => {
  if (item.tableName !== 'payments') {
    return false;
  }
  const normalized = item.errorMessage?.toLowerCase() ?? '';
  return normalized.includes('waiting for parent order update sync') ||
    normalized.includes('order update not yet synced');
};

const isOrderUpdateWaitingForParentOrderSync = (item: SyncQueueItem): boolean => {
  if (item.tableName !== 'orders' || item.operation?.toUpperCase() !== 'UPDATE') {
    return false;
  }
  if (!['pending', 'failed', 'conflict', 'processing'].includes(item.status)) {
    return false;
  }
  const normalized = item.errorMessage?.toLowerCase() ?? '';
  return normalized.includes('waiting for parent order sync') ||
    normalized.includes('stale order update replay') ||
    normalized.includes('local parent order missing');
};

const isStaleOrderUpdateParentWait = (item: SyncQueueItem): boolean => {
  const normalized = item.errorMessage?.toLowerCase() ?? '';
  return normalized.includes('stale order update replay') ||
    normalized.includes('local parent order missing') ||
    (normalized.includes('deferred too many times') &&
      normalized.includes('waiting for parent order sync'));
};

const hasPendingParentOrderInsert = (
  parityItems: SyncQueueItem[],
  recordId: string,
): boolean =>
  parityItems.some((item) =>
    item.tableName === 'orders' &&
    item.operation?.toUpperCase() === 'INSERT' &&
    item.recordId === recordId &&
    ['pending', 'processing'].includes(item.status) &&
    !item.errorMessage,
  );

const extractPaymentTotalConflictMetric = (
  message: string,
  label: string,
): number | null => {
  const normalized = message.toLowerCase();
  const needle = label.toLowerCase();
  const start = normalized.indexOf(needle);
  if (start < 0) {
    return null;
  }
  const tail = message.slice(start + label.length).trimStart();
  const match = tail.match(/^-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatAmountParam = (value: number | null): string | null =>
  value === null ? null : value.toFixed(2);

const payloadArray = (
  payload: Record<string, unknown>,
  keys: string[],
): Record<string, unknown>[] => {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object' && !Array.isArray(row),
      );
    }
  }
  return [];
};

const settlementRefundTotalFromPayload = (payload: Record<string, unknown>): number | null => {
  const rows = payloadArray(payload, ['settlement_adjustments', 'settlementAdjustments']);
  if (rows.length === 0) {
    return null;
  }
  const refundTotal = rows.reduce((sum, row) => {
    const cents = payloadNumber(row, ['amount_cents', 'amountCents']);
    if (cents !== null) {
      return sum + cents / 100;
    }
    return sum + (payloadNumber(row, ['amount']) ?? 0);
  }, 0);
  return Number.isFinite(refundTotal) && refundTotal > 0 ? refundTotal : null;
};

const formatSettlementMath = (
  paymentAmount: string | null,
  settlementRefundTotal: number | null,
): string | null => {
  if (!paymentAmount || settlementRefundTotal === null) {
    return null;
  }
  const gross = Number(paymentAmount);
  if (!Number.isFinite(gross)) {
    return null;
  }
  const net = gross - settlementRefundTotal;
  return `${gross.toFixed(2)} - ${settlementRefundTotal.toFixed(2)} = ${net.toFixed(2)}`;
};

const buildPaymentTotalConflictIssues = (
  parityItems: SyncQueueItem[],
): { issues: RecoveryIssue[]; suppressedRows: Set<string> } => {
  const issues: RecoveryIssue[] = [];
  const suppressedRows = new Set<string>();

  for (const item of parityItems) {
    if (item.tableName !== 'payments' || !isPaymentTotalConflictMessage(item.errorMessage)) {
      continue;
    }

    const payload = parseJsonPayload(item.data);
    const error = item.errorMessage ?? '';
    const paymentId =
      payloadString(payload, ['paymentId', 'payment_id', 'local_payment_id']) ||
      item.recordId;
    const orderId =
      payloadString(payload, ['orderId', 'order_id', 'localOrderId', 'clientOrderId']) ||
      null;
    const remotePaymentId =
      payloadString(payload, ['remote_payment_id', 'canonical_payment_id']) || null;
    const localOrderTotal = formatAmountParam(
      payloadNumber(payload, ['orderTotal', 'order_total', 'totalAmount', 'total_amount']),
    );
    const remoteOrderTotal = formatAmountParam(
      extractPaymentTotalConflictMetric(error, 'order total:'),
    );
    const existingCompleted = formatAmountParam(
      extractPaymentTotalConflictMetric(error, 'existing completed:'),
    );
    const paymentAmount = formatAmountParam(
      extractPaymentTotalConflictMetric(error, 'payment:') ??
        payloadNumber(payload, ['amount', 'paymentAmount']),
    );
    const settlementRefundTotal = settlementRefundTotalFromPayload(payload);
    const settlementMath = formatSettlementMath(paymentAmount, settlementRefundTotal);

    suppressedRows.add(`${item.tableName}:${item.recordId}`);
    issues.push(withKnownSolution({
      id: `payment-total-conflict-${item.id}`,
      code: 'payment_total_conflict',
      severity: 'error',
      status: 'blocking',
      entityType: 'payment',
      entityId: paymentId,
      titleKey: 'recovery.issues.paymentTotalConflict.title',
      summaryKey: 'recovery.issues.paymentTotalConflict.summary',
      guidanceKey: 'recovery.issues.paymentTotalConflict.guidance',
      actions: [
        createRepairPaymentTotalConflictAction(),
        createRetryParityItemAction(),
        createRunParitySyncAction(),
      ],
      params: {
        sampleItemId: item.id,
        sampleTableName: item.tableName,
        sampleRecordId: item.recordId,
        moduleType: item.moduleType || 'payment',
        lastError: item.errorMessage ?? null,
        paymentId,
        orderId,
        remotePaymentId,
        localOrderTotal,
        remoteOrderTotal,
        orderTotal: remoteOrderTotal,
        paymentAmount,
        existingCompleted,
        settlementMath,
        settlementRefundTotal: formatAmountParam(settlementRefundTotal),
      },
      orderId,
      paymentId,
    }, RECOVERY_RECIPES.paymentTotalConflictRepair));
  }

  return { issues, suppressedRows };
};

const buildInvalidDriverOrderIssues = (
  parityItems: SyncQueueItem[],
): { issues: RecoveryIssue[]; suppressedRows: Set<string> } => {
  const rows = parityItems.filter(isInvalidDriverOrderPatchFailure);
  if (rows.length === 0) {
    return { issues: [], suppressedRows: new Set() };
  }

  const sample = rows[0];
  const payload = parseJsonPayload(sample.data);
  const driverId = payloadString(payload, ['driverId', 'driver_id']);
  const driverName = payloadString(payload, ['driverName', 'driver_name']);
  const orderId = payloadString(payload, ['orderId', 'order_id']) || sample.recordId;
  const suppressedRows = new Set(rows.map((item) => `${item.tableName}:${item.recordId}`));

  return {
    suppressedRows,
    issues: [
      {
        id: `order-invalid-driver-${sample.id}`,
        code: 'order_invalid_driver_update',
        severity: 'error',
        status: 'blocking',
        entityType: 'order',
        entityId: orderId,
        titleKey: 'recovery.issues.orderInvalidDriverUpdate.title',
        summaryKey: 'recovery.issues.orderInvalidDriverUpdate.summary',
        guidanceKey: 'recovery.issues.orderInvalidDriverUpdate.guidance',
        actions: [
          createRepairInvalidDriverOrderUpdateAction(),
          createRetryParityItemAction(),
          createRunParitySyncAction(),
        ],
        params: {
          count: rows.length,
          sampleItemId: sample.id,
          sampleTableName: sample.tableName,
          sampleRecordId: sample.recordId,
          moduleType: sample.moduleType || 'orders',
          sampleError: sample.errorMessage ?? null,
          lastError: sample.errorMessage ?? null,
          orderId,
          driverId,
          driverName,
        },
        orderId,
      },
    ],
  };
};

const buildOrderUpdateParentWaitIssues = (
  parityItems: SyncQueueItem[],
): { issues: RecoveryIssue[]; suppressedRows: Set<string> } => {
  const rows = parityItems
    .filter(isOrderUpdateWaitingForParentOrderSync)
    .filter((item) => !hasPendingParentOrderInsert(parityItems, item.recordId));
  if (rows.length === 0) {
    return { issues: [], suppressedRows: new Set() };
  }

  const sample = rows[0];
  const payload = parseJsonPayload(sample.data);
  const orderId = payloadString(payload, ['orderId', 'order_id']) || sample.recordId;
  const orderNumber = payloadString(payload, ['orderNumber', 'order_number']);
  const totalAmount = formatAmountParam(
    payloadNumber(payload, ['totalAmount', 'total_amount']),
  );
  const suppressedRows = new Set(rows.map((item) => `${item.tableName}:${item.recordId}`));
  const stale = rows.some(isStaleOrderUpdateParentWait);

  const issue = withKnownSolution({
    id: `order-update-parent-wait-${sample.id}`,
    code: stale ? 'stale_order_update_parent_wait' : 'order_update_parent_wait',
    severity: stale ? 'error' : 'warning',
    status: 'blocking',
    entityType: 'order',
    entityId: orderId,
    titleKey: stale
      ? 'recovery.issues.staleOrderUpdateParentWait.title'
      : 'recovery.issues.orderUpdateParentWait.title',
    summaryKey: stale
      ? 'recovery.issues.staleOrderUpdateParentWait.summary'
      : 'recovery.issues.orderUpdateParentWait.summary',
    guidanceKey: stale
      ? 'recovery.issues.staleOrderUpdateParentWait.guidance'
      : 'recovery.issues.orderUpdateParentWait.guidance',
    actions: [
      createRepairOrderUpdateReplayBlockersAction(),
      createRetryParityModuleAction(),
      createRetryParityItemAction(),
      createRunParitySyncAction(),
    ],
    params: {
      count: rows.length,
      sampleItemId: sample.id,
      sampleTableName: sample.tableName,
      sampleRecordId: sample.recordId,
      sampleError: sample.errorMessage ?? null,
      lastError: sample.errorMessage ?? null,
      moduleType: sample.moduleType || 'orders',
      orderId,
      orderNumber,
      totalAmount,
    },
    orderId,
    orderNumber,
  }, RECOVERY_RECIPES.orderUpdateReplayRepair);

  return {
    suppressedRows,
    issues: [issue],
  };
};

const buildOrderUpdateReplayBlockerIssues = (
  parityItems: SyncQueueItem[],
): { issues: RecoveryIssue[]; suppressedRows: Set<string> } => {
  const rows = parityItems.filter(isOrderUpdateReplayBlocker);
  if (rows.length === 0) {
    return { issues: [], suppressedRows: new Set() };
  }

  const dependentPayments = parityItems.filter(isPaymentWaitingForParentOrderUpdate);
  const sample = rows[0];
  const payload = parseJsonPayload(sample.data);
  const orderId = payloadString(payload, ['orderId', 'order_id']) || sample.recordId;
  const orderNumber = payloadString(payload, ['orderNumber', 'order_number']);
  const suppressedRows = new Set([
    ...rows.map((item) => `${item.tableName}:${item.recordId}`),
    ...dependentPayments.map((item) => `${item.tableName}:${item.recordId}`),
  ]);

  return {
    suppressedRows,
    issues: [
      {
        id: `order-update-replay-blocked-${sample.id}`,
        code: 'order_update_replay_blocked',
        severity: 'error',
        status: 'blocking',
        entityType: 'order',
        entityId: orderId,
        titleKey: 'recovery.issues.orderUpdateReplayBlocked.title',
        summaryKey: 'recovery.issues.orderUpdateReplayBlocked.summary',
        guidanceKey: 'recovery.issues.orderUpdateReplayBlocked.guidance',
        actions: [
          createRepairOrderUpdateReplayBlockersAction(),
          createRetryParityModuleAction(),
          createRunParitySyncAction(),
        ],
        params: {
          count: rows.length,
          dependentPaymentCount: dependentPayments.length,
          sampleItemId: sample.id,
          sampleTableName: sample.tableName,
          sampleRecordId: sample.recordId,
          sampleError: sample.errorMessage ?? null,
          lastError: sample.errorMessage ?? null,
          moduleType: sample.moduleType || 'orders',
          orderId,
          orderNumber,
        },
        orderId,
        orderNumber,
      },
    ],
  };
};

const isCatalogAvailabilityPatchFailure = (item: SyncQueueItem): boolean => {
  if (item.status !== 'failed') {
    return false;
  }
  if (!['menu_categories', 'subcategories', 'menu_subcategories'].includes(item.tableName)) {
    return false;
  }
  const normalized = item.errorMessage?.toLowerCase() ?? '';
  return normalized.includes('generic pos sync updates are not allowed') ||
    normalized.includes('http 405');
};

const buildCatalogAvailabilityIssues = (
  parityItems: SyncQueueItem[],
): { issues: RecoveryIssue[]; suppressedRows: Set<string> } => {
  const rows = parityItems.filter(isCatalogAvailabilityPatchFailure);
  if (rows.length === 0) {
    return { issues: [], suppressedRows: new Set() };
  }

  const sample = rows[0];
  const suppressedRows = new Set(rows.map((item) => `${item.tableName}:${item.recordId}`));
  return {
    suppressedRows,
    issues: [
      {
        id: `catalog-availability-retry-${sample.id}`,
        code: 'catalog_availability_retry',
        severity: 'error',
        status: 'blocking',
        entityType: 'catalog',
        entityId: sample.recordId,
        titleKey: 'recovery.issues.catalogAvailabilityRetry.title',
        summaryKey: 'recovery.issues.catalogAvailabilityRetry.summary',
        guidanceKey: 'recovery.issues.catalogAvailabilityRetry.guidance',
        actions: [
          createRetryCatalogAvailabilityAction(),
          createRetryParityModuleAction(),
          createRunParitySyncAction(),
        ],
        params: {
          count: rows.length,
          sampleItemId: sample.id,
          sampleTableName: sample.tableName,
          sampleRecordId: sample.recordId,
          sampleError: sample.errorMessage ?? null,
          moduleType: sample.moduleType || 'catalog',
        },
      },
    ],
  };
};

const buildParityModuleIssues = (
  parityItems: SyncQueueItem[],
  suppressedRows: Set<string>,
): RecoveryIssue[] => {
  if (parityItems.length === 0) {
    return [];
  }

  const grouped = new Map<string, { pending: SyncQueueItem[]; failed: SyncQueueItem[] }>();
  for (const item of parityItems) {
    if (suppressedRows.has(`${item.tableName}:${item.recordId}`)) {
      continue;
    }
    const moduleType = item.moduleType || 'orders';
    const bucket = grouped.get(moduleType) ?? { pending: [], failed: [] };
    if (item.status === 'failed') {
      bucket.failed.push(item);
    } else {
      bucket.pending.push(item);
    }
    grouped.set(moduleType, bucket);
  }

  const issues: RecoveryIssue[] = [];
  for (const [moduleType, bucket] of grouped.entries()) {
    const moduleLabel = describeModule(moduleType);
    if (bucket.failed.length > 0) {
      const sample = bucket.failed[0];
      pushIssue(issues, {
        id: `parity-module-failed-${moduleType}`,
        code: 'parity_module_failed_items',
        severity: 'error',
        status: 'blocking',
        entityType: 'parity_module',
        entityId: moduleType,
        titleKey: 'recovery.issues.parityModuleFailed.title',
        summaryKey: 'recovery.issues.parityModuleFailed.summary',
        guidanceKey: 'recovery.issues.parityModuleFailed.guidance',
        actions: [
          createRetryParityItemAction(),
          createRetryParityModuleAction(),
          createRunParitySyncAction(),
        ],
        params: {
          moduleType,
          moduleLabel,
          count: bucket.failed.length,
          sampleItemId: sample.id,
          sampleTableName: sample.tableName,
          sampleRecordId: sample.recordId,
          sampleError: sample.errorMessage ?? null,
        },
      });
    }

    if (bucket.pending.length > 0) {
      const sample = bucket.pending[0];
      pushIssue(issues, {
        id: `parity-module-pending-${moduleType}`,
        code: 'parity_module_pending_items',
        severity: 'warning',
        status: 'recovering',
        entityType: 'parity_module',
        entityId: moduleType,
        titleKey: 'recovery.issues.parityModulePending.title',
        summaryKey: 'recovery.issues.parityModulePending.summary',
        guidanceKey: 'recovery.issues.parityModulePending.guidance',
        actions: [createRunParitySyncAction(), createRetryParityModuleAction()],
        params: {
          moduleType,
          moduleLabel,
          count: bucket.pending.length,
          sampleItemId: sample.id,
          sampleTableName: sample.tableName,
          sampleRecordId: sample.recordId,
          nextRetryAt: sample.nextRetryAt ?? null,
        },
      });
    }
  }

  return issues;
};

const parseIssueTimestamp = (value?: string | null): number | null => {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isWaitingParentIssueBlocking = (
  systemHealth: DiagnosticsSystemHealth,
  issue: SyncFinancialIntegrityIssue,
): boolean => {
  if (issue.parentHasRemoteIdentity) {
    return true;
  }

  if (!systemHealth.isOnline) {
    return false;
  }

  const timestamp =
    parseIssueTimestamp(issue.updatedAt) ?? parseIssueTimestamp(issue.createdAt);
  if (timestamp == null) {
    return true;
  }

  return Date.now() - timestamp >= WAITING_PARENT_BLOCKING_AGE_MS;
};

const buildIntegrityIssue = (
  systemHealth: DiagnosticsSystemHealth,
  issue: SyncFinancialIntegrityIssue,
): RecoveryIssue => {
  const common = {
    entityType: issue.entityType,
    entityId: issue.entityId,
    orderId: issue.orderId ?? null,
    orderNumber: issue.orderNumber ?? null,
    paymentId: issue.paymentId ?? null,
    adjustmentId: issue.adjustmentId ?? null,
    queueId: issue.queueId ?? null,
    params: {
      reasonCode: issue.reasonCode,
      suggestedFix: issue.suggestedFix,
      details: issue.details ?? issue.lastError ?? null,
      queueStatus: issue.queueStatus ?? null,
      entityType: issue.entityType,
      entityId: issue.entityId,
      paymentId: issue.paymentId ?? null,
      adjustmentId: issue.adjustmentId ?? null,
      lastError: issue.lastError ?? null,
      legacyParityRowId: issue.legacyParityRowId ?? null,
    },
  };

  switch (issue.reasonCode) {
    case 'order_payment_waiting_parent':
      return {
        id: `integrity-order-payment-${issue.entityId}`,
        code: issue.reasonCode,
        severity: 'warning',
        status: isWaitingParentIssueBlocking(systemHealth, issue)
          ? 'blocking'
          : 'recovering',
        titleKey: 'recovery.issues.orderPaymentWaitingParent.title',
        summaryKey: 'recovery.issues.orderPaymentWaitingParent.summary',
        guidanceKey: 'recovery.issues.orderPaymentWaitingParent.guidance',
        actions: [createRepairWaitingParentPaymentsAction(), createRunParitySyncAction()],
        ...common,
      };
    case 'payment_adjustment_waiting_parent':
      return {
        id: `integrity-adjustment-parent-${issue.entityId}`,
        code: issue.reasonCode,
        severity: 'warning',
        status: isWaitingParentIssueBlocking(systemHealth, issue)
          ? 'blocking'
          : 'recovering',
        titleKey: 'recovery.issues.paymentAdjustmentWaitingParent.title',
        summaryKey: 'recovery.issues.paymentAdjustmentWaitingParent.summary',
        guidanceKey: 'recovery.issues.paymentAdjustmentWaitingParent.guidance',
        actions: [createRepairWaitingParentAdjustmentsAction(), createRunParitySyncAction()],
        ...common,
      };
    case 'legacy_financial_parity_orphan':
      return {
        id: `integrity-legacy-financial-orphan-${issue.entityType}-${issue.entityId}`,
        code: issue.reasonCode,
        severity: 'error',
        status: 'blocking',
        titleKey: 'recovery.issues.legacyFinancialParityOrphan.title',
        summaryKey: 'recovery.issues.legacyFinancialParityOrphan.summary',
        guidanceKey: 'recovery.issues.legacyFinancialParityOrphan.guidance',
        actions: [createClearLegacyFinancialOrphanAction(), createContactDevAction()],
        ...common,
      };
    case 'payment_adjustment_missing_canonical_remote_payment':
      return {
        id: `integrity-adjustment-canonical-${issue.entityId}`,
        code: issue.reasonCode,
        severity: 'error',
        status: 'blocking',
        titleKey: 'recovery.issues.paymentAdjustmentMissingCanonicalRemotePayment.title',
        summaryKey: 'recovery.issues.paymentAdjustmentMissingCanonicalRemotePayment.summary',
        guidanceKey: 'recovery.issues.paymentAdjustmentMissingCanonicalRemotePayment.guidance',
        actions: [createRepairOrphanedFinancialAction(), createContactDevAction()],
        ...common,
      };
    default:
      return {
        id: `integrity-generic-${issue.entityType}-${issue.entityId}`,
        code: issue.reasonCode,
        severity: 'warning',
        status: 'blocking',
        titleKey: 'recovery.issues.financialIntegrity.title',
        summaryKey: 'recovery.issues.financialIntegrity.summary',
        guidanceKey: 'recovery.issues.financialIntegrity.guidance',
        actions: [createContactDevAction()],
        ...common,
      };
  }
};

const buildFinancialQueueIssues = (
  financialItems: SyncFinancialQueueItem[],
): RecoveryIssue[] => {
  const issues: RecoveryIssue[] = [];

  for (const item of financialItems) {
    if (item.status !== 'failed' || !item.lastError) {
      continue;
    }

    const normalizedError = item.lastError.toLowerCase();
    let code = 'financial_queue_failed';
    let actions: RecoveryActionDescriptor[] = [
      createRetryFinancialItemAction(),
      createContactDevAction(),
    ];

    if (normalizedError.includes('validation')) {
      code = 'financial_validation_failed';
    } else if (
      normalizedError.includes('/api/pos/payments/adjustments/sync') &&
      (normalizedError.includes('404') ||
        normalizedError.includes('not found') ||
        normalizedError.includes('endpoint'))
    ) {
      code = 'financial_adjustment_missing_endpoint';
      actions = [
        createRequeueFailedAdjustmentMissingEndpointRowsAction(),
        createRetryFinancialItemAction(),
      ];
    } else if (
      item.entityType === 'payment_adjustment' &&
      normalizedError.includes('validation failed') &&
      normalizedError.includes('staff_id') &&
      normalizedError.includes('invalid uuid') &&
      normalizedError.includes('remote_payment_id') &&
      normalizedError.includes('canonical_payment_id')
    ) {
      code = 'financial_adjustment_legacy_validation';
      actions = [
        createRequeueFailedAdjustmentLegacyValidationRowsAction(),
        createRetryFinancialItemAction(),
      ];
    } else if (
      (item.entityType === 'shift_expense' || item.entityType === 'staff_payment') &&
      (
        normalizedError.includes('cashier shift') ||
        normalizedError.includes('staff_shift_id') ||
        normalizedError.includes('parent shift') ||
        normalizedError.includes('shift not found on backend')
      )
    ) {
      code = 'financial_shift_dependency_failed';
      actions = [
        createRequeueFailedFinancialShiftRowsAction(),
        createRetryFinancialItemAction(),
      ];
    }

    issues.push({
      id: `financial-queue-${item.queueId}`,
      code,
      severity: 'warning',
      status: 'blocking',
      entityType: item.entityType,
      entityId: item.entityId,
      titleKey: 'recovery.issues.financialQueueFailed.title',
      summaryKey: 'recovery.issues.financialQueueFailed.summary',
      guidanceKey: 'recovery.issues.financialQueueFailed.guidance',
      actions,
      params: {
        queueStatus: item.status,
        lastError: item.lastError,
        operation: item.operation,
      },
      queueId: item.queueId,
    });
  }

  return issues;
};

const buildFallbackIssue = (
  systemHealth: DiagnosticsSystemHealth,
  issues: RecoveryIssue[],
): RecoveryIssue | null => {
  const totalBacklog = actionableSyncBacklogTotal(systemHealth.syncBacklog);
  const parityTotal = systemHealth.parityQueueStatus?.total ?? 0;
  if (issues.length > 0 || (totalBacklog <= 0 && parityTotal <= 0)) {
    return null;
  }

  return {
    id: 'sync-fallback-contact-dev',
    code: 'contact_dev_required',
    severity: 'warning',
    status: 'blocking',
    entityType: 'sync',
    entityId: 'fallback',
    titleKey: 'recovery.issues.contactDevFallback.title',
    summaryKey: 'recovery.issues.contactDevFallback.summary',
    guidanceKey: 'recovery.issues.contactDevFallback.guidance',
    actions: [createContactDevAction()],
    params: {
      totalBacklog,
      parityTotal,
    },
  };
};

const getLegacyFinancialParityKey = (
  issue: Pick<
    SyncFinancialIntegrityIssue,
    'reasonCode' | 'entityType' | 'entityId' | 'paymentId' | 'adjustmentId'
  >,
): string | null => {
  if (issue.reasonCode !== 'legacy_financial_parity_orphan') {
    return null;
  }

  if (issue.entityType === 'payment') {
    return `payments:${issue.paymentId ?? issue.entityId}`;
  }

  if (issue.entityType === 'payment_adjustment') {
    return `payment_adjustments:${issue.adjustmentId ?? issue.entityId}`;
  }

  return null;
};

export function buildSyncRecoveryIssues({
  systemHealth,
  lastParitySync,
  parityItems = [],
  financialItems = [],
  integrity,
}: BuildSyncRecoveryIssuesInput): BuildSyncRecoveryIssuesResult {
  if (!systemHealth) {
    return {
      issues: [],
      counts: { blocking: 0, recovering: 0, total: 0 },
    };
  }

  const issues: RecoveryIssue[] = [];
  const legacyFinancialParityRows = new Set(
    parityItems
      .filter((item) => LEGACY_FINANCIAL_PARITY_TABLES.has(item.tableName))
      .map((item) => `${item.tableName}:${item.recordId}`),
  );
  const integrityIssues = (integrity?.issues ?? []).filter((issue) => {
    const legacyParityKey = getLegacyFinancialParityKey(issue);
    if (!legacyParityKey) {
      return true;
    }

    return legacyFinancialParityRows.has(legacyParityKey);
  });
  const suppressedLegacyFinancialRows = new Set<string>();
  for (const item of financialItems) {
    if (item.entityType === 'payment') {
      suppressedLegacyFinancialRows.add(`payments:${item.entityId}`);
    } else if (item.entityType === 'payment_adjustment') {
      suppressedLegacyFinancialRows.add(`payment_adjustments:${item.entityId}`);
    }
  }
  for (const issue of integrityIssues) {
    if (issue.entityType === 'payment') {
      suppressedLegacyFinancialRows.add(`payments:${issue.paymentId ?? issue.entityId}`);
    } else if (issue.entityType === 'payment_adjustment') {
      suppressedLegacyFinancialRows.add(
        `payment_adjustments:${issue.adjustmentId ?? issue.entityId}`,
      );
    }
  }
  const paymentTotalConflictResult = buildPaymentTotalConflictIssues(parityItems);
  for (const suppressedRow of paymentTotalConflictResult.suppressedRows) {
    suppressedLegacyFinancialRows.add(suppressedRow);
  }
  const invalidDriverOrderResult = buildInvalidDriverOrderIssues(parityItems);
  for (const suppressedRow of invalidDriverOrderResult.suppressedRows) {
    suppressedLegacyFinancialRows.add(suppressedRow);
  }
  const orderUpdateParentWaitResult = buildOrderUpdateParentWaitIssues(parityItems);
  for (const suppressedRow of orderUpdateParentWaitResult.suppressedRows) {
    suppressedLegacyFinancialRows.add(suppressedRow);
  }
  const orderUpdateReplayResult = buildOrderUpdateReplayBlockerIssues(parityItems);
  for (const suppressedRow of orderUpdateReplayResult.suppressedRows) {
    suppressedLegacyFinancialRows.add(suppressedRow);
  }
  const catalogAvailabilityResult = buildCatalogAvailabilityIssues(parityItems);
  for (const suppressedRow of catalogAvailabilityResult.suppressedRows) {
    suppressedLegacyFinancialRows.add(suppressedRow);
  }
  const hasSpecificParityRecoveryIssue =
    paymentTotalConflictResult.issues.length > 0 ||
    invalidDriverOrderResult.issues.length > 0 ||
    orderUpdateParentWaitResult.issues.length > 0 ||
    orderUpdateReplayResult.issues.length > 0 ||
    catalogAvailabilityResult.issues.length > 0;
  pushIssue(issues, buildMissingCredentialIssue(systemHealth, lastParitySync));
  for (const issue of buildCheckoutPaymentBlockerIssues(systemHealth)) {
    pushIssue(issues, issue);
  }
  pushIssue(issues, buildInvalidOrdersIssue(systemHealth));
  if (!hasSpecificParityRecoveryIssue) {
    pushIssue(issues, buildParityProcessorIssue(systemHealth, parityItems, lastParitySync));
  }

  for (const issue of buildSyncBlockerIssues(systemHealth)) {
    pushIssue(issues, issue);
  }
  for (const issue of paymentTotalConflictResult.issues) {
    pushIssue(issues, issue);
  }
  for (const issue of invalidDriverOrderResult.issues) {
    pushIssue(issues, issue);
  }
  for (const issue of orderUpdateParentWaitResult.issues) {
    pushIssue(issues, issue);
  }
  for (const issue of orderUpdateReplayResult.issues) {
    pushIssue(issues, issue);
  }
  for (const issue of catalogAvailabilityResult.issues) {
    pushIssue(issues, issue);
  }
  for (const issue of buildParityModuleIssues(parityItems, suppressedLegacyFinancialRows)) {
    pushIssue(issues, issue);
  }
  for (const integrityIssue of integrityIssues) {
    pushIssue(issues, buildIntegrityIssue(systemHealth, integrityIssue));
  }
  for (const issue of buildFinancialQueueIssues(financialItems)) {
    pushIssue(issues, issue);
  }

  pushIssue(issues, buildFallbackIssue(systemHealth, issues));

  const blocking = issues.filter((issue) => issue.status === 'blocking').length;
  const recovering = issues.filter((issue) => issue.status === 'recovering').length;

  return {
    issues,
    counts: {
      blocking,
      recovering,
      total: issues.length,
    },
  };
}
