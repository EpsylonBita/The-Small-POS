import Database from 'better-sqlite3';
import { ReportService } from '../../../src/main/services/ReportService';

describe('ReportService.countUnsyncedFinalOrders', () => {
  it('counts refunded orders as final when unsynced', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        supabase_id TEXT
      );

      CREATE TABLE local_settings (
        id TEXT PRIMARY KEY,
        setting_category TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL,
        last_sync TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const now = '2026-02-04T10:00:00.000Z';
    const insert = db.prepare(`
      INSERT INTO orders (id, status, created_at, supabase_id) VALUES (?, ?, ?, ?)
    `);

    insert.run('o1', 'delivered', now, null);
    insert.run('o2', 'completed', now, '');
    insert.run('o3', 'cancelled', now, null);
    insert.run('o4', 'canceled', now, null);
    insert.run('o5', 'refunded', now, null);
    insert.run('o6', 'refunded', now, 'supabase-1');
    insert.run('o7', 'pending', now, null);

    const reportService = new ReportService(db);
    const count = reportService.countUnsyncedFinalOrders();

    expect(count).toBe(5);

    db.close();
  });
});
