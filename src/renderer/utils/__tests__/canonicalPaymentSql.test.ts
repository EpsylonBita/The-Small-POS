// @vitest-environment node
// Execute the production Rust SQL in SQLite without invoking cargo. Native
// tests cover the full importer, cursor transaction, drawer and Z owners.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const sourceRoot = process.env.PAYMENT_SQL_SOURCE_ROOT ?? path.resolve('src-tauri/src');
const source = (file: string) => readFileSync(path.join(sourceRoot, file), 'utf8');

function ledger() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE payment_adjustments (
    id TEXT PRIMARY KEY, payment_id TEXT, order_id TEXT, adjustment_type TEXT,
    amount REAL, amount_cents INTEGER, imported_remote INTEGER DEFAULT 0
  );
  INSERT INTO payment_adjustments VALUES('remote-refund','payment','order','refund',6,600,1);
  INSERT INTO payment_adjustments VALUES('local-refund','payment','order','refund',1,100,0);
  INSERT INTO payment_adjustments VALUES('remote-void','payment','order','void',3,300,1);`);
  return db;
}

// `load_coverage_cents_scoped` (payments.rs) builds one query for both refund
// scopes. Money readers take the net scope (master arithmetic); the order's
// paid label takes the label scope (offline week Ω12, 22/10/2026).
const ADJUSTMENT_CENTS = 'COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))';
const netScope = (sql: string) => sql
  .replaceAll('{adjustment_cents_sql}', ADJUSTMENT_CENTS)
  .replaceAll('{label_refund_sql}', ADJUSTMENT_CENTS)
  .replaceAll('{reversed_sql}', 'COALESCE(refunds.refunded_cents, 0)');
const labelScope = (sql: string) => sql
  .replaceAll('{adjustment_cents_sql}', ADJUSTMENT_CENTS)
  .replaceAll('{label_refund_sql}', `CASE WHEN LOWER(TRIM(COALESCE(adjustment_context, 'manual'))) = 'edit_settlement' THEN ${ADJUSTMENT_CENTS} ELSE 0 END`)
  .replaceAll('{reversed_sql}', '(CASE WHEN COALESCE(refunds.refunded_cents, 0) >= {gross_cents_sql} THEN {gross_cents_sql} ELSE COALESCE(refunds.label_refunded_cents, 0) END)');

describe('canonical ordinary return SQL', () => {
  for (const returned of [600, 1000]) {
    it(`returned reconstructed receipt (${returned} cents) contributes no Z tender, gross or refunds`, () => {
      const rust = source('zreport.rs');
      const formatSql = (name: string) => rust.slice(rust.indexOf(`let ${name} = format!(`))
        .match(/"((?:SELECT|FROM)[\s\S]*?)"\s*\)/)?.[1] ?? '';
      const historyFn = rust.slice(rust.indexOf('fn returned_reconstructed_history_sql('));
      const historyTemplate = historyFn.match(/"(\(COALESCE[\s\S]*?)"\s*\)/)?.[1];
      const history = (alias: string) => historyTemplate?.replaceAll('{alias}', alias).replaceAll('{terminal}', 'this-till') ?? '0';
      const filterFn = rust.slice(rust.indexOf('fn returned_history_order_filter_sql('));
      const orderFilter = filterFn.match(/"(\(NOT EXISTS[\s\S]*?)"\s*\)/)?.[1]
        ?.replaceAll('{history}', history('history_payment'))
        .replaceAll('{original}', history('original_payment'))
        .replaceAll('{placeholder}', "(original_payment.payment_origin='sync_reconstructed' AND COALESCE(original_payment.remote_payment_id,'')='')") ?? '1';
      const expand = (sql: string) => sql.replaceAll('{returned_history_payment}', history('op'))
        .replaceAll('{returned_history_order}', orderFilter)
        .replaceAll('{single_shift_open_tab}', '0').replaceAll('{reportable_order}', '1')
        .replaceAll('{financial_predicate}', '1').replaceAll('{payment_scope_predicate}', '1')
        .replaceAll('{financial_expr}', "'2026-02-16T12:00:00Z'")
        .replaceAll('{payment_scope_expr}', "'2026-02-16T12:00:00Z'");
      const singlePayments = rust.slice(rust.indexOf('// Payments: breakdown by method'))
        .match(/"(SELECT op.method,[\s\S]*?GROUP BY op.method, platform_ref)"/)?.[1];
      expect(singlePayments).toBeTruthy();
      const db = new DatabaseSync(':memory:');
      db.exec(`CREATE TABLE orders(id TEXT,staff_shift_id TEXT,total_amount REAL,total_amount_cents INTEGER,
        discount_amount REAL,discount_amount_cents INTEGER,tip_amount REAL,tip_amount_cents INTEGER,
        is_ghost INTEGER,is_test INTEGER,order_context TEXT,status TEXT,branch_id TEXT);
        CREATE TABLE order_payments(id TEXT,order_id TEXT,staff_shift_id TEXT,payment_origin TEXT,
        remote_payment_id TEXT,status TEXT,method TEXT,amount REAL,amount_cents INTEGER,currency TEXT,transaction_ref TEXT,metadata TEXT);
        CREATE TABLE payment_adjustments(payment_id TEXT,order_id TEXT,adjustment_type TEXT,
        imported_remote INTEGER,amount REAL,amount_cents INTEGER);
        CREATE TABLE staff_shifts(id TEXT,terminal_id TEXT);
        INSERT INTO orders VALUES('o','shift',10,1000,0,0,0,0,0,0,'','completed','branch');
        INSERT INTO order_payments VALUES('p','o','shift','sync_reconstructed','canonical',
        '${returned === 1000 ? 'refunded' : 'completed'}','cash',10,1000,'CHF','',NULL);
        INSERT INTO payment_adjustments VALUES('p','o','refund',1,${returned / 100},${returned});`);
      try {
        for (const period of [false, true]) {
          const from = expand(formatSql(period ? 'reportable_orders_from' : 'single_shift_orders_from'));
          const aggregate = expand(formatSql(period ? 'order_agg_sql' : 'single_shift_order_agg_sql')
            .replaceAll(period ? '{reportable_orders_from}' : '{single_shift_orders_from}', from));
          const gross = Object.values(db.prepare(aggregate).get(...(period ? [null, null, 'branch'] : ['shift'])))[1];
          const tenders = db.prepare(expand(period ? formatSql('payment_scope_sql') : singlePayments!))
            .all(...(period ? [null, null, 'branch'] : ['shift', 'branch']));
          const adjustment = expand(formatSql('adjustment_scope_sql'))
            .replaceAll('{adjustment_scope_predicate}', '1').replaceAll('{adjustment_scope_expr}', "'2026-02-16T12:00:00Z'");
          expect({ gross, tender: tenders.reduce((sum: number, row: Record<string, number>) => sum + row.total, 0),
            refunds: db.prepare(adjustment).all(null, null, 'branch') }).toEqual({gross: 0, tender: 0, refunds: []});
        }
        // Proven original custody keeps the master's sales population.
        db.exec("INSERT INTO staff_shifts VALUES('shift','this-till')");
        expect(db.prepare(`SELECT ${orderFilter} AS counted FROM orders o`).get().counted).toBe(1);
        expect(db.prepare(`SELECT ${history('op')} AS history FROM order_payments op`).get().history).toBe(0);
        db.exec("DELETE FROM staff_shifts; DELETE FROM payment_adjustments; UPDATE order_payments SET status='completed'");
        expect(db.prepare(`SELECT ${history('op')} AS history FROM order_payments op`).get().history).toBe(0);
        expect(db.prepare(`SELECT ${orderFilter} AS counted FROM orders o`).get().counted).toBe(1);
        // A local return is not reclassified as imported history.
        db.exec("UPDATE order_payments SET status='refunded'");
        expect(db.prepare(`SELECT ${history('op')} AS history FROM order_payments op`).get().history).toBe(0);
        // Canonical final status is sufficient when detail rows are incomplete.
        db.exec(`UPDATE order_payments SET metadata='{"canonical_return_status":"refunded"}'`);
        expect(db.prepare(`SELECT ${history('op')} AS history FROM order_payments op`).get().history).toBe(1);
      } finally { db.close(); }
    });
  }

  it('canonical context correction changes only imported copies', () => {
    const rust = source('sync.rs');
    const sql = rust.match(/"(UPDATE payment_adjustments SET adjustment_context=\?1[\s\S]*?imported_remote=1)"/)?.[1];
    expect(Boolean(sql)).toBe(true);
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE payment_adjustments(id TEXT,payment_id TEXT,adjustment_context TEXT,imported_remote INTEGER);
      INSERT INTO payment_adjustments VALUES('import','p','manual',1),('original','p','manual',0);`);
    try {
      db.prepare(sql!).run('edit_settlement', 'import');
      db.prepare(sql!).run('edit_settlement', 'original');
      expect(db.prepare('SELECT adjustment_context FROM payment_adjustments ORDER BY id').all()
        .map((row: { adjustment_context: string }) => row.adjustment_context)).toEqual(['edit_settlement', 'manual']);
    } finally { db.close(); }
  });

  it('closure cache compaction bounds absent parents and keeps evidence for local parents', () => {
    const sql = source('sync.rs').match(/"(DELETE FROM local_settings WHERE setting_category='sync'[\s\S]*?LIMIT \?1\))"/)?.[1];
    expect(Boolean(sql)).toBe(true);
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT,updated_at TEXT);
      CREATE TABLE orders(id TEXT,supabase_id TEXT);
      INSERT INTO orders VALUES('local','0');`);
    const insert = db.prepare('INSERT INTO local_settings VALUES(?,?,?,?)');
    for (let i = 0; i < 400; i++) insert.run('sync', `payments_closed_parent:${i}`, '{}', 'now');
    insert.run('sync', 'payments_cursor', 'opaque', 'now');
    insert.run('other', 'payments_closed_parent:other', '{}', 'now');
    try {
      db.prepare(sql!).run(256);
      expect(db.prepare("SELECT COUNT(*) AS n FROM local_settings WHERE setting_category='sync' AND setting_key GLOB 'payments_closed_parent:*'").get().n).toBe(257);
      expect(db.prepare('SELECT COUNT(*) AS n FROM local_settings').get().n).toBe(259);
      db.prepare(sql!).run(256);
      expect(db.prepare('SELECT COUNT(*) AS n FROM local_settings').get().n).toBe(259);
      db.exec('DELETE FROM orders');
      db.prepare(sql!).run(256);
      expect(db.prepare('SELECT COUNT(*) AS n FROM local_settings').get().n).toBe(258);
    } finally { db.close(); }
  });

  it('v102 owns the payment recovery migration', () => {
    const rust = source('db.rs');
    // Later migrations (v103 staff tip recipients, v104 offline week, v105 VAT) keep v102's own block.
    expect(Number(/CURRENT_SCHEMA_VERSION: i32 = (\d+);/.exec(rust)?.[1])).toBeGreaterThanOrEqual(102);
    expect(/if current < 102 \{\s*run_migration_tx\(conn, 102,/.test(rust)).toBe(true);
  });

  it('ordinary coverage follows master for manual and edit refunds without metadata', () => {
    const rust = source('payments.rs');
    const fn = rust.slice(rust.indexOf('fn load_coverage_cents_matching('));
    const sql = fn.match(/"(SELECT COALESCE\(SUM\([\s\S]*?AND op.method IS NOT \?2)"/)?.[1];
    expect(Boolean(sql)).toBe(true);
    expect(rust.includes('for_collection')).toBe(false);
    const expand = (scoped: string) => scoped
      .replaceAll('{gross_cents_sql}', 'op.amount_cents')
      .replaceAll('{tip_cents_sql}', 'MAX(COALESCE(op.tip_amount_cents,0),0)')
      .replaceAll('{row_filter}', "op.status = 'completed'");
    const query = expand(netScope(sql!));
    const label = expand(labelScope(sql!));
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE order_payments(id TEXT,order_id TEXT,method TEXT,amount_cents INTEGER,tip_amount_cents INTEGER,status TEXT);
      CREATE TABLE payment_adjustments(payment_id TEXT,amount_cents INTEGER,amount REAL,adjustment_type TEXT,adjustment_context TEXT);
      INSERT INTO order_payments VALUES('p','o','cash',1000,0,'completed');
      INSERT INTO payment_adjustments VALUES('p',600,6,'refund','manual');`);
    try {
      expect(Object.values(db.prepare(query).get('o','gift_card'))[1]).toBe(400);
      // The label: a partial customer return keeps the receipt's coverage.
      expect(Object.values(db.prepare(label).get('o','gift_card'))[1]).toBe(1000);
      db.exec("UPDATE payment_adjustments SET adjustment_context='edit_settlement'");
      expect(Object.values(db.prepare(query).get('o','gift_card'))[1]).toBe(400);
      expect(Object.values(db.prepare(label).get('o','gift_card'))[1]).toBe(400);
      // A full return in manual parts counts nothing for the label either.
      db.exec("UPDATE payment_adjustments SET adjustment_context='manual', amount_cents=1000, amount=10");
      expect(Object.values(db.prepare(label).get('o','gift_card'))[1]).toBe(0);
      db.exec("UPDATE order_payments SET status='voided'");
      expect(Object.values(db.prepare(query).get('o','gift_card'))[1]).toBe(0);
    } finally { db.close(); }
  });

  it('canonical final returns leave financial coverage while the local custody row stays intact', () => {
    const rust = source('payments.rs');
    const fn = rust.slice(rust.indexOf('pub(crate) fn counted_financial_payment_sql('), rust.indexOf('pub(crate) fn canonical_return_status('));
    expect(fn.includes('column_exists(conn, "order_payments", "metadata")')).toBe(true);
    const predicate = fn.match(/Ok\(format!\("([\s\S]*?)"\)\)/)?.[1];
    expect(Boolean(predicate)).toBe(true);
    const query = predicate!.replaceAll('{alias}', 'op').replace('{counted}', "op.status='completed'");
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE order_payments(id TEXT,method TEXT,status TEXT,metadata TEXT);
      INSERT INTO order_payments VALUES('p','cash','completed','{}');`);
    const covered = () => db.prepare(`SELECT COUNT(*) AS n FROM order_payments op WHERE ${query}`).get().n;
    try {
      expect(covered()).toBe(1);
      for (const status of ['voided', 'refunded']) {
        db.prepare('UPDATE order_payments SET metadata=?').run(JSON.stringify({canonical_return_status:status}));
        expect(covered()).toBe(0);
        expect(db.prepare("SELECT COUNT(*) AS n FROM order_payments WHERE status='completed'").get().n).toBe(1);
      }
      db.exec("UPDATE order_payments SET method='gift_card'");
      expect(covered()).toBe(1); // dedicated gift-return owner
    } finally { db.close(); }
  });

  it('mixed-tender cancellation projects imported final statuses without changing local statuses', () => {
    const rust = source('payments.rs');
    const start = rust.indexOf('pub(crate) fn financial_payment_status_sql(');
    const fn = rust.slice(start, rust.indexOf('/// SQL predicate: the server already holds', start));
    const canonical = fn.match(/let canonical = format!\("([\s\S]*?)"\);/)?.[1];
    const projection = fn.match(/Ok\(format!\(\s*"(CASE WHEN[\s\S]*?)"\s*\)\)/)?.[1];
    expect(Boolean(canonical && projection)).toBe(true);
    const expression = projection!.replaceAll('{canonical}', canonical!).replaceAll('{alias}', 'p');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE order_payments(id TEXT,method TEXT,status TEXT,metadata TEXT,amount_cents INTEGER);
      INSERT INTO order_payments VALUES('void-original','cash','voided',NULL,1000),
        ('void-import','cash','completed','{"canonical_return_status":"voided"}',1000),
        ('refund-original','card','refunded',NULL,1000),
        ('refund-import','card','completed','{"canonical_return_status":"refunded"}',1000),
        ('still-held','card','completed',NULL,500);`);
    try {
      expect(db.prepare(`SELECT id,(${expression}) AS status FROM order_payments p ORDER BY id`).all()
        .map((row: {id:string;status:string}) => [row.id,row.status])).toEqual([
          ['refund-import','refunded'],['refund-original','refunded'],['still-held','completed'],
          ['void-import','voided'],['void-original','voided'],
        ]);
      expect(db.prepare(`SELECT SUM(amount_cents) AS cents FROM order_payments p WHERE (${expression})='completed'`).get().cents).toBe(500);
    } finally { db.close(); }
  });

  it('ordinary coverage keeps master refund-only arithmetic', () => {
    const rust = source('payments.rs');
    const start = rust.indexOf('fn load_coverage_cents_matching(');
    const sql = rust.slice(start).match(/SELECT payment_id,\s*SUM[\s\S]*?GROUP BY payment_id/)?.[0];
    expect(sql).toBeTruthy();
    const db = ledger();
    try { expect(db.prepare(netScope(sql!)).get().refunded_cents).toBe(700); }
    finally { db.close(); }
  });

  it('the settlement fingerprint preserves master refund arithmetic', () => {
    const rust = source('payments.rs');
    const start = rust.indexOf('fn load_completed_payment_ledger_generation(');
    const sql = rust.slice(start).match(/SELECT SUM\(COALESCE\(pa.amount_cents[\s\S]*?AND pa.adjustment_type[^\n]+/)?.[0];
    expect(sql).toBeTruthy();
    const db = ledger();
    try {
      const query = sql!.replace('op.id', "'payment'");
      expect(Object.values(db.prepare(query).get())[0]).toBe(700);
    } finally { db.close(); }
  });

  it('refund admission preserves master arithmetic for local and imported refunds', () => {
    const rust = source('refunds.rs');
    const start = rust.indexOf('let prior_refunds: f64');
    const sql = rust.slice(start).match(/"(SELECT COALESCE\(SUM[\s\S]*?)"/)?.[1];
    expect(sql).toBeTruthy();
    const db = ledger();
    try {
      const row = db.prepare(sql!).get('payment');
      expect(Object.values(row)[0]).toBe(700);
    } finally { db.close(); }
  });

  it('shift order-type net excludes the return handled by another till', () => {
    const rust = source('zreport.rs');
    const start = rust.indexOf('let shift_ot_sql');
    const sql = rust.slice(start).match(/SELECT order_id,\s*SUM[\s\S]*?GROUP BY order_id/)?.[0];
    expect(sql).toBeTruthy();
    const db = ledger();
    try {
      expect(db.prepare(sql!).get().refund_sum_cents).toBe(100);
    } finally { db.close(); }
  });

  it('period Z adjustment totals include only returns handled here', () => {
    const rust = source('zreport.rs');
    const start = rust.indexOf('let adjustment_scope_sql');
    const sql = rust.slice(start).match(/"(SELECT pa.adjustment_type,[\s\S]*?GROUP BY pa.adjustment_type)"/)?.[1];
    expect(sql).toBeTruthy();
    const db = ledger();
    db.exec(`CREATE TABLE orders(id TEXT, branch_id TEXT, is_ghost INTEGER, is_test INTEGER, order_context TEXT, status TEXT);
      INSERT INTO orders VALUES('order','branch',0,0,'','completed');`);
    try {
      const query = sql!.replace('{adjustment_scope_predicate}', '1=1')
        .replaceAll('{adjustment_scope_expr}', "'2026-10-20T12:00:00Z'");
      const rows = db.prepare(query).all(null, null, 'branch');
      expect(rows).toHaveLength(1);
      expect(Object.values(rows[0])).toEqual(['refund', 100]);
    } finally { db.close(); }
  });
});
