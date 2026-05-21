import { getSyncQueueBridge } from '../services/SyncQueueBridge';
import { getCachedTerminalCredentials } from '../services/terminal-credentials';

type SyncOperation = 'INSERT' | 'UPDATE' | 'DELETE';

interface QueueContext {
  organizationId?: string | null;
  branchId?: string | null;
}

interface QueueInput extends QueueContext {
  tableName: string;
  recordId: string;
  operation: SyncOperation;
  payload: Record<string, unknown>;
  priority?: number;
}

function stableId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function withTerminalContext(
  payload: Record<string, unknown>,
  context: QueueContext,
): Record<string, unknown> {
  const cached = getCachedTerminalCredentials();
  const terminalId = cached.terminalId || null;
  const branchId = context.branchId || cached.branchId || null;
  const organizationId = context.organizationId || cached.organizationId || null;

  return {
    ...payload,
    ...(terminalId ? { terminalId, terminal_id: terminalId } : {}),
    ...(branchId ? { branchId, branch_id: branchId } : {}),
    ...(organizationId ? { organizationId, organization_id: organizationId } : {}),
  };
}

export function isRetryableTableServiceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('offline') ||
    normalized.includes('network') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('requires an online connection') ||
    normalized.includes('waiting for parent order sync')
  );
}

export async function enqueueTableServiceOperation(input: QueueInput): Promise<string> {
  const cached = getCachedTerminalCredentials();
  const organizationId =
    input.organizationId ||
    cached.organizationId ||
    String(input.payload.organization_id || input.payload.organizationId || 'pending-org');
  const payload = withTerminalContext(input.payload, input);

  return getSyncQueueBridge().enqueue({
    tableName: input.tableName,
    recordId: input.recordId,
    operation: input.operation,
    data: JSON.stringify(payload),
    organizationId,
    priority: input.priority ?? 0,
    moduleType: 'table_service',
    conflictStrategy: 'server-wins',
    version: 1,
  });
}

export function enqueueTableSessionOpen(input: QueueContext & {
  payload: Record<string, unknown>;
}): Promise<string> {
  const clientEventId =
    typeof input.payload.client_event_id === 'string'
      ? input.payload.client_event_id
      : `pos-tauri-table-session-${stableId('open')}`;
  return enqueueTableServiceOperation({
    ...input,
    tableName: 'restaurant_table_sessions',
    recordId: clientEventId,
    operation: 'INSERT',
    payload: {
      ...input.payload,
      client_event_id: clientEventId,
    },
    priority: 5,
  });
}

export function enqueueTableSessionUpdate(input: QueueContext & {
  sessionId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  return enqueueTableServiceOperation({
    ...input,
    tableName: 'restaurant_table_sessions',
    recordId: input.sessionId,
    operation: 'UPDATE',
    payload: input.payload,
  });
}

export function enqueueTableItemTransfer(input: QueueContext & {
  sourceSessionId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const clientEventId =
    typeof input.payload.client_event_id === 'string'
      ? input.payload.client_event_id
      : `pos-tauri-table-item-transfer-${stableId('transfer')}`;
  return enqueueTableServiceOperation({
    ...input,
    tableName: 'restaurant_table_session_item_transfers',
    recordId: input.sourceSessionId,
    operation: 'INSERT',
    payload: {
      ...input.payload,
      source_session_id: input.sourceSessionId,
      client_event_id: clientEventId,
    },
  });
}

export function enqueueTablePayment(input: QueueContext & {
  payload: Record<string, unknown>;
}): Promise<string> {
  const recordId =
    typeof input.payload.idempotency_key === 'string'
      ? input.payload.idempotency_key
      : `pos-tauri-table-payment-${stableId('payment')}`;
  return enqueueTableServiceOperation({
    ...input,
    tableName: 'payments',
    recordId,
    operation: 'INSERT',
    payload: {
      ...input.payload,
      idempotency_key: recordId,
    },
    priority: 1,
  });
}
