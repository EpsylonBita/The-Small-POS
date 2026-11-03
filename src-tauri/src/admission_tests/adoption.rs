use super::*;
use crate::admission_tests::{before_admission, no_write, order, terminal, writer};
use crate::tests::{fake_keyring, harness::TestDb};
use std::rc::Rc;

fn canonical() -> Value {
    json!({"id":"44444444-4444-4444-8444-444444444444","organization_id":"11111111-1111-4111-8111-111111111111","branch_id":"22222222-2222-4222-8222-222222222222","version":1,"notes":null,"special_instructions":null,"items":[]})
}

#[test]
fn admission_unchanged_adoption_skips_writer_and_scope_change_refuses() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = Rc::new(Connection::open(db.db_path()).unwrap());
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .unwrap();
    terminal(&conn);
    order(&conn);
    let held = writer(db.db_path());
    for mode in [AdoptMode::Headers, AdoptMode::NonMoney] {
        no_write(&conn, || {
            assert!(
                adopt_canonical_order(&conn, "your-order", &canonical(), mode)
                    .unwrap()
                    .is_empty()
            )
        });
    }
    drop(held);
    let checkout = crate::admission_tests::pause_credentials_for_checkout(
        conn.clone(),
        db.db_path().to_owned(),
    );
    let mut changed = canonical();
    changed["notes"] = json!("your-new-note");
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        Connection::open(path)
            .unwrap()
            .execute(
                "UPDATE orders SET notes='your-new-note' WHERE id='your-order'",
                [],
            )
            .unwrap();
    });
    let before = conn.total_changes();
    assert!(
        adopt_canonical_order(&conn, "your-order", &changed, AdoptMode::Headers)
            .unwrap()
            .is_empty()
    );
    assert_eq!(conn.total_changes(), before);
    conn.execute("UPDATE orders SET notes=NULL WHERE id='your-order'", [])
        .unwrap();
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        crate::db::set_setting(
            &Connection::open(path).unwrap(),
            "terminal",
            "branch_id",
            "your-other-branch",
        )
        .unwrap();
    });
    let before = conn.total_changes();
    assert!(
        adopt_canonical_order(&conn, "your-order", &changed, AdoptMode::Headers)
            .unwrap_err()
            .contains("scope changed")
    );
    assert_eq!(conn.total_changes(), before);
    checkout.join().unwrap();
}

#[test]
fn adoption_caller_transaction_uses_captured_keyring_scope_without_reads() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = Rc::new(Connection::open(db.db_path()).unwrap());
    terminal(&conn);
    order(&conn);
    for (key, value) in [
        ("organization_id", "11111111-1111-4111-8111-111111111111"),
        ("branch_id", "22222222-2222-4222-8222-222222222222"),
    ] {
        crate::storage::seed_terminal_credential_for_test(key, value).unwrap();
        conn.execute(
            "DELETE FROM local_settings WHERE setting_category='terminal' AND setting_key=?1",
            [key],
        )
        .unwrap();
    }
    let checkout = crate::admission_tests::pause_credentials_for_checkout(
        conn.clone(),
        db.db_path().to_owned(),
    );
    let scope = crate::terminal_helpers::TerminalScopeSnapshot::capture(&conn).unwrap();
    checkout.join().unwrap();
    // A read here would fail at the seam while the caller owns admission.
    fake_keyring::before_each_read(|key| panic!("credential read after admission: {key}"));
    let tx = crate::db::immediate_transaction(&conn).unwrap();
    let mut changed = canonical();
    changed["notes"] = json!("your-canonical-note");
    crate::edit_settlement_recovery::adopt_canonical_order_scoped(
        &tx,
        "your-order",
        &changed,
        AdoptMode::Headers,
        Some(&scope),
    )
    .unwrap();
    assert!(!conn.is_autocommit());
    assert_eq!(
        conn.query_row("SELECT notes FROM orders WHERE id='your-order'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "your-canonical-note"
    );
    tx.commit().unwrap();
}

#[test]
fn adoption_without_captured_scope_or_mirrors_refuses_without_writes() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = Connection::open(db.db_path()).unwrap();
    order(&conn);
    fake_keyring::before_each_read(|key| {
        panic!("credential read inside caller transaction: {key}")
    });
    let tx = crate::db::immediate_transaction(&conn).unwrap();
    let before = conn.total_changes();
    assert!(adopt_canonical_order(&tx, "your-order", &canonical(), AdoptMode::Headers).is_err());
    assert_eq!(before, conn.total_changes());
    assert!(!conn.is_autocommit());
    tx.rollback().unwrap();
}
