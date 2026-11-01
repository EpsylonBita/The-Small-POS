import { describe, expect, it } from 'vitest';
import { buildSettingsNavGroups, resolveSettingsDeepLink } from '../settings-sections';

describe('settings sections (UI audit wave 7B)', () => {
  it('lists nine sections in three groups on the main till', () => {
    const groups = buildSettingsNavGroups(true);
    expect(groups.map((group) => group.id)).toEqual(['register', 'devices', 'appearance']);
    expect(groups.flatMap((group) => group.items)).toEqual([
      'status', 'platforms',
      'printing', 'payments', 'hardware', 'waiter_devices',
      'terminal', 'security', 'database',
    ]);
  });

  it('hides waiter phones on every till that is not the main one', () => {
    const items = buildSettingsNavGroups(false).flatMap((group) => group.items);
    expect(items).not.toContain('waiter_devices');
    expect(items).toHaveLength(8);
  });

  it('opens the new place of every deep link and old section name', () => {
    expect(resolveSettingsDeepLink('recovery')).toBe('database');
    expect(resolveSettingsDeepLink('printing')).toBe('printing');
    expect(resolveSettingsDeepLink('connection')).toBe('status');
    expect(resolveSettingsDeepLink('about')).toBe('status');
    expect(resolveSettingsDeepLink('admin')).toBe('status');
    expect(resolveSettingsDeepLink('status')).toBe('status');
    expect(resolveSettingsDeepLink(null)).toBeNull();
    expect(resolveSettingsDeepLink(undefined)).toBeNull();
  });
});
