use super::*;

#[test]
fn admission_production_empty_settings_producer_skips_writer() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = crate::tests::harness::TestDb::open();
    let _writer = crate::admission_tests::writer(db.db_path());
    let before = db.state.conn.lock().unwrap().total_changes();
    let at = std::time::Instant::now();
    apply_generic_settings_and_credentials_under_lock(&db.state, &[]).unwrap();
    assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
    assert_eq!(db.state.conn.try_lock().unwrap().total_changes(), before);
}
