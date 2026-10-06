/**
 * Fix review 06/10/2026: a satellite cash handover the server refused for
 * good held the receiving cashier's close (and so the Z) with no way out. A
 * manager's own PIN now releases it as a close blocker: the satellite cash is
 * credited to no drawer, and native writes the audit entry.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) =>
      typeof options === 'string'
        ? options
        : typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mock.invoke }) }));

import { SatelliteHandoverReleasePanel } from '../SatelliteHandoverReleasePanel';

const refused = {
  handoverId: 'handover-refused',
  currency: 'CHF',
  countedCents: 4250,
  state: 'refused',
  refusalCode: 'REMOTE_HANDOVER_PROOF_UNAVAILABLE',
};
const pending = { ...refused, handoverId: 'handover-pending', state: 'pending', refusalCode: null };

type Payload = { action?: string } | undefined;
const recovery = (release: () => unknown, handovers: unknown[]) =>
  async (channel: string, payload: Payload) => {
    if (channel !== 'shift_satellite_handover_recovery') return undefined;
    if (payload?.action === 'list') return { success: true, handovers };
    if (payload?.action === 'release') return release();
    throw new Error(`unexpected ${channel} ${JSON.stringify(payload)}`);
  };

describe('SatelliteHandoverReleasePanel', () => {
  beforeEach(() => mock.invoke.mockReset());
  afterEach(() => cleanup());

  it('lists only refused handovers in plain text and releases one with a manager PIN', async () => {
    mock.invoke.mockImplementation(recovery(() => ({ success: true, released: true }), [refused, pending]));
    const onReleased = vi.fn();
    render(<SatelliteHandoverReleasePanel cashierShiftId="cashier-shift" onReleased={onReleased} />);

    const panel = await screen.findByTestId('satellite-handover-release');
    expect(mock.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', { action: 'list', cashierShiftId: 'cashier-shift' });
    expect(panel.textContent).toContain("The satellite till already closed this shift itself, so its cash can't be received here.");
    expect(panel.textContent).not.toMatch(/REMOTE_|SATELLITE_HANDOVER_/);
    expect(screen.queryByTestId('satellite-handover-release-pin-handover-pending')).toBeNull();

    const release = screen.getByTestId('satellite-handover-release-handover-refused');
    expect(release).toBeDisabled();
    fireEvent.change(screen.getByTestId('satellite-handover-release-pin-handover-refused'), { target: { value: '24a68' } });
    expect(screen.getByTestId('satellite-handover-release-pin-handover-refused')).toHaveValue('2468');
    fireEvent.click(release);

    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1));
    expect(mock.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', {
      action: 'release',
      handoverId: 'handover-refused',
      cashierShiftId: 'cashier-shift',
      managerPin: '2468',
    });
  });

  it('a PIN without the right releases nothing and clears the PIN', async () => {
    mock.invoke.mockImplementation(recovery(() => { throw new Error('UNAUTHORIZED: Invalid PIN'); }, [refused]));
    const onReleased = vi.fn();
    render(<SatelliteHandoverReleasePanel cashierShiftId="cashier-shift" onReleased={onReleased} />);
    fireEvent.change(await screen.findByTestId('satellite-handover-release-pin-handover-refused'), { target: { value: '1357' } });
    fireEvent.click(screen.getByTestId('satellite-handover-release-handover-refused'));

    expect(await screen.findByRole('alert')).toHaveTextContent("That PIN can't release it.");
    expect(screen.getByTestId('satellite-handover-release-pin-handover-refused')).toHaveValue('');
    expect(onReleased).not.toHaveBeenCalled();
  });

  it('shows nothing when no handover is refused', async () => {
    mock.invoke.mockImplementation(recovery(() => ({ success: true }), [pending]));
    render(<SatelliteHandoverReleasePanel cashierShiftId="cashier-shift" onReleased={vi.fn()} />);
    await waitFor(() => expect(mock.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId('satellite-handover-release')).toBeNull();
  });
});
