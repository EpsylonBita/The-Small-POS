import { beforeEach, describe, expect, it, vi } from 'vitest';

// Incident 2026-09-28: the native customer_create now answers a coded office
// rejection with {success:false, code, status} and queues nothing. The old
// createCustomer unwrapped `result.data ?? result`, so that envelope reached
// the form as if it were a customer. It must reach the form as a rejection.

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  listeners: new Map<string, (payload: any) => void>(),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ customers: { create: mock.create, update: mock.update } }),
  onEvent: (event: string, listener: (payload: any) => void) => mock.listeners.set(event, listener),
  offEvent: (event: string) => mock.listeners.delete(event),
}));
vi.mock('../terminal-credentials', () => ({
  getCachedTerminalCredentials: () => ({ terminalId: 'terminal-1' }),
  refreshTerminalCredentialCache: () => Promise.resolve({ terminalId: 'terminal-1' }),
}));

import { customerService, normalizeCustomerWriteResult } from '../CustomerService';

const customer = { id: '4f0c8d9e-2f7a-4d0b-9a55-0e7f2b3c1a10', name: 'Synthetic', phone: '6948128474' };

/** Whether a customer-created event for `id` is treated as this terminal's own write. */
const isIgnoredAsOwnWrite = (id: string): boolean => {
  const seen = vi.fn();
  const stop = customerService.onCustomerCreated(seen);
  mock.listeners.get('customer-created')?.({ id, updated_by: 'another-terminal' });
  stop();
  return seen.mock.calls.length === 0;
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.listeners.clear();
});

describe('customer write results', () => {
  it('hands a coded rejection to the form instead of unwrapping it', async () => {
    mock.create.mockResolvedValue({
      success: false,
      code: 'INVALID_PHONE',
      errorCode: 'INVALID_PHONE',
      status: 400,
      error: 'INVALID_PHONE',
    });
    const result = await customerService.createCustomer({ name: 'Synthetic', phone: '69481284741' } as any);
    expect(result).toEqual({
      success: false,
      code: 'INVALID_PHONE',
      status: 400,
      conflict: false,
      queued: false,
      offline: false,
      error: 'INVALID_PHONE',
    });
    expect(result.data).toBeUndefined();
  });

  it('returns a saved customer with its queued/offline state and marks it as this terminal’s write', async () => {
    mock.create.mockResolvedValue({ success: true, queued: true, offline: true, warning: 'x', data: customer });
    const result = await customerService.createCustomer({ name: 'Synthetic', phone: '6948128474' } as any);
    expect(result).toMatchObject({ success: true, data: customer, queued: true, offline: true, code: null });
    expect(isIgnoredAsOwnWrite(customer.id)).toBe(true);
  });

  it('does not mark a rejected write as this terminal’s', async () => {
    // An envelope that carries an id (older native conflict shapes do) was
    // unwrapped and tracked as a created customer before.
    mock.create.mockResolvedValue({ success: false, code: 'DUPLICATE', status: 409, data: { id: 'rejected-id' } });
    const result = await customerService.createCustomer({ name: 'Synthetic', phone: '6948128474' } as any);
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(isIgnoredAsOwnWrite('rejected-id')).toBe(false);
  });

  it('marks a version conflict from older native code as VERSION_MISMATCH', async () => {
    mock.update.mockResolvedValue({ success: false, conflict: true, error: 'Version conflict', data: { id: 'cc-1' } });
    const result = await customerService.updateCustomer(customer.id, { name: 'X' } as any, 3);
    expect(result).toMatchObject({ success: false, conflict: true, code: 'VERSION_MISMATCH' });
    expect(mock.update).toHaveBeenCalledWith(customer.id, { name: 'X' }, 3);
  });

  it('reads the current rejection envelope of an update', async () => {
    mock.update.mockResolvedValue({
      success: false, code: 'VERSION_MISMATCH', errorCode: 'VERSION_MISMATCH', status: 409, error: 'VERSION_MISMATCH', conflict: true,
    });
    const result = await customerService.updateCustomer(customer.id, { name: 'X' } as any, 3);
    expect(result).toMatchObject({ success: false, conflict: true, code: 'VERSION_MISMATCH', status: 409 });
  });

  it('never echoes unbounded or display text as a code', () => {
    expect(normalizeCustomerWriteResult({ success: false, code: 'The phone number is invalid' }).code).toBeNull();
    expect(normalizeCustomerWriteResult({ success: false, errorCode: 'not_found' }).code).toBe('NOT_FOUND');
    expect(normalizeCustomerWriteResult(null)).toMatchObject({ success: false, code: null });
    expect(normalizeCustomerWriteResult({ success: true, data: null })).toMatchObject({ success: true, data: undefined });
  });
});
