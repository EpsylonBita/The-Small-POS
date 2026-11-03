use super::*;
use crate::tests::{fake_keyring, harness::TestDb};

#[test]
fn admission_earning_enqueue_passes_parent_organization_after_the_first_write() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = std::rc::Rc::new(Connection::open(db.db_path()).unwrap());
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .unwrap();
    crate::admission_tests::order(&conn);
    let payload = serde_json::json!({"id":"your-earning","order_id":"your-order"});
    let observed = conn.clone();
    fake_keyring::before_each_read(move |key| {
        assert!(
            observed.is_autocommit(),
            "earning enqueue credential {key} under writer"
        )
    });
    let tx = crate::db::immediate_transaction(&conn).unwrap();
    tx.execute(
        "UPDATE orders SET notes='your-first-write' WHERE id='your-order'",
        [],
    )
    .unwrap();
    enqueue_or_refresh_driver_earning_sync_row(&tx, "your-earning", &payload).unwrap();
    tx.commit().unwrap();
    let (organization, body): (String, String) = conn
        .query_row(
            "SELECT organization_id,data FROM parity_sync_queue WHERE record_id='your-earning'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(organization, "11111111-1111-4111-8111-111111111111");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["organization_id"],
        organization
    );
}
