/**
 * Shared role-label helpers.
 *
 * Staff role slugs (e.g. `housekeeping_supervisor`, `waiter`, `admin`) are stable
 * identifiers used for filtering and data lookups, but their *visible* labels must
 * be localized. The database/API ships English display names (the `role_display_name`
 * column), so resolving labels straight from that data leaks English into non-English
 * locales. These helpers route known role slugs through the `common.roleNames.*` i18n
 * keys instead, while preserving genuine custom/data role names and never leaking raw
 * snake_case codes.
 *
 * Extracted so multiple surfaces (StaffScheduleView role filter chips, StaffShiftModal,
 * etc.) can share one resolution path instead of duplicating brittle logic.
 */

// Loose translate signature compatible with i18next's `TFunction`, mirroring the
// pattern in `i18nLabels.ts` so both the real `t` and lightweight test fakes are
// assignable without casts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => unknown;

/**
 * Turn an unknown role slug (e.g. "housekeeping_supervisor") into a readable label
 * ("Housekeeping Supervisor") so raw snake_case codes never reach the UI, while
 * preserving already-readable custom role names (e.g. "VIP Host", "Chef de Partie").
 */
export const humanizeRoleSlug = (roleName: string): string => {
  const trimmed = roleName.trim();
  if (!/[_-]/.test(trimmed)) {
    return trimmed;
  }
  return trimmed
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Resolve a staff role to a localized, human-readable label.
 *
 * Resolution order:
 *  1. Known role slugs resolve from `common.roleNames.*` (localized per language).
 *  2. True custom/data roles fall back to their provided display name.
 *  3. Anything else is humanized from the slug so raw codes never leak.
 */
export const translateRoleName = (
  t: TranslateFn,
  roleName: string,
  fallbackLabel?: string | null,
): string => {
  const normalized = (roleName || 'staff').trim() || 'staff';
  const key = `common.roleNames.${normalized.toLowerCase()}`;
  const translated = t(key);
  if (typeof translated === 'string' && translated && translated !== key) {
    return translated;
  }

  const custom = (fallbackLabel || '').trim();
  if (custom && custom.toLowerCase() !== normalized.toLowerCase()) {
    return custom;
  }

  return humanizeRoleSlug(normalized);
};
