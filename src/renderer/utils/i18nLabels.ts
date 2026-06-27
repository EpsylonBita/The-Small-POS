/**
 * i18n label helpers that guard against i18next returning a non-string value
 * (for example an object node) and ensure interpolation placeholders are
 * always resolved before reaching the UI.
 */

// Loose translate signature compatible with i18next's `TFunction`.
type TranslateFn = (key: string, options?: Record<string, unknown>) => unknown;

/**
 * Resolve the sidebar/navigation label for a module safely.
 *
 * The `navigation.menu` key is an object node (it holds the labels for the
 * classic sidebar entries such as `navigation.menu.menu`), so calling
 * `t('navigation.menu')` directly returns the i18next "returned an object
 * instead of string" warning instead of a label. We therefore look up the
 * nested `navigation.menu.<moduleId>` entry first, then the flat
 * `navigation.<moduleId>` entry, and finally fall back to the provided name,
 * skipping any candidate that does not resolve to a non-empty string.
 */
export const resolveNavigationLabel = (
  t: TranslateFn,
  moduleId: string,
  fallback: string,
): string => {
  const candidateKeys = [`navigation.menu.${moduleId}`, `navigation.${moduleId}`];

  for (const key of candidateKeys) {
    // `returnObjects: true` makes i18next hand back the raw object for object
    // nodes, so the `typeof === 'string'` guard below can reject them instead
    // of receiving the warning string.
    const value = t(key, { defaultValue: '', returnObjects: true });
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return fallback;
};

/**
 * Format a table capacity into a localized "N seats" label.
 *
 * The locale strings use the `{{count}}` placeholder (e.g. "{{count}} seats"),
 * so the count must be passed through i18next interpolation. Callers must NOT
 * prepend the capacity themselves, otherwise the number is duplicated.
 */
export const formatTableSeats = (t: TranslateFn, capacity: number): string => {
  const value = t('tables.seats', { count: capacity, defaultValue: '{{count}} seats' });
  return typeof value === 'string' ? value : `${capacity}`;
};
