import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  acknowledgeNotice,
  loadPendingNotices,
  mergeIncomingNotices,
  type CancellationNoticeIdentity,
  type PlatformCancellationNotice,
} from '../platformCancellationNoticeStore';

const identity: CancellationNoticeIdentity = {
  organizationId: 'org-1',
  branchId: 'branch-1',
  terminalId: 'terminal-1',
};

const notice = (id: string, overrides: Partial<PlatformCancellationNotice> = {}): PlatformCancellationNotice => ({
  id,
  order_number: `#${id}`,
  platform: 'efood',
  external_order_id: null,
  cancelled_at: '2026-09-14T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('platformCancellationNoticeStore', () => {
  it('merges incoming notices and persists them durably', async () => {
    const result = await mergeIncomingNotices(identity, 'scope-a', [notice('n1'), notice('n2')]);
    expect(result.ok).toBe(true);
    expect(result.pending.map((n) => n.id).sort()).toEqual(['n1', 'n2']);

    const restored = await loadPendingNotices(identity);
    expect(restored.ok).toBe(true);
    expect(restored.scope).toBe('scope-a');
    expect(restored.pending.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('does not resurrect an already-acknowledged notice on a later merge (dedupe/restart)', async () => {
    await mergeIncomingNotices(identity, 'scope-a', [notice('n1')]);
    const ack = await acknowledgeNotice(identity, 'scope-a', 'n1');
    expect(ack.ok).toBe(true);
    expect(ack.pending).toEqual([]);

    const remerged = await mergeIncomingNotices(identity, 'scope-a', [notice('n1')]);
    expect(remerged.ok).toBe(true);
    expect(remerged.pending).toEqual([]);

    const restored = await loadPendingNotices(identity);
    expect(restored.pending).toEqual([]);
    expect(restored.ackedIds.has('n1')).toBe(true);
  });

  it('restores pending fully offline after a restart (no network involved)', async () => {
    await mergeIncomingNotices(identity, 'scope-a', [notice('n1'), notice('n2')]);
    const restored = await loadPendingNotices(identity);
    expect(restored.ok).toBe(true);
    expect(restored.pending).toHaveLength(2);
  });

  it('fails acknowledgeNotice when the stored scope differs from the caller scope, without overwriting it', async () => {
    await mergeIncomingNotices(identity, 'scope-a', [notice('n1')]);
    const ack = await acknowledgeNotice(identity, 'scope-b', 'n1');
    expect(ack.ok).toBe(false);

    const restored = await loadPendingNotices(identity);
    expect(restored.scope).toBe('scope-a');
    expect(restored.pending.map((n) => n.id)).toEqual(['n1']);
    expect(restored.ackedIds.has('n1')).toBe(false);
  });

  it('fails acknowledgeNotice when nothing is stored yet for this scope', async () => {
    const ack = await acknowledgeNotice(identity, 'scope-a', 'n1');
    expect(ack.ok).toBe(false);
  });

  it('resets to the new scope on a scope change instead of leaking old-scope pending forward', async () => {
    await mergeIncomingNotices(identity, 'scope-a', [notice('n1')]);
    const merged = await mergeIncomingNotices(identity, 'scope-b', [notice('n2')]);
    expect(merged.ok).toBe(true);
    expect(merged.pending.map((n) => n.id)).toEqual(['n2']);

    const restored = await loadPendingNotices(identity);
    expect(restored.scope).toBe('scope-b');
    expect(restored.pending.map((n) => n.id)).toEqual(['n2']);
  });

  it('serializes concurrent merge/ack writes without losing an update (race safety)', async () => {
    await mergeIncomingNotices(identity, 'scope-a', [notice('n1'), notice('n2')]);
    const [ack, merge] = await Promise.all([
      acknowledgeNotice(identity, 'scope-a', 'n1'),
      mergeIncomingNotices(identity, 'scope-a', [notice('n3')]),
    ]);
    expect(ack.ok).toBe(true);
    expect(merge.ok).toBe(true);

    const restored = await loadPendingNotices(identity);
    const ids = restored.pending.map((n) => n.id).sort();
    expect(ids).not.toContain('n1');
    expect(ids).toContain('n2');
    expect(ids).toContain('n3');
  });

  it('fails safely without throwing when storage write quota is exceeded', async () => {
    const setItemSpy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const result = await mergeIncomingNotices(identity, 'scope-a', [notice('n1')]);
    expect(result.ok).toBe(false);
    setItemSpy.mockRestore();
  });

  it('fails safely without throwing when stored content is malformed JSON', async () => {
    window.localStorage.setItem(
      'pos:platform-cancellation-notices:v1:org-1:branch-1:terminal-1',
      '{not-json',
    );
    const restored = await loadPendingNotices(identity);
    expect(restored.ok).toBe(false);
    expect(restored.pending).toEqual([]);
  });

  it('drops invalid notice shapes rather than storing them', async () => {
    const result = await mergeIncomingNotices(identity, 'scope-a', [
      notice('n1'),
      { id: 'bad' } as unknown as PlatformCancellationNotice,
    ]);
    expect(result.pending.map((n) => n.id)).toEqual(['n1']);
  });
});
