import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReservationTimelineSlots,
  TIMELINE_DEFAULT_START_HOUR,
  TIMELINE_DEFAULT_END_HOUR,
} from '../../src/renderer/utils/reservationTimeline';

const DEFAULT_WINDOW = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

test('uses the default 11-22 business window when reservations fall inside it', () => {
  assert.deepEqual(buildReservationTimelineSlots([12, 15, 19]), DEFAULT_WINDOW);
});

test('keeps the default window when there are no reservations', () => {
  assert.deepEqual(buildReservationTimelineSlots([]), DEFAULT_WINDOW);
  assert.equal(DEFAULT_WINDOW[0], TIMELINE_DEFAULT_START_HOUR);
  assert.equal(DEFAULT_WINDOW[DEFAULT_WINDOW.length - 1], TIMELINE_DEFAULT_END_HOUR);
});

test('expands earlier to include an early reservation (09:00) the timeline used to hide', () => {
  const slots = buildReservationTimelineSlots([9, 12]);
  assert.ok(slots.includes(9), '09:00 must be a timeline row');
  assert.equal(slots[0], 9);
  assert.equal(slots[slots.length - 1], TIMELINE_DEFAULT_END_HOUR);
  // Rows stay ordered ascending and contiguous (no gaps).
  for (let i = 1; i < slots.length; i += 1) {
    assert.equal(slots[i], slots[i - 1] + 1);
  }
});

test('expands later to include a late reservation (23:00)', () => {
  const slots = buildReservationTimelineSlots([23]);
  assert.equal(slots[0], TIMELINE_DEFAULT_START_HOUR);
  assert.equal(slots[slots.length - 1], 23);
  assert.ok(slots.includes(23));
});

test('expands both ends and never drops an out-of-window reservation hour', () => {
  const slots = buildReservationTimelineSlots([8, 23]);
  assert.equal(slots[0], 8);
  assert.equal(slots[slots.length - 1], 23);
  for (const hour of [8, 11, 22, 23]) {
    assert.ok(slots.includes(hour), `hour ${hour} must be present`);
  }
});

test('ignores invalid hours (NaN / out of range) without breaking the range', () => {
  const slots = buildReservationTimelineSlots([Number.NaN, -1, 24, 9]);
  assert.equal(slots[0], 9);
  assert.equal(slots[slots.length - 1], TIMELINE_DEFAULT_END_HOUR);
});
