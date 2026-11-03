//! Each audited production seam is pinned to the same tested reservation helper.
use rusqlite::Connection;
use std::time::{Duration, Instant};

#[test]
fn clean_maintenance_and_empty_settings_do_not_reserve_a_writer() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let dir = crate::tests::harness::TempDir::new();
    let path = dir.path().join("pos.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE local_settings(setting_category TEXT, setting_key TEXT, setting_value TEXT, UNIQUE(setting_category,setting_key));").unwrap();
    conn.busy_timeout(Duration::from_millis(5000)).unwrap();
    let db = crate::db::DbState {
        conn: std::sync::Mutex::new(conn),
        db_path: path.clone(),
    };
    let writer = Connection::open(path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = db.conn.lock().unwrap().total_changes();
    for action in 0..4 {
        let at = Instant::now();
        match action {
            0 => assert_eq!(
                crate::commands::api_bridge::purge_customer_admin_cache(&db).unwrap(),
                0
            ),
            1 => assert_eq!(
                crate::commands::api_bridge::purge_repair_admin_cache(&db).unwrap(),
                0
            ),
            2 => crate::terminal_helpers::scrub_sensitive_local_settings_checked(&db).unwrap(),
            _ => assert!(crate::terminal_helpers::cache_terminal_settings_snapshot(
                &db,
                &serde_json::json!({})
            )
            .unwrap()
            .is_empty()),
        }
        assert!(
            at.elapsed() < Duration::from_millis(250),
            "action {action} waited for a writer"
        );
        let conn = db
            .conn
            .try_lock()
            .expect("early return released main mutex");
        assert!(conn.is_autocommit());
        assert_eq!(conn.total_changes(), before);
    }
}

#[test]
fn dirty_maintenance_rechecks_candidates_after_admission() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    for (kind, category, old, new) in [
        (
            0,
            "local",
            "admin_api_get::/api/pos/customers?old",
            "admin_api_get::/api/pos/customers?new",
        ),
        (
            1,
            "local",
            "admin_api_get::/api/pos/repairs?old",
            "admin_api_get::/api/pos/repairs?new",
        ),
        (2, "terminal", "pos_api_key", "supabase_anon_key"),
    ] {
        let fixture = crate::tests::harness::TestDb::open();
        {
            let conn = fixture.state.conn.lock().unwrap();
            crate::db::set_setting(&conn, category, old, "your-test-value").unwrap();
        }
        let path = fixture.db_path().to_owned();
        crate::admission_tests::before_admission(move |conn| {
            assert!(conn.is_autocommit());
            let other = Connection::open(path).unwrap();
            crate::db::delete_setting(&other, category, old).unwrap();
            crate::db::set_setting(&other, category, new, "your-replacement").unwrap();
        });
        match kind {
            0 => assert_eq!(
                crate::commands::api_bridge::purge_customer_admin_cache(&fixture.state).unwrap(),
                1
            ),
            1 => assert_eq!(
                crate::commands::api_bridge::purge_repair_admin_cache(&fixture.state).unwrap(),
                1
            ),
            _ => crate::terminal_helpers::scrub_sensitive_local_settings_checked(&fixture.state)
                .unwrap(),
        }
        let conn = fixture.state.conn.try_lock().unwrap();
        assert!(crate::db::get_setting(&conn, category, new).is_none());
    }
}
const PATHS: &[(&str, &str, &str, usize)] = &[
    (
        "commands/orders.rs",
        "convert_pickup_order_to_delivery_inner",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "update_customer_headers_in_connection",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "try_metadata_only_item_edit",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "order_update_items",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "persist_fetched_food_order_items",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "order_cancel_with_approval",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "change_order_driver_locally",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/orders.rs",
        "reset_order_to_active_locally",
        include_str!("../../commands/orders.rs"),
        1,
    ),
    (
        "commands/analytics.rs",
        "driver_record_earning_inner",
        include_str!("../../commands/analytics.rs"),
        1,
    ),
    (
        "commands/ecr.rs",
        "persist_fiscal_receipt_transaction_and_enqueue_backfill",
        include_str!("../../commands/ecr.rs"),
        1,
    ),
    (
        "payments.rs",
        "update_payment_method_for_payment_with_actor",
        include_str!("../../payments.rs"),
        3,
    ),
    (
        "table_attempt_recovery.rs",
        "claim",
        include_str!("../../table_attempt_recovery.rs"),
        1,
    ),
    (
        "table_attempt_recovery.rs",
        "finish",
        include_str!("../../table_attempt_recovery.rs"),
        1,
    ),
    (
        "table_attempt_recovery.rs",
        "apply_foreground_item_snapshot",
        include_str!("../../table_attempt_recovery.rs"),
        1,
    ),
    (
        "table_attempt_recovery.rs",
        "claim_original_cancel",
        include_str!("../../table_attempt_recovery.rs"),
        1,
    ),
    (
        "table_close_recovery.rs",
        "finish_confirmation",
        include_str!("../../table_close_recovery.rs"),
        1,
    ),
    (
        "table_manual_cancellation.rs",
        "release",
        include_str!("../../table_manual_cancellation.rs"),
        1,
    ),
    (
        "table_session_cache.rs",
        "item_edit_attempt",
        include_str!("../../table_session_cache.rs"),
        1,
    ),
    (
        "table_session_cache.rs",
        "cancellation_attempt",
        include_str!("../../table_session_cache.rs"),
        1,
    ),
    (
        "lan_transport.rs",
        "schema",
        include_str!("../../lan_transport.rs"),
        1,
    ),
    (
        "lan_transport.rs",
        "admit_frame",
        include_str!("../../lan_transport.rs"),
        1,
    ),
    (
        "lan_transport.rs",
        "begin_receipt",
        include_str!("../../lan_transport.rs"),
        1,
    ),
    (
        "lan_transport.rs",
        "clear_journal",
        include_str!("../../lan_transport.rs"),
        1,
    ),
    (
        "lan_transport.rs",
        "relay",
        include_str!("../../lan_transport.rs"),
        1,
    ),
    (
        "lan_transport.rs",
        "relay_read",
        include_str!("../../lan_transport.rs"),
        1,
    ),
    (
        "commands/gift_cards.rs",
        "import_canonical_gift_payment",
        include_str!("../../commands/gift_cards.rs"),
        1,
    ),
    (
        "commands/gift_card_returns.rs",
        "adopt",
        include_str!("../../commands/gift_card_returns.rs"),
        1,
    ),
    (
        "commands/api_bridge.rs",
        "purge_customer_admin_cache",
        include_str!("../../commands/api_bridge.rs"),
        1,
    ),
    (
        "commands/api_bridge.rs",
        "purge_repair_admin_cache",
        include_str!("../../commands/api_bridge.rs"),
        1,
    ),
    (
        "commands/loyalty.rs",
        "replace_loyalty_snapshot",
        include_str!("../../commands/loyalty.rs"),
        1,
    ),
    (
        "menu.rs",
        "apply_menu_payload",
        include_str!("../../menu.rs"),
        1,
    ),
    (
        "terminal_helpers.rs",
        "cache_terminal_settings_snapshot",
        include_str!("../../terminal_helpers.rs"),
        1,
    ),
    (
        "terminal_helpers.rs",
        "scrub_sensitive_local_settings_checked",
        include_str!("../../terminal_helpers.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "apply_generic_settings_updates_checked",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "restore_generic_sqlite_snapshot",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "apply_generic_settings_and_credentials_under_lock",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "persist_terminal_transition_intent",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "clear_terminal_transition_journal_verified",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "publish_terminal_binding_under_lock",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "commands/settings.rs",
        "clear_terminal_connection_lifecycle_under_lock",
        include_str!("../../commands/settings.rs"),
        1,
    ),
    (
        "capture/watcher.rs",
        "ingest_document",
        include_str!("../../capture/watcher.rs"),
        1,
    ),
    (
        "capture/watcher.rs",
        "record_rendered_pages",
        include_str!("../../capture/watcher.rs"),
        1,
    ),
    (
        "sync.rs",
        "reconcile_remote_orders",
        include_str!("../../sync.rs"),
        1,
    ),
    (
        "sync.rs",
        "defer_financial_server_retry",
        include_str!("../../sync.rs"),
        1,
    ),
    (
        "edit_settlement_recovery.rs",
        "adopt_canonical_order_scoped",
        include_str!("../../edit_settlement_recovery.rs"),
        1,
    ),
    (
        "payment_review.rs",
        "with_savepoint",
        include_str!("../../payment_review.rs"),
        1,
    ),
    (
        "commands/offline_mutations.rs",
        "persist_reservation_mutation",
        include_str!("../../commands/offline_mutations.rs"),
        1,
    ),
    (
        "commands/offline_mutations.rs",
        "mutate_staff_schedule_locally",
        include_str!("../../commands/offline_mutations.rs"),
        1,
    ),
    (
        "sync.rs",
        "mark_local_payment_applied",
        include_str!("../../sync.rs"),
        1,
    ),
    (
        "sync.rs",
        "sync_remote_payment_into_local_with_context",
        include_str!("../../sync.rs"),
        1,
    ),
    (
        "sync.rs",
        "apply_remote_payment_page",
        include_str!("../../sync.rs"),
        1,
    ),
    (
        "sync.rs",
        "apply_refund_payment_ledger",
        include_str!("../../sync.rs"),
        1,
    ),
    (
        "sync.rs",
        "apply_order_payment_ledger_before_payment_decision",
        include_str!("../../sync.rs"),
        1,
    ),
];

#[test]
fn reserved_scope_and_page_helpers_are_db_only() {
    use syn::visit::Visit;
    struct ExternalCalls;
    impl<'ast> Visit<'ast> for ExternalCalls {
        fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
            if let syn::Expr::Path(path) = &*node.func {
                let name = path.path.segments.last().unwrap().ident.to_string();
                assert!(
                    ![
                        "get_credential",
                        "get_credential_strict",
                        "current_scope",
                        "read_terminal_scope_value",
                        "load_order_terminal_visibility_scope",
                        "resolve",
                        "capture",
                        "capture_for_canonical"
                    ]
                    .contains(&name.as_str()),
                    "external scope read in admitted helper: {name}"
                );
            }
            syn::visit::visit_expr_call(self, node);
        }
        fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
            assert!(
                !["exists", "metadata", "read", "read_to_string"]
                    .contains(&node.method.to_string().as_str()),
                "filesystem read in admitted helper"
            );
            syn::visit::visit_expr_method_call(self, node);
        }
    }
    for (source, names) in [
        (
            include_str!("../../capture/store.rs"),
            &["record_validated_page"][..],
        ),
        (
            include_str!("../../table_session_cache.rs"),
            &[
                "item_edit_attempt_inner",
                "save_scoped",
                "remember_order_history_with_scope",
                "invalidate_scoped",
            ][..],
        ),
        (
            include_str!("../../table_attempt_recovery.rs"),
            &[
                "remember",
                "remember_item_scoped",
                "remember_cancel_scoped",
                "foreground_applied_scoped",
                "retire_cancelled_edits_scoped",
            ][..],
        ),
        (
            include_str!("../../table_manual_cancellation.rs"),
            &["original_scoped", "mirror_scoped"][..],
        ),
        (
            include_str!("../../sync.rs"),
            &[
                "apply_lan_canonical_response_scoped",
                "apply_lan_canonical_response_inner",
            ][..],
        ),
        (
            include_str!("../../table_close_recovery.rs"),
            &["select_original_scoped"][..],
        ),
        (
            include_str!("../../edit_settlement_recovery.rs"),
            &["adopt_canonical_order_inner"][..],
        ),
        (
            include_str!("../../hotel_folio.rs"),
            &["import_with_scope"][..],
        ),
    ] {
        let syntax = syn::parse_file(source).unwrap();
        for name in names {
            let function = syntax
                .items
                .iter()
                .find_map(|item| match item {
                    syn::Item::Fn(function) if function.sig.ident == *name => Some(function),
                    _ => None,
                })
                .unwrap();
            ExternalCalls.visit_block(&function.block);
        }
    }
}

#[test]
fn every_audited_write_path_reserves_before_reading() {
    use syn::visit::Visit;
    #[derive(Default)]
    struct Calls {
        immediate: usize,
        deferred: usize,
    }
    impl<'ast> Visit<'ast> for Calls {
        fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
            if let syn::Expr::Path(path) = &*node.func {
                if path.path.segments.last().is_some_and(|p| {
                    p.ident == "immediate_transaction" || p.ident == "with_immediate_admission"
                }) {
                    self.immediate += 1;
                }
            }
            syn::visit::visit_expr_call(self, node);
        }
        fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
            if node.method == "transaction" || node.method == "unchecked_transaction" {
                self.deferred += 1;
            }
            syn::visit::visit_expr_method_call(self, node);
        }
    }
    for (file, name, source, count) in PATHS {
        let syntax = syn::parse_file(source).unwrap();
        let function = syntax
            .items
            .iter()
            .find_map(|i| match i {
                syn::Item::Fn(f) if f.sig.ident == *name => Some(f),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{file}::{name}"));
        let mut calls = Calls::default();
        calls.visit_block(&function.block);
        assert_eq!(calls.immediate, *count, "{file}::{name}");
        assert_eq!(calls.deferred, 0, "{file}::{name}");
    }
}
#[test]
fn each_audited_path_reproduces_deferred_busy_and_uses_the_waiting_helper() {
    let dir = std::env::temp_dir().join(format!("support-admission-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pos.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;CREATE TABLE probe(value INTEGER);INSERT INTO probe VALUES(0);",
    )
    .unwrap();
    conn.busy_timeout(Duration::from_secs(2)).unwrap();
    for (file, function, _, count) in PATHS {
        for site in 0..*count {
            let support = Connection::open(&path).unwrap();
            conn.execute_batch("BEGIN DEFERRED").unwrap();
            conn.query_row("SELECT value FROM probe", [], |r| r.get::<_, i64>(0))
                .unwrap();
            support
                .execute_batch("BEGIN IMMEDIATE;UPDATE probe SET value=value+1;")
                .unwrap();
            let at = Instant::now();
            let error = conn
                .execute("UPDATE probe SET value=value+1", [])
                .unwrap_err();
            assert_eq!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy),
                "{file}::{function}#{site}"
            );
            assert!(
                at.elapsed() < Duration::from_millis(250),
                "DEFERRED upgrade did not reproduce instant busy"
            );
            conn.execute_batch("ROLLBACK").unwrap();
            let writer = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(40));
                support.execute_batch("COMMIT").unwrap();
            });
            let at = Instant::now();
            crate::db::with_immediate_admission(&conn, || {
                let latest = conn
                    .query_row("SELECT value FROM probe", [], |r| r.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?;
                conn.execute("UPDATE probe SET value=?1", [latest + 1])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
            let tx = crate::db::immediate_transaction(&conn).unwrap();
            let latest = tx
                .query_row("SELECT value FROM probe", [], |r| r.get::<_, i64>(0))
                .unwrap();
            tx.execute("UPDATE probe SET value=?1", [latest + 1])
                .unwrap();
            tx.commit().unwrap();
            writer.join().unwrap();
            assert!(
                at.elapsed() >= Duration::from_millis(25),
                "{file}::{function}#{site} must wait for the writer"
            );
        }
    }
    drop(conn);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn savepoint_admission_preserves_nested_rollback_and_caller_commit_ownership() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE probe(value INTEGER)")
        .unwrap();
    let outer = crate::db::immediate_transaction(&conn).unwrap();
    outer.execute("INSERT INTO probe VALUES(1)", []).unwrap();
    let answer =
        crate::payment_review::with_savepoint(&conn, "nested_probe", || -> Result<(), String> {
            conn.execute("INSERT INTO probe VALUES(2)", []).unwrap();
            Err("your-test-refusal".into())
        });
    assert!(answer.is_err());
    assert!(!conn.is_autocommit());
    assert_eq!(
        conn.query_row("SELECT sum(value) FROM probe", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(outer);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM probe", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let answer = crate::db::with_immediate_admission(&conn, || -> Result<(), String> {
        conn.execute("INSERT INTO probe VALUES(3)", []).unwrap();
        Err("your-test-refusal".into())
    });
    assert!(answer.is_err());
    assert!(conn.is_autocommit());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM probe", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
