use super::*;
use crate::admission_tests::{before_admission, terminal};
use crate::tests::{fake_keyring, harness::TestDb};
use std::{rc::Rc, sync::mpsc, time::Duration};

#[test]
fn admission_attempt_credentials_are_read_before_writer_and_checkout_stays_available() {
    for cancellation in [false, true] {
        let _keyring = fake_keyring::install_empty();
        let db = TestDb::open();
        let conn = Rc::new(Connection::open(db.db_path()).unwrap());
        conn.busy_timeout(Duration::from_millis(5000)).unwrap();
        terminal(&conn);
        if cancellation {
            for (key, value) in [
                ("organization_id", "11111111-1111-4111-8111-111111111111"),
                ("branch_id", "22222222-2222-4222-8222-222222222222"),
            ] {
                crate::storage::seed_terminal_credential_for_test(key, value).unwrap();
                crate::db::delete_setting(&conn, "terminal", key).unwrap();
            }
            conn.execute_batch("CREATE TABLE table_manual_cancel_intents_v1(organization_id TEXT,branch_id TEXT,terminal_id TEXT,event_id TEXT,request_json TEXT)").unwrap();
            conn.execute(
                "INSERT INTO table_manual_cancel_intents_v1 VALUES(?1,?2,?3,?4,?5)",
                rusqlite::params![
                    "11111111-1111-4111-8111-111111111111",
                    "22222222-2222-4222-8222-222222222222",
                    "your-terminal",
                    "your-event",
                    json!({"client_event_id":"your-event","manual_refund":{"your-original":true}})
                        .to_string()
                ],
            )
            .unwrap();
        }
        let (entered, paused) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let observed = conn.clone();
        let mut once = false;
        fake_keyring::before_each_read(move |key| {
            assert!(observed.is_autocommit(), "keyring read under writer: {key}");
            if key == "owner_terminal_db_id" && !once {
                once = true;
                entered.send(()).unwrap();
                resume.recv_timeout(Duration::from_secs(2)).unwrap();
            }
        });
        let path = db.db_path().to_owned();
        let checkout = std::thread::spawn(move || {
            paused.recv_timeout(Duration::from_secs(2)).unwrap();
            let checkout = Connection::open(path).unwrap();
            checkout.busy_timeout(Duration::from_millis(5000)).unwrap();
            let at = std::time::Instant::now();
            checkout.execute_batch("BEGIN IMMEDIATE; CREATE TABLE checkout_probe(id INTEGER); INSERT INTO checkout_probe VALUES(1); COMMIT").unwrap();
            assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
            release.send(()).unwrap();
        });
        if cancellation {
            cancellation_attempt(
                &conn,
                "your-order",
                "your-session",
                "your-reason",
                "your-staff",
                Some("your-event"),
            )
            .unwrap();
        } else {
            item_edit_attempt(
                &conn,
                "your-order",
                &mut json!({"items":[],"client_event_id":"your-event"}),
            )
            .unwrap();
        }
        checkout.join().unwrap();
        if cancellation {
            let raw: String = conn
                .query_row(
                    "SELECT request_json FROM table_attempt_recovery_v1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&raw).unwrap()["manual_refund"]["your-original"],
                true
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM table_attempt_recovery_v1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}

#[test]
fn admission_attempt_refuses_a_changed_binding_without_writes() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    terminal(&conn);
    let path = db.db_path().to_owned();
    before_admission(move |conn| {
        assert!(conn.is_autocommit());
        let other = Connection::open(path).unwrap();
        crate::db::set_setting(&other, "terminal", "branch_id", "your-other-branch").unwrap();
    });
    let before = conn.total_changes();
    assert!(
        item_edit_attempt(&conn, "your-order", &mut json!({"items":[]}))
            .unwrap_err()
            .contains("scope changed")
    );
    assert_eq!(conn.total_changes(), before);
}
