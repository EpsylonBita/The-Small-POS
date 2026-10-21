import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge, update, remove, translate, importSchedule } = vi.hoisted(() => ({
  bridge: { staffSchedule: { list: vi.fn() } }, update: vi.fn(), remove: vi.fn(),
  importSchedule: vi.fn(async () => ({ shifts: [], format: 'xlsx' })),
  translate: (key: string, fallback?: string) => fallback || key,
}));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: translate }) }));
vi.mock('../../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({ getSetting: (_category: string, key: string) => key === 'hotel_timezone' ? 'Europe/Athens' : 'branch-a' }) }));
vi.mock('../../../../../lib', async (original) => ({ ...(await original<typeof import('../../../../../lib')>()), getBridge: () => bridge, isBrowser: () => false }));
vi.mock('../../../../utils/api-helpers', () => ({ posApiGet: vi.fn(async () => ({ success: false })), posApiPost: vi.fn(), posApiPatch: vi.fn(), posApiFetch: vi.fn() }));
vi.mock('../../../../services/offline-mutations', () => ({ offlineCreateStaffShift: vi.fn(), offlineUpdateStaffShift: update, offlineDeleteStaffShift: remove }));
vi.mock('../../../../utils/staff-schedule-import', async original => ({
  ...(await original<typeof import('../../../../utils/staff-schedule-import')>()), importStaffScheduleFile: importSchedule,
}));
import { StaffScheduleView } from '../StaffScheduleView';

const shiftId = '11111111-1111-4111-8111-111111111111';
describe('durable staff schedule edit/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
    const start = new Date(`${today}T06:00:00Z`);
    const end = new Date(start.getTime() + 8 * 3600000);
    bridge.staffSchedule.list.mockResolvedValue({ success: true, data: {
      staff: [{ id: 'staff-a', name: 'Ana Schedule', firstName: 'Ana', lastName: 'Schedule', role: { name: 'waiter', displayName: 'Waiter', color: '#555' } }],
      shifts: [{ id: shiftId, staffId: 'staff-a', startTime: start.toISOString(), endTime: end.toISOString(), status: 'scheduled', notes: '' }],
    } });
    update.mockImplementation(async (payload) => ({ shift: payload, queued: true }));
    remove.mockResolvedValue({ shift: { id: shiftId }, queued: true });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('passes the retained branch timezone into the spreadsheet importer', async () => {
    const { container } = render(<StaffScheduleView />);
    await screen.findByRole('button', { name: 'Edit shift' });
    const file = new File(['schedule'], 'staff.xlsx');
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(importSchedule).toHaveBeenCalledWith(file, expect.objectContaining({
      timeZone: 'Europe/Athens', staffList: expect.arrayContaining([expect.objectContaining({ id: 'staff-a' })]),
    })));
  });
  it('edits the actual shift UUID instead of creating an optimistic replacement', async () => {
    render(<StaffScheduleView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit shift' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('combobox')[1]).toHaveValue('09');
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: 'Changed hours confirmed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: shiftId, shift_id: shiftId, start_time: '2026-10-20T06:00:00.000Z', end_time: '2026-10-20T14:00:00.000Z', notes: 'Changed hours confirmed' })));
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
