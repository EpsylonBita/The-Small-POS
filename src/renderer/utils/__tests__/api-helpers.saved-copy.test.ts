import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop 1.4.124 (fix 8). Symptom: with the office unreachable (offline,
// timeout, 5xx) the Integrations page showed a lapsed Wolt licence as
// "Connected". Root cause: the native bridge answers a cacheable GET with the
// copy this till saved (`meta.source: 'cache'`, `offlineFallback: true`), and
// posApiFetch dropped that marker, so every caller read the copy as the
// office's current answer. The marker now reaches the caller; the result
// stays `success: true` because offline readers (fiscal entitlement, Z
// report, printing) rely on the saved copy.

const bridge = vi.hoisted(() => ({ fetchFromAdmin: vi.fn() }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({
    adminApi: { fetchFromAdmin: bridge.fetchFromAdmin },
    terminalConfig: { getTerminalId: vi.fn(async () => 'terminal-1') },
  }),
}));
vi.mock('../../../config/environment', () => ({
  getApiUrl: (endpoint: string) => `https://admin.example/api/${endpoint.replace(/^\/+/, '')}`,
}));

import { posApiGet, posApiPatch, posApiPost } from '../api-helpers';

const SAVED_AT = '2026-10-05T09:30:00.000Z';
const list = { branch_id: 'branch-1', integrations: [{ provider: 'wolt', is_purchased: true, status: 'connected' }] };

describe('posApiFetch over the native bridge', () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    bridge.fetchFromAdmin.mockReset();
  });
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('keeps the saved-copy marker of an answer served from this till', async () => {
    bridge.fetchFromAdmin.mockResolvedValue({
      success: true,
      data: list,
      status: 200,
      meta: { source: 'cache', cachedAt: SAVED_AT, offlineFallback: true, path: '/api/pos/integrations' },
    });

    const result = await posApiGet('/pos/integrations');

    expect(result).toMatchObject({ success: true, data: list, stale: true, source: 'cache', cachedAt: SAVED_AT });
  });

  it('treats either half of the marker as a saved copy, even without a time', async () => {
    for (const meta of [{ offlineFallback: true }, { source: 'cache' }]) {
      bridge.fetchFromAdmin.mockResolvedValueOnce({ success: true, data: list, status: 200, meta });
      expect(await posApiGet('/pos/integrations')).toMatchObject({ success: true, stale: true, source: 'cache', cachedAt: null });
    }
  });

  it('marks the office answer as current', async () => {
    bridge.fetchFromAdmin.mockResolvedValue({ success: true, data: list, status: 200, meta: { source: 'remote' } });

    const result = await posApiGet('/pos/integrations');

    expect(result).toMatchObject({ success: true, data: list, stale: false, source: 'remote' });
    expect(result.cachedAt).toBeUndefined();
  });

  it('forwards the office refusal code and status', async () => {
    bridge.fetchFromAdmin.mockResolvedValue({
      success: false,
      status: 409,
      code: 'SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS',
      error: 'Invoice amount cannot change after a payment has been recorded (HTTP 409)',
    });

    const result = await posApiPatch('pos/supplier-invoices/A', { amount: 30 });

    expect(result).toMatchObject({ success: false, status: 409, code: 'SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS' });
  });

  it.each(['TABLE_MUTATION_BLOCKED', 'TABLE_MUTATION_RETAINED', 'TABLE_MUTATION_REFUSED'])('preserves %s before broad transport normalization', async code => {
    const error = `${code}: network connection timeout (HTTP 500)`;
    bridge.fetchFromAdmin.mockResolvedValue({ success: false, code, error, status: 500 });
    expect(await posApiPost('/api/pos/table-sessions/check/items/transfer', { client_event_id: 'original' }))
      .toMatchObject({ success: false, code, error, status: 500 });
    expect(bridge.fetchFromAdmin).toHaveBeenCalledWith('/api/pos/table-sessions/check/items/transfer',
      expect.objectContaining({ method: 'POST', body: '{"client_event_id":"original"}' }));
  });

  it('preserves a native string rejection carrying its retained-original outcome', async () => {
    const error = 'TABLE_MUTATION_RETAINED: connection timed out';
    bridge.fetchFromAdmin.mockRejectedValue(error);
    expect(await posApiPatch('/api/pos/table-sessions/check', { action: 'move_table' }))
      .toMatchObject({ success: false, error });
  });

  it('forwards the native transaction count for a proven refused batch', async () => {
    bridge.fetchFromAdmin.mockResolvedValue({ success: false, code: 'TABLE_MUTATION_REFUSED',
      error: 'TABLE_MUTATION_REFUSED: network conflict', batch: { quarantined_count: 2 } });
    expect(await posApiPost('/api/pos/table-sessions/check/items/transfer', { client_event_id: 'original' }))
      .toMatchObject({ success: false, error: 'TABLE_MUTATION_REFUSED: network conflict', tableMutationQuarantinedCount: 2 });
  });

  it.each([
    ['TABLE_MUTATION_REFUSED', 'TABLE_MUTATION_REFUSED: stopped', 0],
    ['TABLE_MUTATION_REFUSED', 'TABLE_MUTATION_REFUSED: stopped', '2'],
    ['TABLE_MUTATION_REFUSED', 'TABLE_MUTATION_REFUSED: stopped', 1.5],
    ['TABLE_MUTATION_RETAINED', 'TABLE_MUTATION_RETAINED: timeout', 2],
    [undefined, 'TABLE_MUTATION_REFUSED: stopped', 2],
    ['TABLE_MUTATION_REFUSED', 'Server text mentions TABLE_MUTATION_REFUSED', 2],
  ])('rejects unproved suffix metadata (%s / %s / %s)', async (code, error, count) => {
    bridge.fetchFromAdmin.mockResolvedValue({ success: false, code, error, batch: { quarantined_count: count } });
    const result = await posApiPost('/api/pos/table-sessions/check/items/transfer', { client_event_id: 'original' });
    expect(result.tableMutationQuarantinedCount).toBeUndefined();
  });
});

describe('posApiFetch in a browser', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('marks the answer as current and forwards a refusal code', async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('supplier-invoices')
      ? new Response(JSON.stringify({ success: false, code: 'SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS', error: 'Invoice amount cannot change' }), { status: 409 })
      : new Response(JSON.stringify(list), { status: 200 })) as typeof fetch;

    expect(await posApiGet('/pos/integrations')).toMatchObject({ success: true, data: list, stale: false, source: 'remote' });
    expect(await posApiPatch('pos/supplier-invoices/A', { amount: 30 })).toMatchObject({
      success: false, status: 409, code: 'SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS',
    });
  });

  it('does not turn server suffix metadata into native transaction proof', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'TABLE_MUTATION_REFUSED',
      error: 'TABLE_MUTATION_REFUSED: server text', batch: { quarantined_count: 2 } }), { status: 409 })) as typeof fetch;
    expect((await posApiPost('/api/pos/table-sessions/check/items/transfer', {})).tableMutationQuarantinedCount).toBeUndefined();
  });
});
