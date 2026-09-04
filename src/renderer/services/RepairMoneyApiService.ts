import { z } from 'zod';
import { getBridge } from '../../lib';
import type {
  RepairMoneyRequest,
  RepairMoneyRequestInput,
} from '../features/repairs/contracts';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const repairSettlementOrderSchema = z.object({
  id: z.string().uuid(),
  order_number: z.string().min(1).max(128).nullable(),
  role: z.enum(['primary', 'supplement', 'credit']),
  fiscal_state: z.enum([
    'deferred',
    'issue_pending',
    'issued',
    'unknown',
    'issue_failed',
    'correction_pending',
    'cancelled',
    'recognized_non_fiscal',
  ]),
  payment_status: z.string().min(1).max(48),
  total_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const repairSettlementPaymentSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  payment_method: z.string().min(1).max(48),
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  refunded_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  refundable_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.string().min(1).max(48),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((payment, context) => {
  if (payment.refunded_minor > payment.amount_minor) {
    context.addIssue({
      code: 'custom',
      path: ['refunded_minor'],
      message: 'refunded amount cannot exceed payment amount',
    });
  }
  const expectedRefundable = payment.status === 'completed'
    ? payment.amount_minor - payment.refunded_minor
    : 0;
  if (payment.refundable_minor !== expectedRefundable) {
    context.addIssue({
      code: 'custom',
      path: ['refundable_minor'],
      message: 'refundable amount does not reconcile',
    });
  }
});

const repairSettlementAdjustmentSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  adjustment_type: z.enum(['void', 'refund']),
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  refund_method: z.enum(['cash', 'card']),
  created_at: z.string().datetime({ offset: true }),
}).strict();

const repairSettlementFiscalCommandSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  purpose: z.enum(['sale', 'deposit', 'supplement', 'credit', 'cancel']),
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.string().min(1).max(48),
  attempt_count: z.number().int().nonnegative().max(1_000_000),
  occurred_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict();

export const repairFinancialProjectionSchema = z.object({
  repair_id: z.string().uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  paid_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  refunded_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  balance_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  orders: z.array(repairSettlementOrderSchema).max(100),
  payments: z.array(repairSettlementPaymentSchema).max(500),
  adjustments: z.array(repairSettlementAdjustmentSchema).max(500),
  fiscal_commands: z.array(repairSettlementFiscalCommandSchema).max(500),
}).strict().superRefine((projection, context) => {
  const orderIds = new Set(projection.orders.map((order) => order.id));
  const paymentById = new Map(projection.payments.map((payment) => [payment.id, payment]));
  const refundedByPayment = new Map<string, number>();
  let signedTotal = 0;
  let paidTotal = 0;
  let refundedTotal = 0;

  for (const order of projection.orders) {
    signedTotal += order.role === 'credit' ? -order.total_minor : order.total_minor;
  }
  for (const payment of projection.payments) {
    if (!orderIds.has(payment.order_id)) {
      context.addIssue({
        code: 'custom',
        path: ['payments'],
        message: 'payment order is outside the settlement',
      });
    }
    if (payment.status === 'completed') paidTotal += payment.amount_minor;
  }
  for (const adjustment of projection.adjustments) {
    const payment = paymentById.get(adjustment.payment_id);
    if (!payment || payment.order_id !== adjustment.order_id) {
      context.addIssue({
        code: 'custom',
        path: ['adjustments'],
        message: 'adjustment payment is outside the settlement order',
      });
    }
    const paymentRefunded = (refundedByPayment.get(adjustment.payment_id) ?? 0)
      + adjustment.amount_minor;
    refundedByPayment.set(adjustment.payment_id, paymentRefunded);
    refundedTotal += adjustment.amount_minor;
  }
  for (const command of projection.fiscal_commands) {
    if (!orderIds.has(command.order_id)) {
      context.addIssue({
        code: 'custom',
        path: ['fiscal_commands'],
        message: 'fiscal command order is outside the settlement',
      });
    }
  }
  for (const payment of projection.payments) {
    if (payment.refunded_minor !== (refundedByPayment.get(payment.id) ?? 0)) {
      context.addIssue({
        code: 'custom',
        path: ['payments'],
        message: 'payment refund total does not reconcile',
      });
    }
  }

  const expectedBalance = Math.max(0, signedTotal - paidTotal + refundedTotal);
  const reconciled = [signedTotal, paidTotal, refundedTotal, expectedBalance]
    .every(Number.isSafeInteger);
  if (!reconciled
    || projection.total_minor !== signedTotal
    || projection.paid_minor !== paidTotal
    || projection.refunded_minor !== refundedTotal
    || projection.balance_minor !== expectedBalance) {
    context.addIssue({
      code: 'custom',
      path: ['balance_minor'],
      message: 'financial projection does not reconcile',
    });
  }
});

export type RepairFinancialProjection = z.infer<typeof repairFinancialProjectionSchema>;

export interface RepairMoneyIntentBase {
  operation_id: string;
  repair_id: string;
  expected_version: number;
  occurred_at: string;
}

export interface RepairEmptyMoneyIntent extends RepairMoneyIntentBase {
  payload: Record<string, never>;
}

export interface RepairPaymentIntent extends RepairMoneyIntentBase {
  payload: {
    amount_minor: number;
    payment_method: 'cash' | 'card' | 'digital_wallet' | 'other';
    provider_reference?: string;
  };
}

export interface RepairRefundIntent extends RepairMoneyIntentBase {
  payload: {
    payment_id: string;
    amount_minor: number;
    refund_method: 'cash' | 'card';
    reason: string;
  };
}

export interface RepairDeliveryIntent extends RepairMoneyIntentBase {
  payload: { reason?: string | null };
}

export type RepairMoneyResult = Record<string, unknown> & {
  repair?: { repair_id: string; status: string; version: number };
  was_replay?: boolean;
  reporting_shift_id?: string | null;
  reporting_projection?: RepairReportingProjection | null;
};

export interface RepairReportingProjection {
  source: 'repair_canonical_tender_projection_v1';
  staff_shift_id: string;
  projection_version: number;
  projected_at: string;
  overall_tender: number;
  overall_cash: number;
  overall_card: number;
  overall_orders_count: number;
  repair_tender: number;
  repair_cash: number;
  repair_card: number;
  repair_orders_count: number;
}

interface RepairMoneySessionBridge {
  staffAuth: { getSession(): Promise<unknown> };
  repairs: { moneyRequest(input: RepairMoneyRequestInput): Promise<unknown> };
}

type RepairMoneyPostCommand =
  | {
    action: 'settlement' | 'fiscalize';
    intent: RepairEmptyMoneyIntent;
  }
  | {
    action: 'payments';
    intent: RepairPaymentIntent;
  }
  | {
    action: 'refunds';
    intent: RepairRefundIntent;
  }
  | {
    action: 'delivery';
    intent: RepairDeliveryIntent;
  };

function isSecureSession(value: unknown): value is { sessionId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && CANONICAL_UUID.test(sessionId);
}

export class RepairMoneyApiService {
  constructor(private readonly bridge: RepairMoneySessionBridge = getBridge()) {}

  private async staffSessionId(): Promise<string> {
    const session = await this.bridge.staffAuth.getSession();
    if (!isSecureSession(session)) throw new Error('REPAIR_STAFF_SESSION_REQUIRED');
    return session.sessionId;
  }

  async getSettlement(repairId: string): Promise<RepairFinancialProjection> {
    const staffSessionId = await this.staffSessionId();
    let data: unknown;
    try {
      data = await this.bridge.repairs.moneyRequest({
        staffSessionId,
        request: { action: 'financial_projection', repair_id: repairId },
      });
    } catch (error) {
      throw new Error(error instanceof Error
        ? error.message
        : String(error || 'REPAIR_FINANCIAL_PROJECTION_UNAVAILABLE'));
    }
    const parsed = repairFinancialProjectionSchema.safeParse(data);
    if (!parsed.success || parsed.data.repair_id !== repairId) {
      throw new Error('REPAIR_FINANCIAL_PROJECTION_INVALID');
    }
    return parsed.data;
  }

  private async post(command: RepairMoneyPostCommand) {
    const { action, intent } = command;
    const staffSessionId = await this.staffSessionId();
    const base = {
      repair_id: intent.repair_id,
      operation_id: intent.operation_id,
      expected_version: intent.expected_version,
      occurred_at: intent.occurred_at,
    };
    let request: RepairMoneyRequest;
    switch (action) {
      case 'settlement':
      case 'fiscalize':
        request = { action, ...base };
        break;
      case 'payments': {
        const payment = command.intent;
        request = {
          action: 'payment',
          ...base,
          amount_minor: payment.payload.amount_minor,
          payment_method: payment.payload.payment_method,
          ...(payment.payload.provider_reference
            ? { provider_reference: payment.payload.provider_reference }
            : {}),
        };
        break;
      }
      case 'refunds': {
        const refund = command.intent;
        request = { action: 'refund', ...base, ...refund.payload };
        break;
      }
      case 'delivery': {
        const delivery = command.intent;
        request = {
          action: 'delivery',
          ...base,
          ...(delivery.payload.reason == null ? {} : { reason: delivery.payload.reason }),
        };
        break;
      }
    }
    // Native-owned and online-only: no generic admin proxy and no local money queue.
    let response: {
      success: boolean;
      data?: RepairMoneyResult;
      error?: string;
      status: number;
    };
    try {
      response = {
        success: true,
        data: await this.bridge.repairs.moneyRequest({ staffSessionId, request }) as RepairMoneyResult,
        status: 200,
      };
    } catch (error) {
      response = {
        success: false,
        error: error instanceof Error ? error.message : String(error || 'REPAIR_MONEY_REQUEST_FAILED'),
        status: 0,
      };
    }
    const projection = response.data?.reporting_projection;
    const mutatesTender = action === 'payments' || action === 'refunds';
    if (response.success && mutatesTender) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (!projection) {
          throw new Error('repair reporting projection is unavailable');
        }
        await invoke('repair_reporting_projection_apply', { projection });
      } catch (error) {
        // The canonical money mutation already committed remotely. Leave the
        // local Z fail-closed until a later authoritative projection sync.
        console.error('[RepairMoneyApiService] reporting projection cache failed', error);
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const invalidated = await invoke<boolean>('repair_reporting_projection_invalidate', {
            staffShiftId:
              projection?.staff_shift_id ?? response.data?.reporting_shift_id ?? null,
          });
          if (!invalidated) {
            throw new Error('repair reporting shift could not be invalidated');
          }
        } catch (invalidationError) {
          console.error(
            '[RepairMoneyApiService] reporting projection invalidation failed',
            invalidationError,
          );
          throw new Error('REPAIR_REPORTING_EVIDENCE_REQUIRED');
        }
      }
    }
    return response;
  }

  createOrRefreshSettlement(intent: RepairEmptyMoneyIntent) {
    return this.post({ action: 'settlement', intent });
  }

  recordPayment(intent: RepairPaymentIntent) {
    return this.post({ action: 'payments', intent });
  }

  recordRefund(intent: RepairRefundIntent) {
    return this.post({ action: 'refunds', intent });
  }

  fiscalize(intent: RepairEmptyMoneyIntent) {
    return this.post({ action: 'fiscalize', intent });
  }

  deliver(intent: RepairDeliveryIntent) {
    return this.post({ action: 'delivery', intent });
  }
}

export const repairMoneyApiService = new RepairMoneyApiService();
