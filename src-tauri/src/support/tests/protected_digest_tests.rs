use crate::support::{
    critical_op::{self, CriticalKind},
    guards::Scope,
    protected_digest::{self, DigestOutcome, UnavailableReason},
    quiet_window,
};
use rusqlite::Connection;
use std::time::{Duration, Instant};
struct Fixture {
    _dir: crate::tests::harness::TempDir,
    path: std::path::PathBuf,
    writer: Connection,
}
impl Fixture {
    fn new() -> Self {
        let dir = crate::tests::harness::TempDir::new();
        let path = dir.path().join("pos.db");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE payments(id TEXT PRIMARY KEY, amount); CREATE TABLE unknown_protected(id INTEGER PRIMARY KEY, value); CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value,PRIMARY KEY(setting_category,setting_key)); INSERT INTO payments VALUES('your_payment',42); INSERT INTO unknown_protected VALUES(1,'private-row-value'); INSERT INTO local_settings VALUES('terminal','api_key','private-key-value'),('local','printer_last_known_brand:your-printer','your-brand');").unwrap();
        Self {
            _dir: dir,
            path,
            writer,
        }
    }
    fn scope() -> Scope {
        Scope {
            organization_id: "your_org".into(),
            branch_id: "your_branch".into(),
            terminal_id: "your_terminal".into(),
        }
    }
    fn digest(&self) -> DigestOutcome {
        protected_digest::collect(
            &self.path,
            &Self::scope(),
            Instant::now() + Duration::from_secs(5),
        )
    }
}
fn available(value: &DigestOutcome) {
    assert!(matches!(value, DigestOutcome::Available(_)), "{value:?}");
}
#[test]
fn unchanged_is_ok_and_every_protected_table_and_key_change_is_a_mismatch() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let from = Instant::now();
    let mut before = f.digest();
    available(&before);
    assert_eq!(
        quiet_window::check(&before, &f.digest(), from, Instant::now()).protected_check,
        "match"
    );
    for (sql, table) in [
        ("UPDATE payments SET amount=43", "payments"),
        (
            "UPDATE unknown_protected SET value='changed'",
            "unknown_protected",
        ),
        (
            "UPDATE local_settings SET setting_value='changed' WHERE setting_key='api_key'",
            "local_settings",
        ),
        (
            "INSERT INTO local_settings VALUES('recovery','new_guard','private')",
            "local_settings",
        ),
        ("DELETE FROM payments", "payments"),
    ] {
        f.writer.execute(sql, []).unwrap();
        let after = f.digest();
        available(&after);
        let result = quiet_window::check(&before, &after, from, Instant::now());
        assert_eq!(result.protected_check, "mismatch");
        assert_eq!(result.changed_tables, vec![table]);
        before = after;
    }
}
#[test]
fn sale_payment_or_other_critical_start_makes_changed_tables_inconclusive() {
    let _gate = critical_op::install_test_gate();
    for kind in [
        CriticalKind::Checkout,
        CriticalKind::Card,
        CriticalKind::Fiscal,
        CriticalKind::ZClose,
        CriticalKind::ShiftClose,
        CriticalKind::Restore,
        CriticalKind::Migration,
    ] {
        let f = Fixture::new();
        let before = f.digest();
        let from = Instant::now();
        {
            let _critical = critical_op::begin_critical(kind);
            f.writer
                .execute("UPDATE payments SET amount=44", [])
                .unwrap();
        }
        let after = f.digest();
        let to = Instant::now();
        let result = quiet_window::check(&before, &after, from, to);
        assert_eq!(result.protected_check, "inconclusive");
        assert_eq!(result.changed_tables, vec!["payments"]);
        assert_eq!(
            quiet_window::check(&after, &after, from, to).protected_check,
            "match"
        );
    }
}
#[test]
fn only_shared_operational_keys_are_excluded_and_private_values_never_escape() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let from = Instant::now();
    let before = f.digest();
    f.writer.execute("UPDATE local_settings SET setting_value='different-private-brand' WHERE setting_category='local'",[]).unwrap();
    let after = f.digest();
    assert_eq!(before, after);
    f.writer.execute("INSERT INTO local_settings VALUES('local','printer_last_known_brand:bad/host','private')",[]).unwrap();
    let after = f.digest();
    assert_eq!(
        quiet_window::check(&before, &after, from, Instant::now()).protected_check,
        "mismatch"
    );
    let output = serde_json::to_string(&after).unwrap();
    for secret in [
        "private-row-value",
        "private-key-value",
        "different-private-brand",
        "your_payment",
    ] {
        assert!(!output.contains(secret));
    }
}
#[test]
fn sqlite_types_boundaries_and_row_order_are_canonical() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.writer
        .execute_batch(
            "DELETE FROM unknown_protected; INSERT INTO unknown_protected VALUES(2,'bc'),(1,'a');",
        )
        .unwrap();
    let before = f.digest();
    available(&before);
    f.writer
        .execute_batch(
            "DELETE FROM unknown_protected; INSERT INTO unknown_protected VALUES(1,'a'),(2,'bc');",
        )
        .unwrap();
    assert_eq!(before, f.digest());
    let mut previous = before;
    for sql in [
        "UPDATE unknown_protected SET value='ab' WHERE id=1",
        "UPDATE unknown_protected SET value=1 WHERE id=1",
        "UPDATE unknown_protected SET value=1.0 WHERE id=1",
        "UPDATE unknown_protected SET value='1' WHERE id=1",
        "UPDATE unknown_protected SET value=x'31' WHERE id=1",
        "UPDATE unknown_protected SET value=NULL WHERE id=1",
    ] {
        f.writer.execute(sql, []).unwrap();
        let next = f.digest();
        available(&next);
        assert_ne!(previous, next);
        previous = next;
    }
    f.writer.execute_batch("CREATE TABLE composite(a TEXT,b INTEGER,v,PRIMARY KEY(a,b)) WITHOUT ROWID; INSERT INTO composite VALUES('z',1,'private'),('a',2,x'00ff');").unwrap();
    f.writer.execute_batch("CREATE TABLE generated_value(id INTEGER PRIMARY KEY,n INTEGER,stored INTEGER GENERATED ALWAYS AS(n*2) STORED,computed TEXT GENERATED ALWAYS AS(CAST(n AS TEXT)) VIRTUAL); INSERT INTO generated_value(id,n) VALUES(1,3)").unwrap();
    let before = f.digest();
    available(&before);
    assert_eq!(before, f.digest());
}
#[test]
fn deadline_preemption_and_missing_files_are_explicitly_unavailable_never_ok() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let before = f.digest();
    let from = Instant::now();
    let expired = protected_digest::collect(&f.path, &Fixture::scope(), Instant::now());
    assert_eq!(
        expired,
        DigestOutcome::Unavailable(UnavailableReason::Deadline)
    );
    assert_eq!(
        quiet_window::check(&before, &expired, from, Instant::now()).protected_check,
        "not_run"
    );
    let _critical = critical_op::begin_critical(CriticalKind::Checkout);
    assert_eq!(
        f.digest(),
        DigestOutcome::Unavailable(UnavailableReason::CriticalOperation)
    );
    drop(_critical);
    assert!(matches!(
        protected_digest::collect(
            &f.path.with_file_name("absent.db"),
            &Fixture::scope(),
            Instant::now() + Duration::from_secs(1)
        ),
        DigestOutcome::Unavailable(_)
    ));
    assert!(!f.path.with_file_name("absent.db").exists());
}
#[test]
fn critical_start_during_digest_cancels_it_and_writer_never_waits_on_support() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let mut token = None;
    let result = protected_digest::collect_with_checkpoint(
        &f.path,
        &Fixture::scope(),
        Instant::now() + Duration::from_secs(5),
        || {
            if token.is_none() {
                f.writer.busy_timeout(Duration::ZERO).unwrap();
                f.writer
                    .execute("UPDATE payments SET amount=45", [])
                    .unwrap();
                token = Some(critical_op::begin_critical(CriticalKind::Checkout));
            }
        },
    );
    assert_eq!(
        result,
        DigestOutcome::Unavailable(UnavailableReason::CriticalOperation)
    );
}
#[test]
fn dropped_history_and_reversed_windows_cannot_prove_a_mismatch() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let before = f.digest();
    let from = Instant::now();
    for _ in 0..4100 {
        drop(critical_op::begin_critical(CriticalKind::Card));
    }
    f.writer.execute("DELETE FROM payments", []).unwrap();
    let after = f.digest();
    assert_eq!(
        quiet_window::check(&before, &after, from, Instant::now()).protected_check,
        "inconclusive"
    );
    assert_eq!(
        quiet_window::check(&before, &after, Instant::now(), from).protected_check,
        "inconclusive"
    );
}

#[test]
fn shared_row_policy_excludes_eligible_repairs_but_protects_paid_orders_and_queue_targets() {
    let _gate = critical_op::install_test_gate();
    let dir = crate::tests::harness::TempDir::new();
    let path = dir.path().join("pos.db");
    let seed = super::write_guard_tests::fixture();
    seed.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    drop(seed);
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    let digest = || {
        protected_digest::collect(
            &path,
            &Fixture::scope(),
            Instant::now() + Duration::from_secs(5),
        )
    };
    let before = digest();
    available(&before);
    writer.execute_batch("UPDATE parity_sync_queue SET attempts=0; UPDATE orders SET total_amount=2,total_amount_cents=200; UPDATE local_settings SET setting_value='new-brand'").unwrap();
    assert_eq!(before, digest());
    writer.execute_batch("INSERT INTO order_payments VALUES('your_payment','o'); INSERT INTO parity_sync_queue(id,table_name,record_id,module_type,attempts,data) VALUES('your_protected_queue','payments','p','core',1,x'00')").unwrap();
    let before = digest();
    available(&before);
    let from = Instant::now();
    writer.execute_batch("UPDATE orders SET status='cancelled'; UPDATE parity_sync_queue SET attempts=2 WHERE table_name='payments'").unwrap();
    let result = quiet_window::check(&before, &digest(), from, Instant::now());
    assert_eq!(result.protected_check, "mismatch");
    assert_eq!(result.changed_tables, vec!["orders", "parity_sync_queue"]);
}
#[test]
fn real_schema_digest_keeps_the_collector_privacy_value_scan_green() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    super::collector_privacy_scan_tests::seed(&db);
    let digest = protected_digest::collect(
        db.db_path(),
        &Fixture::scope(),
        Instant::now() + Duration::from_secs(5),
    );
    available(&digest);
    let output = serde_json::to_string(&digest).unwrap();
    for private in super::collector_privacy_scan_tests::PRIVATE {
        assert!(!output.contains(private));
    }
}
#[test]
fn table_add_drop_rowid_changes_and_no_wal_are_fail_closed() {
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let from = Instant::now();
    let before = f.digest();
    f.writer
        .execute_batch(
            "CREATE TABLE new_protected(value); INSERT INTO new_protected VALUES('private')",
        )
        .unwrap();
    let after = f.digest();
    assert_eq!(
        quiet_window::check(&before, &after, from, Instant::now()).changed_tables,
        vec!["new_protected"]
    );
    f.writer
        .execute_batch("UPDATE new_protected SET rowid=9")
        .unwrap();
    let next = f.digest();
    assert_ne!(after, next);
    f.writer.execute_batch("DROP TABLE new_protected").unwrap();
    assert_eq!(before, f.digest());
    f.writer
        .execute_batch("PRAGMA journal_mode=DELETE")
        .unwrap();
    assert_eq!(
        f.digest(),
        DigestOutcome::Unavailable(UnavailableReason::ReadFailed)
    );
}

#[test]
fn immutable_payloads_on_eligible_rows_remain_protected() {
    let _gate = critical_op::install_test_gate();
    let dir = crate::tests::harness::TempDir::new();
    let path = dir.path().join("pos.db");
    let seed = super::write_guard_tests::fixture();
    seed.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    drop(seed);
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    let digest = || {
        protected_digest::collect(
            &path,
            &Fixture::scope(),
            Instant::now() + Duration::from_secs(5),
        )
    };
    let before = digest();
    available(&before);
    let from = Instant::now();
    writer
        .execute_batch(
            "UPDATE parity_sync_queue SET data=x'01'; UPDATE orders SET id='changed-order'",
        )
        .unwrap();
    let result = quiet_window::check(&before, &digest(), from, Instant::now());
    assert_eq!(result.protected_check, "mismatch");
    assert_eq!(result.changed_tables, vec!["orders", "parity_sync_queue"]);
}
