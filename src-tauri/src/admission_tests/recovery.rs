use super::*;
use crate::admission_tests::{before_admission, no_write, terminal, writer};
use crate::tests::{fake_keyring, harness::TestDb};
use std::{rc::Rc, time::Duration};

fn pending(conn: &Connection) -> (Scope, Attempt) {
    terminal(conn);
    remember_item(
        conn,
        "your-order",
        &json!({"client_event_id":"your-event","items":[]}),
    )
    .unwrap();
    conn.execute(
        "UPDATE table_attempt_recovery_v1 SET next_retry_at=NULL",
        [],
    )
    .unwrap();
    claim(conn).unwrap().unwrap()
}

#[test]
fn admission_stale_finish_skips_writer_and_rechecks_generation() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    let (scope, attempt) = pending(&conn);
    conn.execute(
        "UPDATE table_attempt_recovery_v1 SET generation=generation+1",
        [],
    )
    .unwrap();
    let held = writer(db.db_path());
    no_write(&conn, || {
        assert_eq!(
            finish(&conn, &scope, &attempt, Ok(None)).unwrap()["state"],
            "stale"
        )
    });
    drop(held);
    conn.execute(
        "UPDATE table_attempt_recovery_v1 SET generation=?1",
        [attempt.generation],
    )
    .unwrap();
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        Connection::open(path)
            .unwrap()
            .execute(
                "UPDATE table_attempt_recovery_v1 SET generation=generation+1",
                [],
            )
            .unwrap();
    });
    let before = conn.total_changes();
    assert_eq!(
        finish(&conn, &scope, &attempt, Ok(None)).unwrap()["state"],
        "stale"
    );
    assert_eq!(conn.total_changes(), before);
}

#[test]
fn admission_recovery_and_foreground_apply_keep_credentials_outside_writer() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = Rc::new(Connection::open(db.db_path()).unwrap());
    conn.busy_timeout(Duration::from_millis(5000)).unwrap();
    let checkout = crate::admission_tests::pause_credentials_for_checkout(
        conn.clone(),
        db.db_path().to_owned(),
    );
    let (scope, attempt) = pending(&conn);
    let response = json!({"success":true,"cafe_lan_snapshot":{"orders":[],"sessions":[],"tables":[],"payments":[]}});
    finish(&conn, &scope, &attempt, Ok(Some(response.clone()))).unwrap();
    apply_foreground_item_snapshot(&conn, &scope, &attempt, &response).unwrap();
    checkout.join().unwrap();
    assert!(conn.is_autocommit());
}
