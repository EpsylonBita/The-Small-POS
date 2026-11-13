import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  now: new Date('2026-11-11T10:00:00'),
  reduced: true,
  reservations: [] as any[],
  submit: vi.fn(async () => {}),
  cancel: vi.fn(),
  scroll: vi.fn(),
}));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({
  t: (key: string, options?: any) => options?.defaultValue || key,
}) }));
vi.mock('../../../hooks/useSystemClock', () => ({ useSystemClock: () => mocks.now }));
vi.mock('../../../services/ReservationsService', () => ({ reservationsService: {
  getReservationsForTable: vi.fn(async () => mocks.reservations),
  checkReservationConflicts: vi.fn(async () => []),
} }));
vi.mock('framer-motion', async original => ({
  ...(await original<typeof import('framer-motion')>()),
  useReducedMotion: () => mocks.reduced,
}));
// Exercise form visibility and validation through actual controlled fields; the date picker itself is independent.
vi.mock('../../ui/KitDateField', () => ({ KitDateField: (props: any) => <input {...props} /> }));
import ReservationForm from '../ReservationForm';

const props = () => ({ tableId: 'table-1', tableCapacity: 6, tableNumber: 1,
  isOpen: true, onSubmit: mocks.submit, onCancel: mocks.cancel });
const stage = (number: number) => document.querySelector(`[data-reservation-stage="${number}"]`);
const day = (date: string) => document.querySelector<HTMLButtonElement>(`[data-reservation-day="${date}"]`)!;
const slots = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-reservation-slots] button'));
const slot = (time: string) => slots().find(button => button.textContent === time)!;
const dateField = () => screen.getByLabelText('Date *') as HTMLInputElement;
const timeField = () => screen.getByLabelText('Time *') as HTMLInputElement;
const tomorrowEvening = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1', customerName: 'Nora', partySize: 2, status: 'confirmed', durationMinutes: 90,
  reservationDate: '2026-11-12', reservationTime: '20:00:00', reservationDatetime: '2026-11-12T20:00:00',
  ...overrides,
});
beforeEach(() => {
  mocks.reduced = true;
  mocks.reservations = [];
  mocks.submit.mockClear();
  mocks.scroll.mockClear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollIntoView = mocks.scroll;
});
afterEach(cleanup);

// Founder, 11/11/2026: the New Reservation window opened with the customer fields alone and read
// as having no date, availability or time. They are on screen from the start now.
describe('ReservationForm day, availability and time (founder 11/11/2026)', () => {
  it('opens with the customer, today selected and the times left today; only the notes wait', () => {
    render(<ReservationForm {...props()} />);
    expect(screen.getByLabelText('Customer Name *')).toBeVisible();
    expect(stage(2)).toBeTruthy();
    expect(stage(3)).toBeNull();
    // Today and the next 13 days, today pressed and written in the date field.
    expect(document.querySelectorAll('[data-reservation-day]')).toHaveLength(14);
    expect(day('2026-11-11').getAttribute('aria-pressed')).toBe('true');
    expect(dateField().value).toBe('2026-11-11');
    // It is 10:00: the times from 10:30 to 23:30 are offered, all free.
    expect(slots()[0].textContent).toBe('10:30');
    expect(slots()[slots().length - 1].textContent).toBe('23:30');
    expect(slots().every(button => button.dataset.slotState === 'free' && !button.disabled)).toBe(true);
    expect(timeField().value).toBe('');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create Reservation' })).toBeVisible();
    expect(mocks.scroll).not.toHaveBeenCalled();
  });

  it('picks a time with one tap and reveals the notes once', async () => {
    render(<ReservationForm {...props()} />);
    fireEvent.click(slot('12:30'));
    expect(timeField().value).toBe('12:30');
    expect(slot('12:30').getAttribute('aria-pressed')).toBe('true');
    expect(stage(3)).toBeTruthy();
    expect(screen.getByLabelText('Special Requests')).toBeVisible();
    await waitFor(() => expect(mocks.scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' }));
    fireEvent.click(slot('13:00'));
    expect(timeField().value).toBe('13:00');
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('shows what the table already has: the day says so and its times cannot be picked', async () => {
    mocks.reservations = [tomorrowEvening()];
    render(<ReservationForm {...props()} />);
    await waitFor(() => expect(day('2026-11-12').dataset.dayState).toBe('some'));
    expect(day('2026-11-11').dataset.dayState).toBe('free');
    fireEvent.click(day('2026-11-12'));
    expect(dateField().value).toBe('2026-11-12');
    // Another day starts at 08:00. 20:00 holds the table from 19:00 (90 minutes before) to 21:00.
    expect(slots()[0].textContent).toBe('08:00');
    expect(slot('18:30').dataset.slotState).toBe('free');
    for (const time of ['19:00', '19:30', '20:00', '20:30', '21:00']) {
      expect(slot(time).dataset.slotState).toBe('taken');
      expect(slot(time)).toBeDisabled();
      expect(slot(time).getAttribute('aria-label')).toBe(`${time} Reserved`);
    }
    expect(slot('21:30').dataset.slotState).toBe('free');
    fireEvent.click(slot('20:00'));
    expect(timeField().value).toBe('');
    expect(stage(3)).toBeNull();
  });

  it('drops a picked time that is reserved on the new day and keeps a typed one', async () => {
    mocks.reservations = [tomorrowEvening()];
    render(<ReservationForm {...props()} />);
    await waitFor(() => expect(day('2026-11-12').dataset.dayState).toBe('some'));
    fireEvent.click(slot('20:00'));
    expect(timeField().value).toBe('20:00');
    fireEvent.click(day('2026-11-12'));
    expect(timeField().value).toBe('');
    // A time that is free there is kept.
    fireEvent.click(slot('13:00'));
    fireEvent.click(day('2026-11-13'));
    expect(timeField().value).toBe('13:00');
    // A typed time is the cashier's own: the conflict check speaks for it.
    fireEvent.change(timeField(), { target: { value: '20:15' } });
    fireEvent.change(dateField(), { target: { value: '2026-11-12' } });
    expect(timeField().value).toBe('20:15');
  });

  it('keeps any other day and time available through the fields', () => {
    render(<ReservationForm {...props()} />);
    fireEvent.change(dateField(), { target: { value: '2026-12-24' } });
    // Beyond the strip: no day is pressed, the times of that day are offered.
    expect(document.querySelector('[data-reservation-day][aria-pressed="true"]')).toBeNull();
    expect(slots()[0].textContent).toBe('08:00');
    fireEvent.change(timeField(), { target: { value: '07:15' } });
    expect(stage(3)).toBeTruthy();
  });

  it('shows every stage immediately for an edit, never blocks its own time and never scrolls on opening', async () => {
    mocks.reduced = false;
    mocks.reservations = [tomorrowEvening({ id: 'reservation-1', reservationTime: '12:30:00' })];
    render(<ReservationForm {...props()} initialReservation={{
      id: 'reservation-1', customerName: 'Mia', customerPhone: '+306912345678',
      reservationDate: '2026-11-12', reservationTime: '12:30', partySize: 2,
    } as any} />);
    expect(stage(2)).toBeTruthy();
    expect(stage(3)).toBeTruthy();
    expect(day('2026-11-12').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(slot('12:30').dataset.slotState).toBe('free'));
    expect(slot('12:30').getAttribute('aria-pressed')).toBe('true');
    expect(mocks.scroll).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeVisible();
  });

  it('reveals all invalid fields on failed submission, keeping the original validation and submit guard', () => {
    mocks.reduced = false;
    render(<ReservationForm {...props()} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Create Reservation' }).closest('form')!);
    expect(stage(2)).toBeTruthy();
    expect(stage(3)).toBeTruthy();
    expect(screen.getByText('Customer name is required')).toBeVisible();
    expect(screen.getByText('Reservation time is required')).toBeVisible();
    // The day was never empty; clearing it brings its own error back.
    expect(screen.queryByText('Reservation date is required')).toBeNull();
    fireEvent.change(dateField(), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create Reservation' }).closest('form')!);
    expect(screen.getByText('Reservation date is required')).toBeVisible();
    expect(screen.getByText('Pick a day to see the times')).toBeVisible();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('submits the day and the time that were picked', async () => {
    render(<ReservationForm {...props()} />);
    fireEvent.change(screen.getByLabelText('Customer Name *'), { target: { value: 'Mia' } });
    fireEvent.change(screen.getByLabelText('Phone Number *'), { target: { value: '+306912345678' } });
    fireEvent.click(day('2026-11-12'));
    fireEvent.click(slot('19:30'));
    // The button reads "Checking..." while the conflict check for the picked time runs.
    fireEvent.click(await screen.findByRole('button', { name: 'Create Reservation' }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const sent = (mocks.submit.mock.calls[0] as any[])[0];
    expect(sent).toMatchObject({ customerName: 'Mia', customerPhone: '+306912345678', partySize: 2, tableId: 'table-1' });
    expect(sent.reservationTime).toEqual(new Date('2026-11-12T19:30'));
  });

  it('keeps the footer outside the scrolling and animated stages in both themes', () => {
    const view = render(<ReservationForm {...props()} />);
    const submit = screen.getByRole('button', { name: 'Create Reservation' });
    expect(submit.closest('[data-reservation-stage]')).toBeNull();
    expect(submit.closest('.liquid-glass-modal-content')).toBeNull();
    document.documentElement.classList.add('dark');
    view.rerender(<ReservationForm {...props()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(submit).toHaveClass('bg-(--pos-s-yellow)');
    document.documentElement.classList.remove('dark');
  });
});
