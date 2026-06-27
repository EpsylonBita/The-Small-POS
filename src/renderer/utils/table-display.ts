/**
 * Format a table identifier for display so every user-facing surface in the
 * table-grid flow (dashboard table card, TableActionModal header, etc.) shows the
 * exact same value. The dashboard card and the action modal previously disagreed
 * ("#TB01" vs "#B01") because each formatted the raw number on its own.
 *
 * Display only - this does NOT change the matching/normalization used by backend
 * table order logic, which continues to work off the raw `tableNumber`.
 *
 * Examples: "B01" -> "#TB01", "T05" -> "#T05", "#T05" -> "#T05", "" -> "#T".
 */
export const formatTableDisplayNumber = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '#T';
  }
  return raw.startsWith('#')
    ? raw
    : /^T/i.test(raw)
      ? `#${raw}`
      : `#T${raw}`;
};
