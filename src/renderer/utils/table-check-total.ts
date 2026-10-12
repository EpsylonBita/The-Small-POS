import type { RestaurantTable } from '../types/tables';

/** Linked physical tables display one shared check balance. */
export function sumTableCheckDue(
  tables: readonly RestaurantTable[],
  readDue: (table: RestaurantTable) => number,
): number {
  const seen = new Set<string>();
  return tables.reduce((sum, table) => {
    if (table.tableSessionId) {
      const key = JSON.stringify([table.organizationId, table.branchId, table.tableSessionId]);
      if (seen.has(key)) return sum;
      seen.add(key);
    }
    return sum + readDue(table);
  }, 0);
}
