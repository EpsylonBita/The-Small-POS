import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// founder 11/11/2026: progressive reveal is presentation only, with stable touch controls.
const read = (file: string) => readFileSync(path.join(process.cwd(), 'src/renderer', file), 'utf8');
const appointment = read('pages/verticals/salon/AppointmentsView.tsx');
const reservation = read('components/tables/ReservationForm.tsx');
const css = read('styles/glassmorphism.css');

test('appointment stages require staff/service then a chosen time; pre-context has no slot grid', () => {
  assert.match(appointment, /hasStaffAndService = Boolean\(formData.staffId && formData.serviceId\)/);
  assert.match(appointment, /\{hasStaffAndService && \(\s*<motion.div[^>]*data-appointment-stage="2"/);
  assert.match(appointment, /showSummaryStage = Boolean\(formData.startTime\)/);
  assert.match(appointment, /\{showSummaryStage && \(\s*<motion.div[^>]*data-appointment-stage="3"/);
  const beforeStage2 = appointment.slice(appointment.indexOf('data-appointment-slots-empty'), appointment.indexOf('data-appointment-stage="2"'));
  assert.doesNotMatch(beforeStage2, /timeSlots.map/);
  assert.match(beforeStage2, /slotsEmpty.title/);
  assert.match(beforeStage2, /slotsEmpty.help/);
  assert.match(appointment, /grid grid-cols-1 gap-3 sm:grid-cols-3/);
  assert.match(appointment, /data-appointment-staff-service[^\n]*overflow-visible/);
});

// Founder, 11/11/2026: the New Reservation window opened with the customer fields alone, and he
// read it as having no date, availability or time. The day and the time are on screen from the
// start with the table's own availability; only the optional notes still reveal.
test('reservation shows the customer, the day and the time from the start; only the notes reveal', () => {
  assert.match(reservation, /showAllStages = isEditing \|\| Object.values\(errors\).some\(Boolean\)/);
  assert.doesNotMatch(reservation, /showDetailsStage/);
  assert.match(reservation, /showNotesStage = showAllStages \|\| Boolean\(reservationDate && reservationTime\)/);
  assert.match(reservation, /<div data-reservation-stage="2">\s*<div className="pos-glass-form-card space-y-4">/);
  assert.match(reservation, /\{showNotesStage && \(\s*<motion.div[^>]*data-reservation-stage="3"/);
  assert.match(reservation, /initial: reduceMotion \|\| showAllStages \? false/);
  assert.match(reservation, /duration: reduceMotion \|\| showAllStages \? 0 : 0.24/);
  // A new reservation opens on today, so its times show at once.
  assert.match(reservation, /setReservationDate\(toLocalDateString\(nowRef\.current\)\);/);
});

test('reservation day strip and time grid show the availability of the table, by the conflict rule', () => {
  assert.match(reservation, /import \{ buildReservationDays, buildReservationSlots \} from '\.\.\/\.\.\/utils\/reservationAvailability';/);
  assert.match(reservation, /buildReservationDays\(\{ reservations: existingReservations, now, excludeId: initialReservation\?\.id \?\? null \}\)/);
  // Day strip: a tap picks the day; the state word carries the colour, the selection stays the kit's.
  assert.match(reservation, /data-reservation-days/);
  assert.match(reservation, /data-reservation-day=\{day\.date\}[\s\S]*?onClick=\{\(\) => selectReservationDay\(day\.date\)\}/);
  assert.match(reservation, /selected\s*\? 'border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\)'\s*: 'pos-glass-field'/);
  assert.match(reservation, /dayState === 'full'\s*\? 'text-rose-600 dark:text-rose-400'/);
  assert.match(reservation, /dayState === 'some'\s*\? 'text-amber-700 dark:text-amber-300'/);
  assert.match(reservation, /t\('reservationForm\.dayReserved', \{ count: day\.reserved/);
  // Time grid: same vocabulary as the appointment slots; a reserved time cannot be picked.
  const grid = reservation.slice(reservation.indexOf('reservationSlots.map((slot)'), reservation.indexOf('{/* Party Size'));
  assert.match(grid, /disabled=\{taken && !selected\}/);
  assert.match(grid, /taken\s*\? 'border-transparent bg-transparent text-red-700 dark:text-red-300 line-through cursor-not-allowed opacity-70'\s*: 'pos-glass-field'/);
  assert.match(grid, /taken && <span aria-hidden="true"[^>]*bg-red-500/);
  assert.match(grid, /min-h-touch/);
  // The grid is keyed by the day, so another day's times fade in once; reduced motion skips it.
  assert.match(reservation, /<motion\.div\s+key=\{reservationDate\}\s+data-reservation-slots\s+initial=\{reduceMotion \? false : \{ opacity: 0, y: 6 \}\}/);
  // Any other day or time is still typed in the kit fields the labels belong to.
  assert.match(reservation, /<KitDateField\s+id="reservation-date"\s+type="date" required/);
  assert.match(reservation, /<KitDateField\s+id="reservation-time"\s+type="time" required/);
  // The conflict check stays the authority.
  assert.match(reservation, /reservationsService\.checkReservationConflicts\(tableId, reservationDate, reservationTime\)/);

  const helper = read('utils/reservationAvailability.ts');
  assert.match(helper, /RESERVATION_DURATION_MINUTES = 90;/);
  assert.match(helper, /return startMinutes < existingEnd && end > existingStart;/);
  assert.match(helper, /new Set\(\['pending', 'confirmed'\]\)/);
});

test('both forms suppress opening-stage replays, honor reduced motion and scroll once per reveal', () => {
  for (const source of [appointment, reservation]) {
    assert.match(source, /useReducedMotion\(\)/);
    assert.match(source, /opacity: 0, height: 0, y: 12/);
    assert.match(source, /height: 'auto', y: 0, overflow: 'visible'/);
    assert.match(source, /opacity: 0, height: 0, overflow: 'hidden'/);
    assert.match(source, /ease: \[0.2, 0.8, 0.2, 1\]/);
    assert.match(source, /overflow: \{ delay: reduceMotion(?: \|\| showAllStages)? \? 0 : 0.24, duration: 0 \}/);
    assert.match(source, /behavior: reduceMotion \? 'instant' : 'smooth' \}/);
    assert.match(source, /window.clearTimeout\(timer\)/);
    assert.doesNotMatch(source, /pointer-events-none/);
  }
  // The appointment reveals two stages, the reservation only its notes.
  assert.equal((appointment.match(/<AnimatePresence initial=\{false\}>/g) || []).length, 2);
  assert.match(appointment, /previousStages = useRef/);
  assert.match(appointment, /!previousStages.current/);
  assert.equal((reservation.match(/<AnimatePresence initial=\{false\}>/g) || []).length, 1);
  assert.match(reservation, /previousNotesStage = useRef\(showNotesStage\)/);
  assert.match(reservation, /showNotesStage && !previousNotesStage\.current/);
});

test('slot motion is keyed only by day/period and pending slots never use booked red', () => {
  assert.match(appointment, /<motion.div key=\{`\$\{formData.date\}-\$\{timePeriod\}`\}/);
  assert.match(appointment, /Math.min\(index \* 0.012, 0.24\)/);
  assert.match(appointment, /reduceMotion \|\| !slotsMayAnimate.current \? false : \{ opacity: 0, y: 6 \}/);
  const grid = appointment.slice(appointment.indexOf('timeSlots.map((slot, index)'), appointment.indexOf('{/* Summary */}'));
  assert.match(grid, /const checking = loadingSlots/);
  assert.match(grid, /checking\s*\? 'pos-glass-field cursor-wait opacity-45'\s*: booked\s*\? 'border-transparent bg-transparent text-red-700 dark:text-red-300 line-through/);
  assert.match(grid, /booked && !checking && <span[^>]*bg-red-500/);
  assert.match(grid, /disabled=\{booked\}/);
});

test('selected days, tabs and slots cannot inherit the important frosted-field fill', () => {
  assert.match(appointment, /isSelected \? '' : 'pos-glass-field '/);
  for (const condition of ['isSelected', 'timePeriod === p', 'selected']) {
    const expression = new RegExp(condition + "\\s*\\? '(?:border-\\(--pos-s-sel-bg\\) bg-\\(--pos-s-sel-bg\\) text-\\(--pos-s-sel-fg\\)|bg-\\(--pos-s-sel-bg\\) text-\\(--pos-s-sel-fg\\) border-\\(--pos-s-sel-bg\\))'");
    assert.match(appointment, expression);
  }
  assert.match(css, /--field-glass-fg: #18181b;/);
  assert.match(css, /\.dark[\s\S]*--field-glass-fg: #fafafa;/);
  assert.match(css, /\.pos-glass-form-card \{[^}]*background: var\(--modal-glass-card\)/);
});
