import Database from 'better-sqlite3';
import { getWaiterShiftData } from '../../../src/main/services/helpers/ShiftHelpers';

describe('getWaiterShiftData', () => {
  it('excludes cancelled and refunded orders from totals but keeps them in order details', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        order_number TEXT,
        status TEXT,
        total_amount REAL,
        payment_method TEXT,
        table_number TEXT,
        order_type TEXT,
        staff_shift_id TEXT
      );
    `);

    const shiftId = 'shift-1';
    const insert = db.prepare(`
      INSERT INTO orders (
        id, order_number, status, total_amount,
        payment_method, table_number, order_type, staff_shift_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('o1', '001', 'completed', 10, 'cash', 'T1', 'dine-in', shiftId);
    insert.run('o2', '002', 'completed', 8, 'card', 'T1', 'dine-in', shiftId);
    insert.run('o3', '003', 'refunded', 5, 'cash', 'T1', 'dine-in', shiftId);
    insert.run('o4', '004', 'cancelled', 7, 'card', 'T1', 'dine-in', shiftId);

    const tables = getWaiterShiftData(db, shiftId);
    expect(tables).toHaveLength(1);

    const table = tables[0];
    expect(table.order_count).toBe(2);
    expect(table.total_amount).toBe(18);
    expect(table.cash_amount).toBe(10);
    expect(table.card_amount).toBe(8);
    expect(table.payment_method).toBe('mixed');

    const statuses = table.orders.map((o: any) => o.status).sort();
    expect(statuses).toEqual(['cancelled', 'completed', 'completed', 'refunded'].sort());

    db.close();
  });
});
