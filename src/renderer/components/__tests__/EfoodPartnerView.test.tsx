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

// A real DOMRect always carries right/bottom; the placement code clips against
// them, so the stub has to be an honest rectangle rather than a width/height pair.
const RECT = {
  left: 120.2,
  top: 40.8,
  width: 900.4,
  height: 611.1,
  right: 1020.6,
  bottom: 651.9,
  x: 120.2,
  y: 40.8,
  toJSON: () => ({}),
};

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
    bridge.setMuted.mockResolvedValue({ success: true, muted: true });
    localStorage.clear();
    // A window big enough to hold RECT, so the default cases are unclipped.
    window.innerWidth = 1440;
    window.innerHeight = 900;
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
      { muted: true },
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
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: false }));
    render(<EfoodPartnerView />);
    await flush();
    expect(bridge.show).toHaveBeenCalledWith(expect.anything(), { muted: false });

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
  it('starts silenced, because the browser sound settings are out of reach inside the POS', async () => {
    // efood's page rings and the POS plugin's modal rings after it. Staff used
    // to silence efood's half in the browser's site settings; a register with
    // nothing stored gets that silence from the start.
    render(<EfoodPartnerView />);
    await flush();
    expect(bridge.show).toHaveBeenCalledWith(expect.anything(), { muted: true });
    expect(screen.getByTestId('efood-partner-sound')).toHaveAttribute('data-muted', 'true');
  });

  it('keeps a register that already chose to hear efood', async () => {
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: false }));
    render(<EfoodPartnerView />);
    await flush();
    expect(bridge.show).toHaveBeenCalledWith(expect.anything(), { muted: false });
    expect(screen.getByTestId('efood-partner-sound')).toHaveAttribute('data-muted', 'false');
  });

  it('turns efood back on from the button and stores it for the next start', async () => {
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: true }));
    render(<EfoodPartnerView />);
    await flush();
    const button = screen.getByTestId('efood-partner-sound');
    expect(button).toHaveAttribute('aria-pressed', 'true');

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(bridge.setMuted).toHaveBeenCalledWith(false);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(JSON.parse(localStorage.getItem('pos-efood-partner-settings') ?? '{}')).toMatchObject({ muted: false });
  });

  it('silences efood from the button and keeps Settings > Platforms in step', async () => {
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: false }));
    const heard: boolean[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<{ muted: boolean }>).detail.muted);
    window.addEventListener('pos-efood-partner-settings-changed', listener);
    render(<EfoodPartnerView />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByTestId('efood-partner-sound'));
      await Promise.resolve();
    });
    window.removeEventListener('pos-efood-partner-settings-changed', listener);

    expect(bridge.setMuted).toHaveBeenCalledWith(true);
    expect(heard).toEqual([true]);
    expect(screen.getByTestId('efood-partner-sound')).toHaveAttribute('data-muted', 'true');
  });

  it('follows the same switch when Settings > Platforms changes it', async () => {
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: false }));
    render(<EfoodPartnerView />);
    await flush();
    expect(screen.getByTestId('efood-partner-sound')).toHaveAttribute('data-muted', 'false');

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('pos-efood-partner-settings-changed', { detail: { enabled: true, muted: true } }),
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId('efood-partner-sound')).toHaveAttribute('data-muted', 'true');
  });

  it('puts the button back and says so when the page refuses the sound change', async () => {
    // A button reading "sound off" while efood keeps ringing is the exact
    // problem this control exists to solve.
    localStorage.setItem('pos-efood-partner-settings', JSON.stringify({ enabled: true, muted: false }));
    bridge.setMuted.mockResolvedValue({ success: false });
    render(<EfoodPartnerView />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByTestId('efood-partner-sound'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('efood-partner-sound')).toHaveAttribute('data-muted', 'false');
    expect(screen.getByTestId('efood-partner-sound-error')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('pos-efood-partner-settings') ?? '{}')).toMatchObject({ muted: false });
  });

  it('reports a startup mute the page never accepted', async () => {
    bridge.show.mockResolvedValue({ success: true, exists: true, parked: false, muted: true, muteFailed: true });
    render(<EfoodPartnerView />);
    await flush();
    expect(screen.getByTestId('efood-partner-sound-error')).toBeInTheDocument();
  });
});
