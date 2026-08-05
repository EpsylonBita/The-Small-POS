import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallerIdMinimizedPanel } from '../CallerIdMinimizedPanel';

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('CallerIdMinimizedPanel', () => {
  beforeEach(() => {
    setViewport(1024, 768);
  });

  afterEach(() => {
    cleanup();
  });

  it('portals a non-modal, light/dark themed panel and exposes its actions', () => {
    const onRestore = vi.fn();
    const onClose = vi.fn();

    render(
      <CallerIdMinimizedPanel
        title="Incoming caller"
        phone="+41 77 999 02 14"
        onRestore={onRestore}
        onClose={onClose}
      />,
    );

    const panel = document.body.querySelector('[data-caller-id-minimized-panel]');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('Incoming caller');
    expect(panel).toHaveTextContent('+41 77 999 02 14');
    expect(panel).toHaveClass('bg-white/95', 'dark:bg-[#111318]/95');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Caller ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Caller ID' }));

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports pointer dragging, captures the pointer, and clamps to the viewport', () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    render(
      <CallerIdMinimizedPanel
        title="Incoming caller"
        phone="2101234567"
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const panel = document.body.querySelector<HTMLElement>('[data-caller-id-minimized-panel]');
    const handle = screen.getByLabelText('Move Caller ID panel');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(handle, { setPointerCapture, releasePointerCapture });

    expect(panel?.style.left).toBe('652px');
    expect(panel?.style.top).toBe('88px');

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 7,
      clientX: 700,
      clientY: 100,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 7,
      clientX: -100,
      clientY: -100,
    });
    fireEvent.pointerUp(handle, { pointerId: 7 });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(panel?.style.left).toBe('12px');
    expect(panel?.style.top).toBe('12px');
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('moves with the keyboard and remains visible after a viewport resize', () => {
    render(
      <CallerIdMinimizedPanel
        title="Incoming caller"
        phone="2101234567"
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const panel = document.body.querySelector<HTMLElement>('[data-caller-id-minimized-panel]');
    const handle = screen.getByLabelText('Move Caller ID panel');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
    expect(panel?.style.left).toBe('640px');
    expect(panel?.style.top).toBe('120px');

    setViewport(400, 160);
    act(() => window.dispatchEvent(new Event('resize')));

    expect(panel?.style.left).toBe('28px');
    expect(panel?.style.top).toBe('36px');
  });
});
