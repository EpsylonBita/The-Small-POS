//! The store's money settings (item H, fix review 30/09/2026; the same
//! decision as Android): a read error is not "missing".
//!
//! Symptom: `db::get_setting` turned any read error into "not stored", and
//! the commands then answered a 100% discount cap and a 0% tax rate; the
//! renderer fell back to 30% / 24% on top. Checkout priced, capped and split
//! tax on assumed values. A setting that is truly missing keeps today's
//! defaults; a failed read, or a stored value that is not a percentage, is
//! now an error the renderer shows as a paused checkout with "Try again".

use crate::commands::settings::{read_discount_max, read_tax_rate, SETTING_UNAVAILABLE};
use crate::tests::harness::TestDb;

#[test]
fn settings_that_are_not_stored_keep_todays_defaults() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();

    assert_eq!(read_discount_max(&conn), Ok(100.0));
    assert_eq!(read_tax_rate(&conn), Ok(0.0));
}

#[test]
fn stored_percentages_are_read() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    crate::db::set_setting(&conn, "general", "discount_max", "15").unwrap();
    crate::db::set_setting(&conn, "general", "tax_rate", "13").unwrap();

    assert_eq!(read_discount_max(&conn), Ok(15.0));
    assert_eq!(read_tax_rate(&conn), Ok(13.0));
}

#[test]
fn a_stored_value_that_is_not_a_percentage_is_unavailable() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    crate::db::set_setting(&conn, "general", "discount_max", "garbled").unwrap();
    crate::db::set_setting(&conn, "general", "tax_rate", "240").unwrap();

    let cap = read_discount_max(&conn).expect_err("never an assumed 100%");
    assert!(cap.starts_with(SETTING_UNAVAILABLE), "{cap}");
    let rate = read_tax_rate(&conn).expect_err("never an assumed 0%");
    assert!(rate.starts_with(SETTING_UNAVAILABLE), "{rate}");
}

#[test]
fn a_failed_read_is_unavailable_never_the_default() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    crate::db::set_setting(&conn, "general", "tax_rate", "13").unwrap();
    conn.execute_batch("ALTER TABLE local_settings RENAME TO local_settings_unreadable")
        .unwrap();

    let cap = read_discount_max(&conn).expect_err("a read error is not \"missing\"");
    assert!(cap.starts_with(SETTING_UNAVAILABLE), "{cap}");
    let rate = read_tax_rate(&conn).expect_err("a read error is not \"missing\"");
    assert!(rate.starts_with(SETTING_UNAVAILABLE), "{rate}");
}
