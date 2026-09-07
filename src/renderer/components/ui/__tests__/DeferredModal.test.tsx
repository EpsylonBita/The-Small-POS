import React, { lazy, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeferredModal } from '../DeferredModal';

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key === 'common.loading' ? 'Loading...' : 'Close' }),
}));
vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));

afterEach(cleanup);

function deferredModal() {
  const Component = ({ isOpen }: { isOpen: boolean }) => isOpen ? <div role="dialog" aria-label="Loaded modal">Ready</div> : null;
  let resolve!: (value: { default: typeof Component }) => void;
  const promise = new Promise<{ default: typeof Component }>((done) => { resolve = done; });
  const load = vi.fn(() => promise);
  return { Component: lazy(load), load, resolve: () => resolve({ default: Component }), promise };
}

describe('DeferredModal', () => {
  it('does not start the lazy import until the first open', async () => {
    const deferred = deferredModal();
    const Host = ({ isOpen }: { isOpen: boolean }) => (
      <DeferredModal isOpen={isOpen} onClose={vi.fn()}><deferred.Component isOpen={isOpen} /></DeferredModal>
    );
    const { rerender } = render(<Host isOpen={false} />);
    expect(deferred.load).not.toHaveBeenCalled();

    rerender(<Host isOpen />);
    expect(deferred.load).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: 'Loading...' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(document.querySelector('.liquid-glass-modal-viewport--solid')).not.toBeNull();

    await act(async () => { deferred.resolve(); await deferred.promise; });
    expect(screen.getByRole('dialog', { name: 'Loaded modal' })).toBeInTheDocument();
  });

  it('allows cancellation while loading and does not reopen when the import resolves', async () => {
    const deferred = deferredModal();
    const onClose = vi.fn();
    function Host() {
      const [isOpen, setOpen] = useState(true);
      return <DeferredModal isOpen={isOpen} onClose={() => { onClose(); setOpen(false); }}>
        <deferred.Component isOpen={isOpen} />
      </DeferredModal>;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { deferred.resolve(); await deferred.promise; });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body).not.toHaveClass('pos-modal-open');
  });

  it('keeps the same child instance and its state across close and reopen', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Child({ isOpen }: { isOpen: boolean }) {
      const [count, setCount] = useState(0);
      useEffect(() => { mounted(); return unmounted; }, []);
      return isOpen ? <button onClick={() => setCount(count + 1)}>Count {count}</button> : null;
    }
    const Host = ({ isOpen }: { isOpen: boolean }) => (
      <DeferredModal isOpen={isOpen} onClose={vi.fn()}><Child isOpen={isOpen} /></DeferredModal>
    );
    const { rerender } = render(<Host isOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    rerender(<Host isOpen={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(unmounted).not.toHaveBeenCalled();
    rerender(<Host isOpen />);
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeInTheDocument();
    expect(mounted).toHaveBeenCalledOnce();
  });
});
