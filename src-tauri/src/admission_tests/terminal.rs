use super::*;
use crate::admission_tests::{before_admission, terminal, writer};
use crate::tests::{fake_keyring, harness::TestDb};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

#[test]
fn admission_branch_credentials_precede_reservation_and_checkout_can_commit() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    crate::storage::seed_terminal_credential_for_test("branch_id", "your-branch").unwrap();
    let in_writer = Arc::new(AtomicBool::new(false));
    let flag = in_writer.clone();
    before_admission(move |conn| {
        assert!(conn.is_autocommit());
        flag.store(true, Ordering::SeqCst);
    });
    let (entered, pause) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    fake_keyring::before_each_read(move |key| {
        assert!(
            !in_writer.load(Ordering::SeqCst),
            "credential {key} after writer admission"
        );
        if key == "branch_id" {
            entered.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(2)).unwrap();
        }
    });
    let path = db.db_path().to_owned();
    let checkout = std::thread::spawn(move || {
        pause.recv_timeout(Duration::from_secs(2)).unwrap();
        let at = std::time::Instant::now();
        let checkout = writer(&path);
        checkout.execute_batch("CREATE TABLE checkout_probe(id INTEGER); INSERT INTO checkout_probe VALUES(1); COMMIT").unwrap();
        assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
        release.send(()).unwrap();
    });
    cache_terminal_settings_snapshot(
        &db.state,
        &serde_json::json!({"branch_info":{"timezone":"Europe/Berlin"}}),
    )
    .unwrap();
    checkout.join().unwrap();
    let conn = db.state.conn.try_lock().unwrap();
    assert_eq!(
        db::get_setting(&conn, "terminal", "hotel_timezone_branch_id").as_deref(),
        Some("your-branch")
    );
}

#[test]
fn admission_settings_scope_revalidation_refuses_changed_binding() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    terminal(&db.state.conn.lock().unwrap());
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        db::set_setting(
            &rusqlite::Connection::open(path).unwrap(),
            "terminal",
            "branch_id",
            "your-other-branch",
        )
        .unwrap();
    });
    let before = db.state.conn.lock().unwrap().total_changes();
    assert!(
        cache_terminal_settings_snapshot(&db.state, &serde_json::json!({"branch_info":{}}))
            .unwrap_err()
            .contains("scope changed")
    );
    let conn = db.state.conn.try_lock().unwrap();
    assert_eq!(conn.total_changes(), before);
    assert!(db::get_setting(&conn, "terminal", "hotel_timezone").is_none());
}

#[test]
fn admission_invalid_terminal_mirror_keeps_the_canonical_keyring_fallback() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    db::set_setting(&conn, "terminal", "terminal_id", "default-terminal").unwrap();
    crate::storage::seed_terminal_credential_for_test("terminal_id", "your-canonical-terminal")
        .unwrap();
    let captured = TerminalScopeSnapshot::capture(&conn).unwrap();
    assert_eq!(
        captured.canonical_terminal().as_deref(),
        Some("your-canonical-terminal")
    );
    assert_eq!(
        captured.value("terminal_id").as_deref(),
        Some("default-terminal")
    );
}
