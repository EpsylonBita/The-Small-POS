import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ReportService } from '../../src/main/services/ReportService';

const SCHEMA_PATH = path.resolve(__dirname, '../../src/main/database-schema.sql');

function createTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}

function seedStaffShift(db: Database.Database, params: {
  id: string;
  staffId: string;
  staffName: string;
  branchId: string;
  terminalId: string;
  roleType: 'cashier' | 'driver' | 'kitchen' | 'server' | 'manager';
  checkInTime: string;
}): void {
  const now = params.checkInTime;
  db.prepare(`
    INSERT INTO staff_shifts (
      id, staff_id, staff_name, branch_id, terminal_id, role_type,
      check_in_time, opening_cash_amount, status,
      total_orders_count, total_sales_amount, total_cash_sales, total_card_sales,
      calculation_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.staffId,
    params.staffName,
    params.branchId,
    params.terminalId,
    params.roleType,
    params.checkInTime,
    0,
    'active',
    0,
    0,
    0,
    0,
    2,
    now,
    now
  );
}

function seedOrder(db: Database.Database, params: {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: number;
  orderType: string;
  paymentMethod: 'cash' | 'card';
  staffShiftId: string;
  createdAt: string;
}): void {
  db.prepare(`
    INSERT INTO orders (
      id, order_number, status, items, total_amount,
      order_type, payment_method, staff_shift_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.orderNumber,
    params.status,
    '[]',
    params.totalAmount,
    params.orderType,
    params.paymentMethod,
    params.staffShiftId,
    params.createdAt,
    params.createdAt
  );
}

describe('ReportService integration', () => {
  let db: Database.Database;
  let reportService: ReportService;

  beforeEach(() => {
    db = createTestDatabase();
    reportService = new ReportService(db);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  it('generateZReport scopes sales and shifts to the requested branch', () => {
    const date = '2026-02-04';
    const branchA = 'branch-a';
    const branchB = 'branch-b';

    seedStaffShift(db, {
      id: 'shift-a',
      staffId: 'staff-a',
      staffName: 'Cashier A',
      branchId: branchA,
      terminalId: 'terminal-a',
      roleType: 'cashier',
      checkInTime: `${date}T09:00:00.000Z`,
    });
    seedStaffShift(db, {
      id: 'shift-b',
      staffId: 'staff-b',
      staffName: 'Cashier B',
      branchId: branchB,
      terminalId: 'terminal-b',
      roleType: 'cashier',
      checkInTime: `${date}T09:15:00.000Z`,
    });

    seedOrder(db, {
      id: 'order-a1',
      orderNumber: 'A-001',
      status: 'completed',
      totalAmount: 10,
      orderType: 'dine-in',
      paymentMethod: 'cash',
      staffShiftId: 'shift-a',
      createdAt: `${date}T10:00:00.000Z`,
    });

    seedOrder(db, {
      id: 'order-b1',
      orderNumber: 'B-001',
      status: 'completed',
      totalAmount: 20,
      orderType: 'dine-in',
      paymentMethod: 'card',
      staffShiftId: 'shift-b',
      createdAt: `${date}T10:05:00.000Z`,
    });

    const reportA = reportService.generateZReport(branchA, date);
    expect(reportA.sales.totalOrders).toBe(1);
    expect(reportA.sales.totalSales).toBe(10);
    expect(reportA.sales.cashSales).toBe(10);
    expect(reportA.sales.cardSales).toBe(0);
    expect(reportA.shifts.total).toBe(1);

    const reportB = reportService.generateZReport(branchB, date);
    expect(reportB.sales.totalOrders).toBe(1);
    expect(reportB.sales.totalSales).toBe(20);
    expect(reportB.sales.cashSales).toBe(0);
    expect(reportB.sales.cardSales).toBe(20);
    expect(reportB.shifts.total).toBe(1);
  });

  it('canExecuteZReport ignores active shifts and open orders from other branches', () => {
    const date = '2026-02-04';
    const branchA = 'branch-a';
    const branchB = 'branch-b';

    seedStaffShift(db, {
      id: 'shift-b-active',
      staffId: 'staff-b',
      staffName: 'Cashier B',
      branchId: branchB,
      terminalId: 'terminal-b',
      roleType: 'cashier',
      checkInTime: `${date}T08:30:00.000Z`,
    });

    seedOrder(db, {
      id: 'order-b-open',
      orderNumber: 'B-OPEN',
      status: 'pending',
      totalAmount: 12,
      orderType: 'dine-in',
      paymentMethod: 'cash',
      staffShiftId: 'shift-b-active',
      createdAt: `${date}T08:45:00.000Z`,
    });

    const result = reportService.canExecuteZReport(date, branchA);
    expect(result.ok).toBe(true);
  });
});
