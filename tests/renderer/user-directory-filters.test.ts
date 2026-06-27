import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getLoyaltyTierKey,
  hasActiveUserDirectoryFilters,
  matchesUserDirectoryFilters,
} from '../../src/renderer/utils/userDirectoryFilters';

const user = (over: Record<string, unknown> = {}) => ({
  name: 'Alpha Beta',
  email: 'alpha@example.com',
  phone: '2101234567',
  loyalty_points: 0,
  is_banned: false,
  ...over,
});

const ALL = { search: '', status: 'all', loyalty: 'all' } as const;

test('getLoyaltyTierKey maps points to the same thresholds as the badge', () => {
  assert.equal(getLoyaltyTierKey(0), 'bronze');
  assert.equal(getLoyaltyTierKey(199), 'bronze');
  assert.equal(getLoyaltyTierKey(200), 'silver');
  assert.equal(getLoyaltyTierKey(499), 'silver');
  assert.equal(getLoyaltyTierKey(500), 'gold');
  assert.equal(getLoyaltyTierKey(999), 'gold');
  assert.equal(getLoyaltyTierKey(1000), 'platinum');
});

test('no filters -> every user matches', () => {
  assert.equal(matchesUserDirectoryFilters(user(), ALL), true);
});

test('status filter selects active vs banned users', () => {
  assert.equal(matchesUserDirectoryFilters(user({ is_banned: false }), { ...ALL, status: 'active' }), true);
  assert.equal(matchesUserDirectoryFilters(user({ is_banned: true }), { ...ALL, status: 'active' }), false);
  assert.equal(matchesUserDirectoryFilters(user({ is_banned: true }), { ...ALL, status: 'banned' }), true);
  assert.equal(matchesUserDirectoryFilters(user({ is_banned: false }), { ...ALL, status: 'banned' }), false);
});

test('loyalty filter selects by tier', () => {
  assert.equal(matchesUserDirectoryFilters(user({ loyalty_points: 600 }), { ...ALL, loyalty: 'gold' }), true);
  assert.equal(matchesUserDirectoryFilters(user({ loyalty_points: 100 }), { ...ALL, loyalty: 'gold' }), false);
  assert.equal(matchesUserDirectoryFilters(user({ loyalty_points: 100 }), { ...ALL, loyalty: 'bronze' }), true);
  assert.equal(matchesUserDirectoryFilters(user({ loyalty_points: 1500 }), { ...ALL, loyalty: 'platinum' }), true);
});

test('search combines with status and loyalty (all must pass)', () => {
  const banned = user({ name: 'Zeta Customer', is_banned: true, loyalty_points: 700 });
  // Matches search + status + loyalty.
  assert.equal(
    matchesUserDirectoryFilters(banned, { search: 'zeta', status: 'banned', loyalty: 'gold' }),
    true,
  );
  // Search matches but status excludes it.
  assert.equal(
    matchesUserDirectoryFilters(banned, { search: 'zeta', status: 'active', loyalty: 'gold' }),
    false,
  );
  // Status/loyalty match but search excludes it.
  assert.equal(
    matchesUserDirectoryFilters(banned, { search: 'nomatch', status: 'banned', loyalty: 'gold' }),
    false,
  );
});

test('hasActiveUserDirectoryFilters flags any non-"all" filter', () => {
  assert.equal(hasActiveUserDirectoryFilters({ status: 'all', loyalty: 'all' }), false);
  assert.equal(hasActiveUserDirectoryFilters({ status: 'banned', loyalty: 'all' }), true);
  assert.equal(hasActiveUserDirectoryFilters({ status: 'all', loyalty: 'silver' }), true);
});
