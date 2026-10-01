import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Item H, fix review 30/09/2026 (the same decision as Android). The store's
// discount cap and tax rate: a failed read, or a stored value that is not a
// percentage, used to fall back to an assumed 30% / 24% and checkout priced,
// capped and split tax on it. A read error is not "missing": it is
// unavailable and checkout pauses until a read succeeds.

const mock = vi.hoisted(() => ({
  getDiscountMax: vi.fn(),
  getTaxRate: vi.fn(),
}));

vi.mock('../../../lib', () => {
  const bridge = {
    settings: { getDiscountMax: mock.getDiscountMax, getTaxRate: mock.getTaxRate },
  };
  return { getBridge: () => bridge };
});

import { useDiscountSettings } from '../useDiscountSettings';

const settle = async (result: { current: { isLoading: boolean } }) => {
  await waitFor(() => expect(result.current.isLoading).toBe(false));
};

describe('useDiscountSettings when the store settings cannot be read', () => {
  beforeEach(() => {
    mock.getDiscountMax.mockReset();
    mock.getTaxRate.mockReset();
  });

  it('a failed read is unavailable, never an assumed 30% / 24%', async () => {
    mock.getDiscountMax.mockRejectedValue(new Error('SETTING_UNAVAILABLE: database is locked'));
    mock.getTaxRate.mockResolvedValue(13);

    const { result } = renderHook(() => useDiscountSettings());
    await settle(result);

    expect(result.current.unavailable).toBe(true);
    expect(result.current.error).toContain('SETTING_UNAVAILABLE');
  });

  it('a stored value that is not a percentage is unavailable', async () => {
    mock.getDiscountMax.mockResolvedValue(15);
    mock.getTaxRate.mockResolvedValue(Number.NaN);

    const { result } = renderHook(() => useDiscountSettings());
    await settle(result);

    expect(result.current.unavailable).toBe(true);
  });

  it('"Try again" reads the store values once they can be read', async () => {
    mock.getDiscountMax
      .mockRejectedValueOnce(new Error('SETTING_UNAVAILABLE: database is locked'))
      .mockResolvedValue(15);
    mock.getTaxRate.mockResolvedValue(13);

    const { result } = renderHook(() => useDiscountSettings());
    await settle(result);
    expect(result.current.unavailable).toBe(true);

    await act(async () => {
      await result.current.refreshSettings();
    });

    expect(result.current.unavailable).toBe(false);
    expect(result.current.maxDiscountPercentage).toBe(15);
    expect(result.current.taxRatePercentage).toBe(13);
  });

  it('settings that are not stored keep the till defaults the native side answers', async () => {
    mock.getDiscountMax.mockResolvedValue(100);
    mock.getTaxRate.mockResolvedValue(0);

    const { result } = renderHook(() => useDiscountSettings());
    await settle(result);

    expect(result.current.unavailable).toBe(false);
    expect(result.current.maxDiscountPercentage).toBe(100);
    expect(result.current.taxRatePercentage).toBe(0);
  });
});
