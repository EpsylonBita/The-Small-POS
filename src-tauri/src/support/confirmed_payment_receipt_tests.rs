use super::*;
use crate::{
    support::{
        critical_op::{self, CriticalKind},
        db::SupportDb,
        delivery,
        executor::Executor,
    },
    tests::{fake_keyring, harness::TestDb},
};
use std::{cell::Cell, collections::BTreeSet};

const ORG: &str = "10000000-0000-4000-8000-000000000001";
const BRANCH: &str = "10000000-0000-4000-8000-000000000002";
const TERM: &str = "10000000-0000-4000-8000-000000000004";
const LOCAL: &str = "10000000-0000-4000-8000-000000000077";
const ORDER: &str = "10000000-0000-4000-8000-000000000033";
const PAYMENT: &str = "10000000-0000-4000-8000-000000000075";
const STAMPED: &str = "10000000-0000-4000-8000-000000000078";
const AT: &str = "2026-11-18T09:00:00.000Z";

fn vector() -> Value {
    serde_json::from_str::<Value>(include_str!(
        "../../../../shared/pos/support/__fixtures__/confirmed-payment-receipt-vectors.json"
    ))
    .unwrap()[0]
        .clone()
}
fn command() -> Command {
    serde_json::from_value(vector()["request_envelope"].clone()).unwrap()
}

fn server() -> (Value, Vec<Value>) {
    (
        json!({"id":ORDER,"organization_id":ORG,"branch_id":BRANCH,"currency":"EUR",
        "is_closed":false,"z_report_id":null,"fiscal_receipt_number":null,"is_test":false}),
        vec![
            json!({"id":PAYMENT,"order_id":ORDER,"organization_id":ORG,"branch_id":BRANCH,
        "currency":"EUR","payment_method":"card","amount":12.5,"amount_cents":1250,"tip_amount":0,
        "tip_amount_cents":0,"created_at":AT,"status":"completed","adjustments":[],
        "refunded_amount_cents":0,"voided_amount_cents":0,"idempotency_key":"test-canonical-key",
        "metadata":{"local_payment_id":STAMPED}}),
        ],
    )
}
struct Fixture {
    db: TestDb,
    executor: Executor,
    command: Command,
    clock: clock::ServerClock,
    admission: delivery::Admission,
    scope: guards::Scope,
    now: i64,
}
impl Fixture {
    fn new() -> Self {
        let db = TestDb::open();
        let command = command();
        let store = SupportDb::open(db.dir()).unwrap();
        let now = clock::parse(&command.server_time).unwrap();
        let admission = delivery::Admission {
            session_id: command.session_id.clone(),
            confirmed: true,
            active: true,
            online: true,
            visible: true,
            tier_ceiling: 3,
            tiers_enabled: BTreeSet::from([1, 2, 3]),
            disabled_tools: BTreeSet::new(),
            max_expires_at: command.expires_at.clone(),
        };
        let mut clock = clock::ServerClock::default();
        clock
            .observe(&command.session_id, &command.server_time, Instant::now())
            .unwrap();
        store.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at)
            VALUES(?1,'active',3,?2,?2,?3)",params![command.session_id,command.expires_at,command.server_time]).unwrap();
        let scope = {
            let conn = db.state.conn.lock().unwrap();
            for (key, value) in [
                ("organization_id", ORG),
                ("branch_id", BRANCH),
                ("terminal_id", TERM),
            ] {
                crate::db::set_setting(&conn, "terminal", key, value).unwrap();
            }
            conn.execute("INSERT INTO orders(id,supabase_id,organization_id,branch_id,terminal_id,
                order_number,status,order_type,total_amount,total_amount_cents,currency,payment_status,created_at,updated_at)
                VALUES(?1,?2,?3,?4,?5,'R-1','completed','takeaway',12.5,1250,'EUR','paid',?6,?6)",
                params![LOCAL,ORDER,ORG,BRANCH,TERM,AT]).unwrap();
            for (key, value) in [
                ("currency", "EUR"),
                ("store_currency_branch_id", BRANCH),
                ("store_currency_available", "true"),
                ("store_currency_source", "branch_country"),
            ] {
                crate::db::set_setting(&conn, "restaurant", key, value).unwrap();
            }
            super::super::identity::local(&conn).unwrap()
        };
        Self {
            db,
            executor: Executor::new(store),
            command,
            clock,
            admission,
            scope,
            now,
        }
    }

    fn start(&mut self) {
        assert!(self
            .executor
            .accept(&self.command, &self.admission, &self.clock)
            .unwrap());
        self.executor
            .start(&self.command, &self.admission, &self.clock)
            .unwrap();
    }
    fn dispatch(
        &mut self,
        fetch: impl FnOnce(&str, &dyn Fn() -> Result<(), String>) -> Result<(Value, Vec<Value>), String>,
        check: impl Fn() -> Result<(), String>,
    ) -> Value {
        self.start();
        let result = self.run(fetch, check);
        super::super::dispatch::settle_confirmed(
            &mut self.executor,
            &self.command,
            result,
            self.now,
        );
        self.executor.pending_results(self.now).unwrap().remove(0)
    }
    fn run(
        &self,
        fetch: impl FnOnce(&str, &dyn Fn() -> Result<(), String>) -> Result<(Value, Vec<Value>), String>,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<Value, String> {
        run_with_fetch(
            &self.executor.db.conn,
            &self.db.state.db_path,
            &self.command,
            &self.scope,
            check,
            self.now,
            |_| Ok(()),
            fetch,
        )
    }
    fn open_drawer(&self) -> String {
        let shift = crate::shifts::open_shift(
            &self.db.state,
            &json!({
                "staffId":"receipt-test-cashier","staffName":"Cashier","branchId":BRANCH,
                "terminalId":TERM,"roleType":"cashier","openingCash":45.50
            }),
        )
        .unwrap();
        shift["shiftId"].as_str().unwrap().to_string()
    }
    fn execute(&self, sql: &str) {
        self.db
            .state
            .conn
            .lock()
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }
    fn count(&self, table: &str) -> i64 {
        self.db
            .state
            .conn
            .lock()
            .unwrap()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    fn seed_local(
        &self,
        id: &str,
        remote: Option<&str>,
        amount: f64,
        method: &str,
        currency: &str,
        tip: f64,
    ) {
        self.db.state.conn.lock().unwrap().execute("INSERT INTO order_payments(id,order_id,remote_payment_id,
            method,amount,amount_cents,currency,tip_amount,tip_amount_cents,status,sync_status,sync_state,created_at,updated_at)
            VALUES(?1,?2,?3,?4,?5,ROUND(?5*100),?6,?7,ROUND(?7*100),'completed','synced','applied',?8,?8)",
            params![id,LOCAL,remote,method,amount,currency,tip,AT]).unwrap();
    }
}
fn expect_refusal(result: &Value, index: usize) {
    let expected = vector()["refused_envelopes"][index].clone();
    for key in [
        "status",
        "error_code",
        "owner_refusal_code",
        "result_sha256",
        "data",
        "command_id",
        "session_id",
    ] {
        assert_eq!(result[key], expected[key], "{result}");
    }
    assert!(result.get("data").is_some_and(Value::is_null), "{result}");
}
fn pull(_: &str, _: &dyn Fn() -> Result<(), String>) -> Result<(Value, Vec<Value>), String> {
    Ok(server())
}

#[test]
fn golden_payment_receipt_restores_one_row_and_preserves_the_drawer_and_z_preview() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let mut f = Fixture::new();
    let preview = || json!({"branchId":BRANCH,"date":"2026-11-18"});
    let before_preview =
        crate::zreport::preview_z_report_for_date(&f.db.state, &preview()).unwrap();
    let queue_count = f.count("sync_queue");
    let result = f.dispatch(pull, || Ok(()));
    assert_eq!(result["status"], "completed", "{result}");
    let data = &result["data"];
    super::super::tools::desktop_output_contract_tests::confirmed_result(data);
    let mut golden = vector()["result_envelope"]["data"].clone();
    for name in ["snapshot_id", "affected_ids"] {
        golden[name] = data[name].clone();
    }
    golden["undo"]["reference"] = data["snapshot_id"].clone();
    golden["evidence"]["audit_ref"] = json!(f.command.command_id);
    golden["evidence"]["local_payment_id"] = data["affected_ids"][0].clone();
    let empty_payments = super::super::confirmed_hash::hash(&json!({"rows":[]}));
    let empty_returns = super::super::confirmed_hash::hash(&json!({"refunds":[],"adjustments":[]}));
    for name in ["before_totals", "after_totals"] {
        golden["evidence"][name]["other_payments_sha256"] = json!(empty_payments);
        golden["evidence"][name]["refunds_and_adjustments_sha256"] = json!(empty_returns);
    }
    assert_eq!(*data, golden);
    assert_eq!(f.count("order_payments"), 1);
    assert_eq!(f.count("payment_adjustments"), 0);
    assert_eq!(f.count("sync_queue"), queue_count);
    assert_eq!(f.count("support_payment_receipt_commits"), 1);
    let after_preview = crate::zreport::preview_z_report_for_date(&f.db.state, &preview()).unwrap();
    for key in ["cashDrawer", "staffReports", "refunds"] {
        assert_eq!(
            before_preview["report"]["reportJson"][key], after_preview["report"]["reportJson"][key],
            "{key}"
        );
    }
    let before = &before_preview["report"]["reportJson"];
    let after = &after_preview["report"]["reportJson"];
    let mut expected_sales = before["sales"].clone();
    expected_sales["cardSales"] = json!(12.5);
    expected_sales["cardSales_cents"] = json!(1250);
    expected_sales["byType"]["instore"]["card"] = json!({"count":1,"total":12.5});
    assert_eq!(after["sales"], expected_sales);
    let mut expected_tenders = before["paymentsBreakdown"].clone();
    expected_tenders["card"]["count"] = json!(1);
    expected_tenders["card"]["total"] = json!(12.5);
    assert_eq!(after["paymentsBreakdown"], expected_tenders);
    assert_eq!(
        after["countedMovements"]["paymentIds"],
        data["affected_ids"]
    );
    assert_eq!(
        after["countedMovements"]["adjustmentIds"],
        before["countedMovements"]["adjustmentIds"]
    );
    let c = f.db.state.conn.lock().unwrap();
    let balance = crate::payments::load_order_payment_balance_snapshot(&c, LOCAL).unwrap();
    assert_eq!((balance.order_total, balance.net_paid), (12.5, 12.5));
}

#[test]
fn existing_receipt_and_each_different_local_fact_use_the_closed_payment_refusals() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for (amount, method, currency, tip, index) in [
        (12.5, "card", "EUR", 0.0, 0),
        (14.0, "card", "EUR", 0.0, 1),
        (12.5, "cash", "EUR", 0.0, 1),
        (12.5, "card", "CHF", 0.0, 1),
        (12.5, "card", "EUR", 1.0, 1),
    ] {
        let mut f = Fixture::new();
        f.seed_local(STAMPED, Some(PAYMENT), amount, method, currency, tip);
        expect_refusal(&f.dispatch(pull, || Ok(())), index);
        assert_eq!(f.count("order_payments"), 1);
        assert_eq!(f.count("support_payment_receipt_commits"), 0);
    }
}

#[test]
fn ambiguous_reversed_closed_fiscal_wrong_branch_and_changed_server_receipts_refuse() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for scenario in [
        "ambiguous",
        "reversed",
        "closed",
        "closed-local",
        "fiscal",
        "branch",
        "changed",
        "currency",
    ] {
        let mut f = Fixture::new();
        let (mut order, mut ledger) = server();
        match scenario {
            "ambiguous" => f.seed_local("unrelated-placeholder", None, 12.5, "card", "EUR", 0.0),
            "reversed" => ledger[0]["status"] = json!("refunded"),
            "closed" => order["is_closed"] = json!(true),
            "closed-local" => {
                let shift = f.open_drawer();
                f.execute(&format!("INSERT INTO z_reports(id,shift_id,branch_id,terminal_id,report_date,
                    generated_at,created_at,updated_at,sync_state,close_state,window_cutoff)
                    VALUES('closed','{shift}','{BRANCH}','{TERM}','2026-11-18','2026-11-18T19:00:00Z',
                        '2026-11-18T19:00:00Z','2026-11-18T19:00:00Z','applied','swept','2026-11-18T19:00:00Z')"));
            }
            "fiscal" => order["fiscal_receipt_number"] = json!("recorded"),
            "branch" => f.execute("UPDATE orders SET branch_id='other-branch'"),
            "changed" => {
                ledger[0]["amount"] = json!(13.0);
                ledger[0]["amount_cents"] = json!(1300);
            }
            "currency" => ledger[0]["currency"] = Value::Null,
            _ => unreachable!(),
        }
        let before = f.count("order_payments");
        let result = f.dispatch(|_, _| Ok((order, ledger)), || Ok(()));
        expect_refusal(&result, 1);
        assert_eq!(f.count("order_payments"), before, "{scenario}");
        assert_eq!(f.count("support_payment_receipt_commits"), 0, "{scenario}");
    }
}

#[test]
fn end_during_fetch_snapshot_and_commit_rolls_back_and_keeps_the_receipt_missing() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for stage in ["fetch", "snapshot", "commit"] {
        let mut f = Fixture::new();
        let ended = std::rc::Rc::new(Cell::new(false));
        let hook = {
            let ended = ended.clone();
            move || {
                ended.set(true);
                critical_op::global().cancel_support();
            }
        };
        let mut fetch_hook = None;
        match stage {
            "fetch" => fetch_hook = Some(hook),
            "snapshot" => snapshot::before_business_copy_for_test(hook),
            "commit" => BEFORE_COMMIT.with(|slot| *slot.borrow_mut() = Some(Box::new(hook))),
            _ => unreachable!(),
        }
        let result = f.dispatch(
            |_, _| {
                if let Some(hook) = fetch_hook {
                    hook()
                };
                Ok(server())
            },
            || {
                if ended.get() {
                    Err("SESSION_ENDED".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(
            matches!(
                result["error_code"].as_str(),
                Some("SESSION_ENDED" | "PREEMPTED_BY_CRITICAL_OPERATION")
            ),
            "{stage}: {result}"
        );
        assert_eq!(f.count("order_payments"), 0);
        assert_eq!(f.count("support_payment_receipt_commits"), 0);
    }
}

#[test]
fn staff_sale_payment_shift_close_and_z_preempt_the_receipt_at_commit() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for kind in [
        CriticalKind::Checkout,
        CriticalKind::Card,
        CriticalKind::ShiftClose,
        CriticalKind::ZClose,
    ] {
        let mut f = Fixture::new();
        BEFORE_COMMIT.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                let _staff = critical_op::begin_critical(kind);
                assert!(critical_op::global().active());
            }))
        });
        let result = f.dispatch(pull, || Ok(()));
        assert_eq!(
            result["error_code"], "PREEMPTED_BY_CRITICAL_OPERATION",
            "{kind:?}: {result}"
        );
        assert_eq!(f.count("order_payments"), 0);
        assert_eq!(f.count("support_payment_receipt_commits"), 0);
    }
}

#[test]
fn restart_after_receipt_commit_replays_the_same_evidence_and_keeps_one_mirror() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let mut f = Fixture::new();
    let path = f.db.dir().to_path_buf();
    f.start();
    super::super::confirmed::before_post_save_for_test(|| panic!("crash after receipt commit"));
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.run(pull, || Ok(())))).is_err()
    );
    let data: Value = {
        let c = f.db.state.conn.lock().unwrap();
        let encoded: String = c
            .query_row(
                "SELECT result_json FROM support_payment_receipt_commits",
                [],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&encoded).unwrap()
    };
    drop(f.executor);
    let mut restarted = Executor::new(SupportDb::open(&path).unwrap());
    restarted.recover(f.now).unwrap();
    let first = restarted.pending_results(f.now).unwrap().remove(0);
    assert_eq!(first["data"], data);
    assert!(!restarted
        .accept(&f.command, &f.admission, &f.clock)
        .unwrap());
    assert_eq!(restarted.pending_results(f.now).unwrap(), vec![first]);
    let c = f.db.state.conn.lock().unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM order_payments", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn payment_receipt_capability_requires_the_business_journal_and_drift_checks() {
    let _keyring = fake_keyring::install_empty();
    let f = Fixture::new();
    assert!(ready(&f.db.state.conn.lock().unwrap()));
    f.execute("DROP TABLE support_payment_receipt_commits");
    assert!(!ready(&f.db.state.conn.lock().unwrap()));
    let mut command = command();
    assert!(validate(&command).is_ok());
    command.payload["rows_cap"] = json!(2);
    assert_eq!(validate(&command), Err("INVALID_INPUT"));
    command.payload["rows_cap"] = json!(1);
    command.payload["receipt_binding"]["currency"] = json!("eur");
    assert_eq!(validate(&command), Err("INVALID_INPUT"));
}

fn assert_receipt_method_refusal_before_writes(method: &str) {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let mut f = Fixture::new();
    f.command.payload["receipt_binding"]["method"] = json!(method);
    f.command.payload_sha256 = super::super::confirmed_hash::hash(&f.command.payload);
    let (order, mut ledger) = server();
    ledger[0]["payment_method"] = json!(method);

    let result = f.dispatch(|_, _| Ok((order, ledger)), || Ok(()));
    expect_refusal(&result, 1);
    assert_eq!(f.count("order_payments"), 0);
    assert_eq!(f.count("support_payment_receipt_commits"), 0);
    let snapshots: i64 = f
        .executor
        .db
        .conn
        .query_row("SELECT count(*) FROM support_snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(snapshots, 0);
}

#[test]
fn receipt_pull_refuses_online_before_writes() {
    assert_receipt_method_refusal_before_writes("online");
}

#[test]
fn receipt_pull_refuses_digital_wallet_before_writes() {
    assert_receipt_method_refusal_before_writes("digital_wallet");
}

#[test]
fn receipt_pull_refuses_split_before_writes() {
    assert_receipt_method_refusal_before_writes("split");
}

#[test]
fn payment_receipt_with_another_mirror_keeps_original_drawer_and_ledger_totals() {
    let _keyring = fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let mut f = Fixture::new();
    let shift_id = f.open_drawer();
    let read_drawer = |db: &TestDb| {
        let conn = db.state.conn.lock().unwrap();
        rows(
            &conn,
            "SELECT * FROM cash_drawer_sessions WHERE staff_shift_id=?1",
            &[&shift_id],
        )
        .unwrap()
    };
    let drawer = read_drawer(&f.db);
    assert_eq!(drawer.len(), 1);
    f.execute("UPDATE orders SET total_amount=18.5,total_amount_cents=1850");
    let other_id = "10000000-0000-4000-8000-000000000079";
    f.seed_local("other-receipt", Some(other_id), 6.0, "cash", "EUR", 0.0);
    let (order, mut ledger) = server();
    let mut other = ledger[0].clone();
    other["id"] = json!(other_id);
    other["metadata"] = json!({});
    other["idempotency_key"] = json!("different-key");
    other["amount"] = json!(6.0);
    other["amount_cents"] = json!(600);
    other["payment_method"] = json!("cash");
    ledger.push(other);
    let result = f.dispatch(|_, _| Ok((order, ledger)), || Ok(()));
    assert_eq!(result["status"], "completed", "{result}");
    let evidence = &result["data"]["evidence"];
    assert_eq!(evidence["before_totals"], evidence["after_totals"]);
    assert_eq!(evidence["after_totals"]["other_payment_total_cents"], 600);
    assert_eq!(evidence["after_totals"]["order_total_cents"], 1850);
    assert_eq!(drawer, read_drawer(&f.db));
}

#[test]
fn visible_notice_preserves_the_founder_explanation_for_the_shipped_banner() {
    let mut command = command();
    command.command_id = uuid::Uuid::new_v4().to_string();
    let mut banner = json!({"confirmed_command_id":command.command_id,"confirmed_history":[{
        "command_id":command.command_id,"state":"started","explanation":command.payload["explanation"],
        "label":{"key":"restorePaymentReceiptMirror","values":command.payload["action"]["inputs"]}
    }]});
    notice_served(&banner);
    wait_for_notice(&command, &|| Ok(())).unwrap();
    retain_compatible_notice(&mut banner);
    assert_eq!(
        banner["confirmed_history"][0]["explanation"],
        command.payload["explanation"]
    );
    assert!(banner["confirmed_history"][0].get("label").is_none());
}
