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

  it('restores the exact persisted checkout ID and refuses another identity for that cart', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    result.current.restore('original-request');
    expect(result.current.take('original-request')).toBe('original-request');
    expect(() => result.current.take('different-request')).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
  });

  it('starts a new checkout after it ends', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    const first = result.current.take();
    result.current.reset();
    expect(result.current.take()).not.toBe(first);
  });

  it.each(['editing', 'checkout_pending'] as const)('does not claim a create identity when restoring a %s order edit', phase => {
    const { result, rerender } = renderHook(() => useCheckoutRequestId());
    result.current.restore('prior-edit-event', { phase, editMode: true });
    rerender();
    expect(result.current.take('new-delivery-checkout')).toBe('new-delivery-checkout');
    expect(() => result.current.take('another-checkout')).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
  });

  it('releases only an unsubmitted restored editor when it is dismissed', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    result.current.restore('editable-create', { phase: 'editing' });
    result.current.dismiss();
    expect(result.current.take('next-create')).toBe('next-create');
    result.current.dismiss();
    expect(() => result.current.take('another-create')).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
  });

  it('keeps a restored pending create locked across close, rerender, and edit restoration', () => {
    const { result, rerender } = renderHook(() => useCheckoutRequestId());
    result.current.restore('confirmed-create', { phase: 'checkout_pending' });
    result.current.dismiss();
    result.current.restore('other-edit', { phase: 'editing', editMode: true });
    rerender();
    expect(() => result.current.take('different-create')).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
    expect(() => result.current.restore('different-create', { phase: 'editing' })).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
    expect(result.current.take('confirmed-create')).toBe('confirmed-create');
  });

  it('never downgrades a claimed create when stale editable context is restored', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    result.current.restore('original-create', { phase: 'editing' });
    result.current.take('original-create');
    result.current.restore('original-create', { phase: 'editing' });
    result.current.dismiss();
    expect(() => result.current.take('replacement')).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
  });

  it('renews only the exact declined attempt after the live native CAS proof', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    result.current.restore('declined-card', { phase: 'checkout_pending' });
    expect(() => result.current.restore('new-card', { phase: 'editing', renewedFrom: 'other-card' })).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
    expect(() => result.current.restore('new-card', { phase: 'checkout_pending', renewedFrom: 'declined-card' })).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
    expect(result.current.take('declined-card')).toBe('declined-card');
    result.current.restore('new-card', { phase: 'editing', renewedFrom: 'declined-card' });
    result.current.restore('new-card', { phase: 'editing' });
    expect(result.current.take('new-card')).toBe('new-card');
    expect(() => result.current.take('declined-card')).toThrow('CHECKOUT_REQUEST_ID_CHANGED');
  });

  it('can discard an editable renewed attempt without reusing the declined identity', () => {
    const { result } = renderHook(() => useCheckoutRequestId());
    result.current.restore('declined-card', { phase: 'checkout_pending' });
    result.current.restore('renewed-card', { phase: 'editing', renewedFrom: 'declined-card' });
    result.current.dismiss();
    expect(result.current.take('new-cart')).toBe('new-cart');
  });
});
