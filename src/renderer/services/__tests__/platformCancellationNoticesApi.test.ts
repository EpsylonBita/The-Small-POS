import { describe, expect, it, vi, beforeEach } from 'vitest';

const { posApiGet } = vi.hoisted(() => ({ posApiGet: vi.fn() }));
vi.mock('../../utils/api-helpers', () => ({ posApiGet }));

import { fetchAllCancellationNotices } from '../platformCancellationNoticesApi';

const rawNotice = (id: string) => ({
  id,
  order_number: `#${id}`,
  platform: 'efood',
  external_order_id: null,
  cancelled_at: '2026-09-14T10:00:00.000Z',
});

beforeEach(() => {
  posApiGet.mockReset();
});

describe('fetchAllCancellationNotices', () => {
  it('starts a fresh scan after a rejected expired or reassigned cursor', async () => {
    posApiGet.mockResolvedValueOnce({ success: false, status: 400, error: 'invalid_cursor' });
    expect(await fetchAllCancellationNotices('expired')).toMatchObject({ ok: false, resumeCursor: null });
  });
  it('drains a small backlog to completion (next_cursor: null ends pagination)', async () => {
    posApiGet
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, scope: 's1', notices: [rawNotice('a')], next_cursor: 'c1' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, scope: 's1', notices: [rawNotice('b')], next_cursor: null },
      });

    const result = await fetchAllCancellationNotices();
    expect(result.ok).toBe(true);
    expect(result.incomplete).toBe(false);
    expect(result.notices.map((n) => n.id)).toEqual(['a', 'b']);
    expect(result.resumeCursor).toBeNull();
  });

  it('drains a 51+ page backlog across two calls via resumeCursor instead of restarting at page 1', async () => {
    const pageCount = 55;
    posApiGet.mockImplementation(async (endpoint: string) => {
      const match = /cursor=(c\d+)/.exec(endpoint);
      const pageIndex = match ? Number(match[1].slice(1)) : 0;
      const nextCursor = pageIndex + 1 < pageCount ? `c${pageIndex + 1}` : null;
      return {
        success: true,
        data: {
          success: true,
          scope: 's1',
          notices: [rawNotice(`p${pageIndex}`)],
          next_cursor: nextCursor,
        },
      };
    });

    const first = await fetchAllCancellationNotices(null);
    expect(first.ok).toBe(true);
    expect(first.incomplete).toBe(true);
    expect(first.notices).toHaveLength(50);
    expect(first.resumeCursor).toBe('c50');

    const second = await fetchAllCancellationNotices(first.resumeCursor);
    expect(second.ok).toBe(true);
    expect(second.incomplete).toBe(false);
    expect(second.notices).toHaveLength(5);
    expect(second.notices[0].id).toBe('p50');
  });

  it('fails the page (not silent filtering) when a notice is malformed', async () => {
    posApiGet.mockResolvedValueOnce({
      success: true,
      data: {
        success: true,
        scope: 's1',
        notices: [rawNotice('a'), { id: 'bad' }],
        next_cursor: null,
      },
    });
    const result = await fetchAllCancellationNotices();
    expect(result.ok).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it('treats a missing/undefined next_cursor as malformed, not as end-of-pagination', async () => {
    posApiGet.mockResolvedValueOnce({
      success: true,
      data: { success: true, scope: 's1', notices: [rawNotice('a')] },
    });
    const result = await fetchAllCancellationNotices();
    expect(result.ok).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it('fails on a repeated cursor rather than looping forever', async () => {
    posApiGet.mockResolvedValueOnce({
      success: true,
      data: { success: true, scope: 's1', notices: [rawNotice('a')], next_cursor: null && 'unused' },
    });
    posApiGet.mockReset();
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, scope: 's1', notices: [rawNotice('a')], next_cursor: 'same' },
    });
    const result = await fetchAllCancellationNotices('same');
    expect(result.ok).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it('discards all accumulated notices when the scope changes mid-scan, never attaching old notices to the new scope', async () => {
    posApiGet
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, scope: 's1', notices: [rawNotice('old-1')], next_cursor: 'c1' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, scope: 's2', notices: [rawNotice('new-1')], next_cursor: null },
      });

    const result = await fetchAllCancellationNotices();
    expect(result.ok).toBe(false);
    expect(result.scope).toBe('s2');
    expect(result.notices).toEqual([]);
    expect(result.resumeCursor).toBeNull();
  });

  it('returns ok:false without throwing on a transport error, preserving the retry cursor', async () => {
    posApiGet.mockRejectedValueOnce(new Error('network down'));
    const result = await fetchAllCancellationNotices('resume-here');
    expect(result.ok).toBe(false);
    expect(result.resumeCursor).toBe('resume-here');
  });
});
