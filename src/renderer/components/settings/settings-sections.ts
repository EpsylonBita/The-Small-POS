// Settings shell (UI audit wave 7B, founder-approved 30/10/2026): nine sections in three groups.
// «Κατάσταση & σύνδεση» merges the former This register, Connection and Info sections.

export type SettingsSectionId =
  | 'status'
  | 'platforms'
  | 'printing'
  | 'payments'
  | 'hardware'
  | 'waiter_devices'
  | 'terminal'
  | 'security'
  | 'database';

/** Where other screens may ask Settings to open. Older names stay accepted as aliases. */
export type SettingsDeepLink = 'recovery' | 'printing' | 'status' | 'connection' | 'about' | 'admin' | null;

export type SettingsNavGroupId = 'register' | 'devices' | 'appearance';

export interface SettingsNavGroup {
  id: SettingsNavGroupId;
  items: SettingsSectionId[];
}

/**
 * The rail. Waiter phones are managed only from the main till (the server answers
 * 403 WAITER_MGMT_MAIN_ONLY to every other terminal type), so other tills do not list it.
 */
export function buildSettingsNavGroups(isMainTerminal: boolean): SettingsNavGroup[] {
  return [
    { id: 'register', items: ['status', 'platforms'] },
    {
      id: 'devices',
      items: (['printing', 'payments', 'hardware', 'waiter_devices'] as SettingsSectionId[]).filter(
        (id) => id !== 'waiter_devices' || isMainTerminal,
      ),
    },
    { id: 'appearance', items: ['terminal', 'security', 'database'] },
  ];
}

/** Maps a deep link (Health → recovery, Health → printer, old section names) to its section. */
export function resolveSettingsDeepLink(link: SettingsDeepLink | undefined): SettingsSectionId | null {
  switch (link) {
    case 'recovery':
      return 'database';
    case 'printing':
      return 'printing';
    case 'status':
    case 'connection':
    case 'about':
    case 'admin':
      return 'status';
    default:
      return null;
  }
}
