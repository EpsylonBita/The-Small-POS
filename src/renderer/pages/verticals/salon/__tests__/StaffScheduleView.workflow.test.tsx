import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge, update, remove, translate } = vi.hoisted(() => ({
  bridge: { staffSchedule: { list: vi.fn() } }, update: vi.fn(), remove: vi.fn(),
  translate: (key: string, fallback?: string) => fallback || key,
}));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: translate }) }));
vi.mock('../../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: () => 'branch-a' }) }));
vi.mock('../../../../../lib', async (original) => ({ ...(await original<typeof import('../../../../../lib')>()), getBridge: () => bridge, isBrowser: () => false }));
vi.mock('../../../../utils/api-helpers', () => ({ posApiGet: vi.fn(async () => ({ success: false })), posApiPost: vi.fn(), posApiPatch: vi.fn(), posApiFetch: vi.fn() }));
vi.mock('../../../../services/offline-mutations', () => ({ offlineCreateStaffShift: vi.fn(), offlineUpdateStaffShift: update, offlineDeleteStaffShift: remove }));
import { StaffScheduleView } from '../StaffScheduleView';

const shiftId = '11111111-1111-4111-8111-111111111111';
describe('durable staff schedule edit/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const start = new Date(); start.setHours(9, 0, 0, 0);
    const end = new Date(start); end.setHours(17);
    bridge.staffSchedule.list.mockResolvedValue({ success: true, data: {
      staff: [{ id: 'staff-a', name: 'Ana Schedule', firstName: 'Ana', lastName: 'Schedule', role: { name: 'waiter', displayName: 'Waiter', color: '#555' } }],
      shifts: [{ id: shiftId, staffId: 'staff-a', startTime: start.toISOString(), endTime: end.toISOString(), status: 'scheduled', notes: '' }],
    } });
    update.mockImplementation(async (payload) => ({ shift: payload, queued: true }));
    remove.mockResolvedValue({ shift: { id: shiftId }, queued: true });
  });
  afterEach(cleanup);
  it('edits the actual shift UUID instead of creating an optimistic replacement', async () => {
    render(<StaffScheduleView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit shift' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: 'Changed hours confirmed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: shiftId, shift_id: shiftId, notes: 'Changed hours confirmed' })));
  });
  it('requires a concrete confirmation before queueing deletion', async () => {
    render(<StaffScheduleView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete shift' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm deletion' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ shift_id: shiftId }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit shift' })).toBeNull());
  });
});
