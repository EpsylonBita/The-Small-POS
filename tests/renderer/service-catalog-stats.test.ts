import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { servicesService } from '../../src/renderer/services/ServicesService';
import type { Service } from '../../src/renderer/services/ServicesService';

const makeService = (over: Partial<Service>): Service => ({
  id: 's1',
  organizationId: 'org',
  branchId: 'br',
  categoryId: null,
  name: 'Service',
  description: null,
  durationMinutes: 30,
  price: 0,
  isActive: true,
  staffIds: [],
  createdAt: '',
  updatedAt: '',
  category: null,
  ...over,
});

test('calculateStats keeps cents for a single decimal-priced service (0.15 stays 0.15)', () => {
  const stats = servicesService.calculateStats([makeService({ price: 0.15 })]);
  assert.equal(stats.avgPrice, 0.15);
  // Regression guard: the old whole-euro rounding produced 0.
  assert.notEqual(stats.avgPrice, 0);
});

test('calculateStats averages mixed prices accurately to cents', () => {
  assert.equal(
    servicesService.calculateStats([
      makeService({ id: 'a', price: 0.15 }),
      makeService({ id: 'b', price: 0.45 }),
    ]).avgPrice,
    0.3,
  );
  assert.equal(
    servicesService.calculateStats([
      makeService({ id: 'c', price: 5 }),
      makeService({ id: 'd', price: 0.5 }),
    ]).avgPrice,
    2.75,
  );
  assert.equal(
    servicesService.calculateStats([
      makeService({ id: 'e', price: 1.1 }),
      makeService({ id: 'f', price: 2.2 }),
      makeService({ id: 'g', price: 3.3 }),
    ]).avgPrice,
    2.2,
  );
});

test('calculateStats still reports avgDuration as whole minutes', () => {
  const stats = servicesService.calculateStats([
    makeService({ id: 'a', durationMinutes: 30 }),
    makeService({ id: 'b', durationMinutes: 45 }),
  ]);
  assert.equal(stats.avgDuration, 38); // 37.5 rounds to a whole minute
  assert.ok(Number.isInteger(stats.avgDuration));
});

test('calculateStats avgPrice formula preserves cents in source (not whole-euro rounding)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'services', 'ServicesService.ts'),
    'utf8',
  );
  assert.match(source, /avgPrice:[^\n]*Math\.round\(\(totalPrice \/ services\.length\) \* 100\) \/ 100/);
  assert.doesNotMatch(source, /avgPrice:[^\n]*Math\.round\(totalPrice \/ services\.length\)\s*:/);
});
