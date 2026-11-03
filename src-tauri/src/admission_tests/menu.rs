use super::*;
use crate::admission_tests::{before_admission, no_write, writer};
use crate::tests::harness::TestDb;

#[test]
fn admission_current_menu_skips_writer_and_changed_menu_rechecks() {
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    let menu = serde_json::json!({"categories":[],"subcategories":[],"ingredients":[],"combos":[]});
    assert!(apply_menu_payload(&conn, &menu, "your-version", None).unwrap());
    let held = writer(db.db_path());
    no_write(&conn, || {
        assert!(!apply_menu_payload(&conn, &menu, "your-version", None).unwrap())
    });
    drop(held);
    conn.execute(
        "UPDATE menu_cache SET version='old' WHERE cache_key='categories'",
        [],
    )
    .unwrap();
    let path = db.db_path().to_owned();
    before_admission(move |conn| {
        assert!(conn.is_autocommit());
        Connection::open(path)
            .unwrap()
            .execute("UPDATE menu_cache SET version='your-version'", [])
            .unwrap();
    });
    let before = conn.total_changes();
    assert!(!apply_menu_payload(&conn, &menu, "your-version", None).unwrap());
    assert_eq!(conn.total_changes(), before);
}

#[test]
fn admission_menu_mutation_waits_then_uses_fresh_state() {
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    let menu = serde_json::json!({"categories":[],"subcategories":[],"ingredients":[],"combos":[]});
    let held = writer(db.db_path());
    let other = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        held.execute_batch("COMMIT").unwrap();
    });
    let at = std::time::Instant::now();
    assert!(apply_menu_payload(&conn, &menu, "your-version", None).unwrap());
    assert!(at.elapsed() >= std::time::Duration::from_millis(50));
    other.join().unwrap();
}
