//! The till's local call record (`callerid::call_log`, 23/11/2026) holds caller
//! numbers. A support session may count the calls of a day; it must never read
//! a number. `caller_id_log.caller_number` was classified `free_text` while the
//! table was always empty: free text reaches the replica as it is, and a
//! `substr` query reads it in pieces the phone scrubber does not recognise. It
//! is `pii` now (`shared/pos/support/pii-classification/desktop.ts`), so the
//! replica never holds it. This test asks through the real tool boundary.
use crate::support::{collectors, critical_op, replica, sql_query};
use serde_json::{json, Value};

/// Bare national, mobile, and international forms with `+` and `00`.
const NUMBERS: &[&str] = &[
    "2101234567",
    "6971234567",
    "+306971234568",
    "00447799887766",
    "0041779990214",
];

fn seed(db: &crate::tests::harness::TestDb) {
    let conn = db.state.conn.lock().unwrap();
    for (index, number) in NUMBERS.iter().enumerate() {
        crate::db::upsert_caller_id_log(
            &conn,
            number,
            None,
            Some("your-test-customer"),
            None,
            &format!("call-{index:032x}"),
            crate::callerid::call_log::ACTION_DETECTED,
            Some("your-test-org"),
            // Three calls on the 22nd, two on the 23rd (UTC).
            &format!("2026-11-2{}T10:0{index}:00.000Z", 2 + index / 3),
        )
        .unwrap();
    }
    crate::db::upsert_caller_id_log(
        &conn,
        crate::callerid::call_log::RESTRICTED_NUMBER,
        None,
        None,
        None,
        "call-withheld",
        crate::callerid::call_log::ACTION_DETECTED,
        Some("your-test-org"),
        "2026-11-23T11:00:00.000Z",
    )
    .unwrap();
    // Staff went on to an order from one call of the 23rd.
    let marked = crate::callerid::call_log::mark_order_started(
        &conn,
        crate::callerid::call_log::CallRef::Call {
            number: NUMBERS[3],
            occurred_at: chrono::DateTime::parse_from_rfc3339("2026-11-23T10:03:00.000Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        },
        None,
    )
    .unwrap();
    assert!(marked);
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
}

#[test]
fn support_counts_the_calls_of_a_day_and_never_reads_a_caller_number() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    seed(&db);
    let gate = critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let replica = replica::build(db.db_path(), &permit).unwrap();
    let ask = |sql: &str| -> Value {
        let answer = sql_query::query(&replica, &json!({ "sql": sql }), &permit)
            .unwrap_or_else(|error| panic!("{error}: {sql}"));
        collectors::meta(answer).unwrap()
    };

    // The question the founder asked on 23/11/2026, answered without a number.
    let per_day = ask("SELECT date(created_at) AS day, COUNT(*) AS calls,
                COUNT(customer_id) AS known_customers,
                SUM(action_taken = 'order_started') AS orders_started
           FROM caller_id_log GROUP BY day ORDER BY day");
    assert_eq!(per_day["row_count"], 2, "{per_day}");
    let counts: Vec<Vec<i64>> = per_day["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (1..4).map(|cell| row[cell].as_i64().unwrap()).collect())
        .collect();
    assert_eq!(counts, [[3, 3, 0], [3, 2, 1]]);
    assert!(per_day["rows"][0][0].to_string().contains("2026-11-22"));
    assert!(per_day["rows"][1][0].to_string().contains("2026-11-23"));

    // The replica holds a marker in place of every number, the word for a
    // withheld call included.
    let stored = ask("SELECT DISTINCT caller_number FROM caller_id_log");
    assert_eq!(stored["row_count"], 1, "{stored}");
    assert!(
        stored["rows"][0][0].to_string().contains("[REDACTED]"),
        "{stored}"
    );

    // Every column of every row, and the usual ways of asking around a mask.
    // The engine may refuse a query outright; a refusal shows nothing.
    let mut answered = 0;
    for sql in [
        "SELECT caller_number, sip_call_id, customer_id, created_at FROM caller_id_log",
        "SELECT * FROM caller_id_log",
        "SELECT * FROM caller_id_log ORDER BY rowid",
        "SELECT caller_number || '' AS n, substr(caller_number, 1, 6) AS head,
                substr(caller_number, -6) AS tail FROM caller_id_log",
        "SELECT group_concat(caller_number, ' ') AS numbers FROM caller_id_log",
    ] {
        let answer = match sql_query::query(&replica, &json!({ "sql": sql }), &permit) {
            Ok(answer) => collectors::meta(answer).unwrap(),
            Err(refusal) => {
                assert_eq!(refusal, "POLICY_REFUSED", "{sql}");
                continue;
            }
        };
        answered += 1;
        let text = answer.to_string();
        for number in NUMBERS {
            let digits: String = number.chars().filter(char::is_ascii_digit).collect();
            // The whole number, and the six-digit pieces a `substr` would
            // return: too short for the phone scrubber to recognise.
            for needle in [
                number.to_string(),
                digits.clone(),
                digits[..6].to_string(),
                digits[digits.len() - 6..].to_string(),
            ] {
                assert!(
                    !text.contains(&needle),
                    "{sql}\nshows part of a caller number ({needle}): {text}"
                );
            }
        }
    }
    assert!(
        answered >= 2,
        "the plain reads of the table must be answered"
    );
}
