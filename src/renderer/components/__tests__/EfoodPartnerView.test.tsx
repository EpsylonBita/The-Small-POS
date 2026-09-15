import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge } = vi.hoisted(() => ({
  bridge: {
    show: vi.fn(),
    park: vi.fn(),
    navigate: vi.fn(),
    ensure: vi.fn(),
    close: vi.fn(),
    setMuted: vi.fn(),
  },
}));
vi.mock('../../services/efoodPartner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/efoodPartner')>();
  return { ...actual, efoodPartnerBridge: bridge };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  }),
}));

import { EfoodPartnerView } from '../EfoodPartnerView';

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

const RECT = { left: 120.2, top: 40.8, width: 900.4, height: 611.1, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };

async function flush() {
  await act(async () => Promise.resolve());
}

describe('EfoodPartnerView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ResizeObserverStub.instances = [];
    (globalThis as any).ResizeObserver = ResizeObserverStub;
    bridge.show.mockResolvedValue({ success: true, exists: true, parked: false, url: 'https://partner-app.e-food.gr/live-orders' });
    bridge.park.mockResolvedValue({ success: true });
    bridge.navigate.mockResolvedValue({ success: true });
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT as DOMRect);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the efood page over its surface when it mounts and parks it again when it unmounts', async () => {
    const view = render(<EfoodPartnerView />);
    await flush();

    expect(bridge.show).toHaveBeenCalledWith(
      { x: 120, y: 41, width: 900, height: 611 },
      { muted: false },
    );
    expect(screen.getByTestId('efood-partner-surface')).toBeInTheDocument();

    view.unmount();
    expect(bridge.park).toHaveBeenCalledTimes(1);
  });

  it('re-sends the bounds when its surface is resized', async () => {
    render(<EfoodPartnerView />);
    await flush();
    expect(bridge.show).toHaveBeenCalledTimes(1);

    await act(async () => {
      ResizeObserverStub.instances[0].callback([], ResizeObserverStub.instances[0] as unknown as ResizeObserver);
      await Promise.resolve();
    });
    expect(bridge.show).toHaveBeenCalledTimes(2);
  });

  it('parks the page while a dialog is open on top of it and brings it back after', async () => {
    render(<EfoodPartnerView />);
    await flush();
    expect(bridge.show).toHaveBeenCalledTimes(1);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    await act(async () => {
      document.body.appendChild(dialog);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bridge.park).toHaveBeenCalledTimes(1);

    await act(async () => {
      dialog.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bridge.show).toHaveBeenCalledTimes(2);
  });

  it('passes the mute setting through and offers reload and home actions', async () => {
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: true }));
    render(<EfoodPartnerView />);
    await flush();
    expect(bridge.show).toHaveBeenCalledWith(expect.anything(), { muted: true });

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(bridge.navigate).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole('button', { name: 'Live orders' }));
    expect(bridge.navigate).toHaveBeenCalledWith('https://partner-app.e-food.gr/live-orders');
  });

  it('explains when the page cannot be shown instead of leaving a blank surface', async () => {
    bridge.show.mockResolvedValue({ success: false });
    render(<EfoodPartnerView />);
    await flush();
    expect(screen.getByText('The efood page could not be shown on this register. Reload, or restart the POS.')).toBeInTheDocument();
  });
});
