/**
 * Users (customer directory) page filtering.
 *
 * Shared, pure helpers so the page filter and the loyalty badge agree on tier
 * thresholds, and so the combined search + status + loyalty predicate is unit
 * testable independently of the React component.
 */

export type UserStatusFilter = 'all' | 'active' | 'banned';
export type UserLoyaltyFilter = 'all' | 'bronze' | 'silver' | 'gold' | 'platinum';

export const USER_STATUS_FILTERS: UserStatusFilter[] = ['all', 'active', 'banned'];
export const USER_LOYALTY_FILTERS: UserLoyaltyFilter[] = ['all', 'bronze', 'silver', 'gold', 'platinum'];

/** Loyalty tier for a points balance. Single source of truth for badge + filter. */
export function getLoyaltyTierKey(points: number): 'bronze' | 'silver' | 'gold' | 'platinum' {
  const value = Number(points) || 0;
  if (value >= 1000) return 'platinum';
  if (value >= 500) return 'gold';
  if (value >= 200) return 'silver';
  return 'bronze';
}

export interface UserDirectoryRecord {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  loyalty_points?: number | null;
  is_banned?: boolean | null;
}

export interface UserDirectoryFilterState {
  search: string;
  status: UserStatusFilter;
  loyalty: UserLoyaltyFilter;
}

/** True when at least one non-default (non-"all") filter is active. */
export function hasActiveUserDirectoryFilters(
  filters: Pick<UserDirectoryFilterState, 'status' | 'loyalty'>,
): boolean {
  return filters.status !== 'all' || filters.loyalty !== 'all';
}

/** Combined search + status + loyalty predicate for a single user record. */
export function matchesUserDirectoryFilters(
  user: UserDirectoryRecord,
  filters: UserDirectoryFilterState,
): boolean {
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const matchesSearch = [user.name, user.email, user.phone].some((value) =>
      (value || '').toLowerCase().includes(search),
    );
    if (!matchesSearch) {
      return false;
    }
  }

  if (filters.status === 'active' && user.is_banned) {
    return false;
  }
  if (filters.status === 'banned' && !user.is_banned) {
    return false;
  }

  if (
    filters.loyalty !== 'all' &&
    getLoyaltyTierKey(Number(user.loyalty_points) || 0) !== filters.loyalty
  ) {
    return false;
  }

  return true;
}
