import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SHIFT_MINUTES,
  evaluateShiftDuration,
  shouldRollEndToNextDay,
} from '../../src/renderer/utils/staff-shift-duration';

test('evaluateShiftDuration accepts a normal same-day shift', () => {
  const result = evaluateShiftDuration('2026-06-15T17:00:00', '2026-06-15T23:00:00');
  assert.equal(result.status, 'ok');
  assert.equal(result.valid, true);
  assert.equal(result.durationMinutes, 360);
});

test('evaluateShiftDuration accepts a legitimate overnight shift under the cap', () => {
  // 23:00 -> 05:00 next day = 6h.
  const result = evaluateShiftDuration('2026-06-15T23:00:00', '2026-06-16T05:00:00');
  assert.equal(result.status, 'ok');
  assert.equal(result.valid, true);
  assert.equal(result.durationMinutes, 360);
});

test('evaluateShiftDuration rejects the 30h next-day-shortcut bug', () => {
  // The reported defect: 15 Jun 17:00 -> 16 Jun 23:00 = 30h.
  const result = evaluateShiftDuration('2026-06-15T17:00:00', '2026-06-16T23:00:00');
  assert.equal(result.status, 'tooLong');
  assert.equal(result.valid, false);
  assert.equal(result.durationMinutes, 30 * 60);
});

test('evaluateShiftDuration rejects end at or before start', () => {
  assert.equal(evaluateShiftDuration('2026-06-15T17:00:00', '2026-06-15T17:00:00').status, 'endNotAfterStart');
  assert.equal(evaluateShiftDuration('2026-06-15T17:00:00', '2026-06-15T09:00:00').status, 'endNotAfterStart');
});

test('evaluateShiftDuration reports invalid for missing/garbage input', () => {
  assert.equal(evaluateShiftDuration(null, '2026-06-15T23:00:00').status, 'invalid');
  assert.equal(evaluateShiftDuration('2026-06-15T17:00:00', null).status, 'invalid');
  assert.equal(evaluateShiftDuration('not-a-date', 'also-bad').status, 'invalid');
});

test('evaluateShiftDuration accepts 23h59m but rejects an exact full-day (24h) shift', () => {
  const justUnder = evaluateShiftDuration('2026-06-15T00:00:00', '2026-06-15T23:59:00');
  assert.equal(justUnder.durationMinutes, 23 * 60 + 59);
  assert.equal(justUnder.status, 'ok');

  const fullDay = evaluateShiftDuration('2026-06-15T00:00:00', '2026-06-16T00:00:00');
  assert.equal(fullDay.durationMinutes, MAX_SHIFT_MINUTES);
  assert.equal(fullDay.status, 'tooLong');

  const overCap = evaluateShiftDuration('2026-06-15T00:00:00', '2026-06-16T00:01:00');
  assert.equal(overCap.status, 'tooLong');
});

test('the equal-time next-day shortcut (17:00 -> next day 17:00) is rejected as a full day', () => {
  // Review repro: start 17:00, end 17:00, click next-day. Equal times make the
  // shortcut roll the date, producing a 24h shift that must now be invalid.
  assert.equal(shouldRollEndToNextDay('17', '00', '17', '00'), true);
  const result = evaluateShiftDuration('2026-06-15T17:00:00', '2026-06-16T17:00:00');
  assert.equal(result.durationMinutes, MAX_SHIFT_MINUTES);
  assert.equal(result.status, 'tooLong');
  assert.equal(result.valid, false);
});

test('shouldRollEndToNextDay only rolls for a genuine overnight wrap', () => {
  // Same-day preset (end after start) must NOT roll - this is the 30h bug guard.
  assert.equal(shouldRollEndToNextDay('17', '00', '23', '00'), false);
  // Overnight (end at/before start) rolls forward.
  assert.equal(shouldRollEndToNextDay('23', '00', '05', '00'), true);
  // Equal times also roll (would otherwise be a zero/negative same-day shift).
  assert.equal(shouldRollEndToNextDay('17', '00', '17', '00'), true);
  // Tolerates numeric inputs.
  assert.equal(shouldRollEndToNextDay(9, 30, 17, 0), false);
});
