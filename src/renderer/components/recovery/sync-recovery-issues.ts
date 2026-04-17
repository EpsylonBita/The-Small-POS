import type {
  DiagnosticsLastParitySync,
  DiagnosticsSystemHealth,
  RecoveryActionDescriptor,
  RecoveryIssue,
  SyncFinancialIntegrityIssue,
  SyncFinancialIntegrityResponse,
  SyncFinancialQueueItem,
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

const createAction = (
  id: string,
  labelKey: string,
  options: Partial<RecoveryActionDescriptor> = {},
): RecoveryActionDescriptor => ({
  id,
  labelKey,
  safetyLevel: options.safetyLevel ?? 'safe',
  requiresOnline: options.requiresOnline ?? false,
  confirmationRequired: options.confirmationRequired ?? false,
  confirmTitleKey: options.confirmTitleKey,
  confirmMessageKey: options.confirmMessageKey,
  confirmCheckboxKey: options.confirmCheckboxKey,
  routeTarget: options.routeTarget ?? null,
});

const createContactOperatorAction = (): RecoveryActionDescriptor =>
  createAction('contactOperator', 'recovery.actions.contactOperator.label');

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

const createRetryParityModuleAction = (): RecoveryActionDescriptor =>
  createAction('retryParityModule', 'recovery.actions.retryParityModule.label');

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

export const getRepresentativeParityFailureReason = (
  lastParitySync?: DiagnosticsLastParitySync | null,
  parityItems: SyncQueueItem[] = [],
): string | null => {
  const parityItemReason =
    parityItems.find(
      (item) => item.status === 'failed' && typeof item.errorMessage === 'string' && item.errorMessage.trim(),
    )?.errorMessage?.trim() ?? null;
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
    actions: [createRetrySyncAction(), createContactOperatorAction()],
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

  if (!zeroProgress && lastParitySync?.status !== 'failed') {
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
    actions: [createRunParitySyncAction(), createContactOperatorAction()],
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

const buildParityModuleIssues = (
  parityItems: SyncQueueItem[],
): RecoveryIssue[] => {
  if (parityItems.length === 0) {
    return [];
  }

  const grouped = new Map<string, { pending: SyncQueueItem[]; failed: SyncQueueItem[] }>();
  for (const item of parityItems) {
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

const buildIntegrityIssue = (
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
    },
  };

  switch (issue.reasonCode) {
    case 'order_payment_waiting_parent':
      return {
        id: `integrity-order-payment-${issue.entityId}`,
        code: issue.reasonCode,
        severity: 'warning',
        status: 'blocking',
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
        status: 'blocking',
        titleKey: 'recovery.issues.paymentAdjustmentWaitingParent.title',
        summaryKey: 'recovery.issues.paymentAdjustmentWaitingParent.summary',
        guidanceKey: 'recovery.issues.paymentAdjustmentWaitingParent.guidance',
        actions: [createRepairWaitingParentAdjustmentsAction(), createRunParitySyncAction()],
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
        actions: [createRepairOrphanedFinancialAction(), createContactOperatorAction()],
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
        actions: [createContactOperatorAction()],
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
      createContactOperatorAction(),
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
    id: 'sync-fallback-contact-operator',
    code: 'contact_operator_required',
    severity: 'warning',
    status: 'blocking',
    entityType: 'sync',
    entityId: 'fallback',
    titleKey: 'recovery.issues.contactOperatorFallback.title',
    summaryKey: 'recovery.issues.contactOperatorFallback.summary',
    guidanceKey: 'recovery.issues.contactOperatorFallback.guidance',
    actions: [createContactOperatorAction()],
    params: {
      totalBacklog,
      parityTotal,
    },
  };
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
  pushIssue(issues, buildMissingCredentialIssue(systemHealth, lastParitySync));
  pushIssue(issues, buildInvalidOrdersIssue(systemHealth));
  pushIssue(issues, buildParityProcessorIssue(systemHealth, parityItems, lastParitySync));

  for (const issue of buildSyncBlockerIssues(systemHealth)) {
    pushIssue(issues, issue);
  }
  for (const issue of buildParityModuleIssues(parityItems)) {
    pushIssue(issues, issue);
  }
  for (const integrityIssue of integrity?.issues ?? []) {
    pushIssue(issues, buildIntegrityIssue(integrityIssue));
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
