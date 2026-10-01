import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// Fix review 30/09/2026 (double charge on a slow card terminal): every press
// of Pay for the same cart carries the same checkout id until the checkout
// ends, so the till recognises the same payment and never charges twice.

import { useCheckoutRequestId } from '../useCheckoutRequestId';

describe('useCheckoutRequestId', () => {
  it('gives every press of the same checkout the same id', () => {
    const { result, rerender } = renderHook(() => useCheckoutRequestId());
    const first = result.current.take();
    rerender();
    expect(result.current.take()).toBe(first);
    expect(first).toMatch(/\S{8,}/);
  });

  it('starts a new checkout after it ends', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    const first = result.current.take();
    result.current.reset();
    expect(result.current.take()).not.toBe(first);
  });
});
