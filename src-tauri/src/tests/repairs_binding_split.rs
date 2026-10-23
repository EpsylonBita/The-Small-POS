//! Π1, 21/10/2026: the terminal-binding gate and the Repairs gate are split.
//!
//! A Repairs access decision may deny Repairs. It never refuses an ordinary
//! POS write, never moves the binding generation and never reads as a pending
//! terminal rebind. Rebind, rollback, operational clear and reset still close
//! the binding gate, durably where they did before.
use super::*;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;
use std::time::Duration;

const ORG: &str = "11111111-1111-4111-8111-111111111111";
const BRANCH: &str = "22222222-2222-4222-8222-222222222222";
const TERMINAL: &str = "terminal-alpha";
const ADMIN_URL: &str = "https://admin.example.test";
const SESSION: &str = "99999999-9999-4999-8999-999999999999";
const STAFF: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPAIR: &str = "44444444-4444-4444-8444-444444444444";
const OPERATION: &str = "66666666-6666-4666-8666-666666666666";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    WithRepairs,
    WithoutRepairs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trigger {
    DisabledFirst,
    DisabledRepeated,
    DisabledFirstAfterRestart,
    EnabledSameBinding,
    EnabledFirst,
    EnabledWaitingForBootstrap,
    NetworkOr5xx,
    Auth401Or403,
    NotFound404OrRateLimited429,
    MalformedPayload,
    PayloadIdentityMismatch,
    DigestChangedMidFetch,
    KeyringReadFailure,
    KeyringDeleteFailure,
    CachePurgeFailure,
    JanitorFailure,
    LogoutClearFailure,
    ExpiredActorOffline,
    RevokePurgeFailsHalfway,
    RevokeRemoveDirFailsHalfway,
    ApiKeyRotationWhileBootstrapPending,
}

const TRIGGERS: [Trigger; 21] = [
    Trigger::DisabledFirst,
    Trigger::DisabledRepeated,
    Trigger::DisabledFirstAfterRestart,
    Trigger::EnabledSameBinding,
    Trigger::EnabledFirst,
    Trigger::EnabledWaitingForBootstrap,
    Trigger::NetworkOr5xx,
    Trigger::Auth401Or403,
    Trigger::NotFound404OrRateLimited429,
    Trigger::MalformedPayload,
    Trigger::PayloadIdentityMismatch,
    Trigger::DigestChangedMidFetch,
    Trigger::KeyringReadFailure,
    Trigger::KeyringDeleteFailure,
    Trigger::CachePurgeFailure,
    Trigger::JanitorFailure,
    Trigger::LogoutClearFailure,
    Trigger::ExpiredActorOffline,
    Trigger::RevokePurgeFailsHalfway,
    Trigger::RevokeRemoveDirFailsHalfway,
    Trigger::ApiKeyRotationWhileBootstrapPending,
];

struct Terminal {
    database: std::sync::Arc<TestDb>,
    _keyring: fake_keyring::Guard,
}

fn active_scope_fixture() -> RepairScopeState {
    RepairScopeState {
        version: 1,
        organization_id: ORG.to_string(),
        branch_id: BRANCH.to_string(),
        terminal_id: TERMINAL.to_string(),
        scope_token: "33333333-3333-4333-8333-333333333333".to_string(),
        scope_epoch: 7,
        transition_pending: false,
        reset_pending: false,
        pending_purpose: None,
        offline_terminal_token: Some("A19F".to_string()),
        offline_sequence_lease_start: Some(1),
        offline_sequence_lease_end: Some(100),
        settings_cache: None,
        disabled_with_quarantine: false,
    }
}

fn actor_attestation(valid: bool) -> String {
    let now = chrono::Utc::now();
    let (issued_at, expires_at) = if valid {
        (
            now - chrono::Duration::minutes(1),
            now + chrono::Duration::hours(1),
        )
    } else {
        (
            now - chrono::Duration::hours(2),
            now - chrono::Duration::hours(1),
        )
    };
    let mut permissions = crate::repair_transport::REPAIR_PERMISSIONS
        .iter()
        .map(|permission| (*permission).to_string())
        .collect::<Vec<_>>();
    permissions.sort();
    serde_json::json!({
        "version": 1,
        "organization_id": ORG,
        "branch_id": BRANCH,
        "terminal_public_id": TERMINAL,
        "staff_id": STAFF,
        "staff_session_id": SESSION,
        "issued_at": issued_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "session_expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "offline_expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "permissions": permissions,
    })
    .to_string()
}

/// A configured terminal whose SQLite mirror matches its keyring identity, so
/// no modules answer rewrites the binding. With Repairs it holds an active
/// entitled scope and a signed-in technician; without Repairs it has already
/// settled one full revoke, as Tomikro and Le Petit Paris have.
fn till(kind: Kind) -> Terminal {
    let scope = active_scope_fixture();
    let entitlement = RepairEntitlementState {
        version: ENTITLEMENT_VERSION,
        organization_id: ORG.to_string(),
        branch_id: BRANCH.to_string(),
        terminal_id: TERMINAL.to_string(),
        scope_epoch: scope.scope_epoch,
        enabled: true,
        verified_at: "2026-10-20T00:00:00Z".to_string(),
    };
    let keyring = fake_keyring::install_seeded([
        ("organization_id", ORG.to_string()),
        ("branch_id", BRANCH.to_string()),
        ("terminal_id", TERMINAL.to_string()),
        ("admin_dashboard_url", ADMIN_URL.to_string()),
        ("pos_api_key", "test-api-key".to_string()),
        (
            crate::storage::KEY_REPAIR_SCOPE_V1,
            serde_json::to_string(&scope).unwrap(),
        ),
        (
            crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
            serde_json::to_string(&entitlement).unwrap(),
        ),
        (
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            actor_attestation(true),
        ),
        (
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            base64::engine::general_purpose::STANDARD.encode([7_u8; 32]),
        ),
    ]);
    let database = TestDb::open();
    {
        let connection = database.state.conn.lock().unwrap();
        persist_runtime_identity(&connection, ORG, BRANCH, TERMINAL).unwrap();
        crate::db::set_setting(&connection, "terminal", "admin_dashboard_url", ADMIN_URL).unwrap();
    }
    let terminal = Terminal {
        database: std::sync::Arc::new(database),
        _keyring: keyring,
    };
    if kind == Kind::WithoutRepairs {
        disabled_answer(&terminal.database.state).expect("settle the terminal without Repairs");
    }
    terminal
}

/// A freshly configured terminal that never had a repair scope: its first
/// modules answer publishes the first one.
fn fresh_till() -> Terminal {
    let terminal = till(Kind::WithRepairs);
    for key in [
        crate::storage::KEY_REPAIR_SCOPE_V1,
        crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
        crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
    ] {
        fake_keyring::delete(key);
    }
    terminal
}

fn answer(state: &crate::db::DbState, enabled: bool) -> Result<RepairAccessReconciliation, String> {
    let decision = start_authoritative_access_decision()?;
    let digest = crate::commands::settings::current_access_binding_digest()?;
    begin_bound_authoritative_access_reconciliation(
        state,
        ORG,
        BRANCH,
        TERMINAL,
        enabled,
        decision,
        digest.as_deref(),
    )
}

// The fake keyring is thread-local; a revoke worker must see the same
// credentials and repair scope as the thread holding the in-flight lease.
fn worker_credentials() -> Vec<(String, String)> {
    [
        "organization_id",
        "branch_id",
        "terminal_id",
        "admin_dashboard_url",
        "pos_api_key",
        crate::storage::KEY_REPAIR_SCOPE_V1,
        crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
        crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
    ]
    .into_iter()
    .filter_map(|key| fake_keyring::get(key).map(|value| (key.to_string(), value)))
    .collect()
}

fn disabled_answer(state: &crate::db::DbState) -> Result<RepairAccessReconciliation, String> {
    answer(state, false)
}

fn binding_generation(context: &str) -> u64 {
    acquire_terminal_binding_lease()
        .unwrap_or_else(|error| panic!("{context}: the binding lease was refused: {error}"))
        .generation()
}

fn rebind_pending(terminal: &Terminal) -> bool {
    crate::commands::settings::terminal_connection_rebind_pending(&terminal.database.state)
        .expect("read the rebind marker")
}

/// The sales-side invariants every trigger must keep.
fn assert_sales_admitted(terminal: &Terminal, generation: u64, context: &str) {
    assert_eq!(
        binding_generation(context),
        generation,
        "{context}: the binding generation moved under an in-flight parity sync"
    );
    assert!(
        !rebind_pending(terminal),
        "{context}: a Repairs decision reads as a pending terminal rebind"
    );
    assert!(
        !operational_clear_transition_pending().unwrap(),
        "{context}: the durable marker counts an access decision"
    );
    // Every admin call resolves its endpoint through the same marker.
    let resolved = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(crate::resolve_admin_endpoint(Some(
            &terminal.database.state,
        )));
    if let Err(error) = resolved {
        panic!("{context}: the admin resolver refused: {error}");
    }
}

fn seed_repair_cache_row(terminal: &Terminal) {
    let connection = terminal.database.state.conn.lock().unwrap();
    connection
        .execute(
            "INSERT INTO repair_cache (
                 organization_id, branch_id, terminal_id, repair_id, scope_generation,
                 display_number, status, authoritative_status, priority, intake_mode,
                 authoritative_version, optimistic_version, dirty, has_conflict,
                 needs_refetch, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 7, 'R-OFF-A19F-000099', 'received',
                       'received', 'normal', 'standard', 0, 0, 0, 0, 0,
                       datetime('now'), datetime('now'))",
            params![ORG, BRANCH, TERMINAL, REPAIR],
        )
        .unwrap();
}

/// Apply one trigger. Returns whether the repair transport may legitimately
/// stay open afterwards (only a verified offline retention keeps it).
fn apply(terminal: &Terminal, kind: Kind, trigger: Trigger) -> bool {
    match trigger {
        Trigger::DisabledFirst => {
            let outcome =
                disabled_answer(&terminal.database.state).expect("a first disabled answer");
            assert!(outcome.is_disabled());
            false
        }
        Trigger::DisabledRepeated => {
            disabled_answer(&terminal.database.state).expect("a first disabled answer");
            let outcome =
                disabled_answer(&terminal.database.state).expect("a repeated disabled answer");
            assert!(
                outcome.is_unchanged(),
                "a repeated answer re-ran the revoke"
            );
            false
        }
        Trigger::DisabledFirstAfterRestart => {
            disabled_answer(&terminal.database.state).expect("a first disabled answer");
            reset_lifecycle_state_for_test();
            let outcome = disabled_answer(&terminal.database.state)
                .expect("the first answer after a restart");
            assert!(
                outcome.is_unchanged(),
                "a restart made the answer re-run the revoke"
            );
            false
        }
        Trigger::EnabledSameBinding | Trigger::EnabledFirst => {
            let outcome = answer(&terminal.database.state, true).expect("an enabled answer");
            assert!(!outcome.is_disabled());
            false
        }
        Trigger::EnabledWaitingForBootstrap => {
            answer(&terminal.database.state, true).expect("an enabled answer");
            answer(&terminal.database.state, true)
                .expect("a second enabled answer before the bootstrap");
            false
        }
        Trigger::NetworkOr5xx => {
            let decision = start_authoritative_access_decision().unwrap();
            let retained =
                retain_verified_access_after_network_failure(&terminal.database.state, decision);
            // A Repairs store with a live technician keeps Repairs offline.
            kind == Kind::WithRepairs && retained.is_ok()
        }
        Trigger::Auth401Or403
        | Trigger::NotFound404OrRateLimited429
        | Trigger::MalformedPayload
        | Trigger::PayloadIdentityMismatch => {
            // `modules_fetch_from_admin` latches each of these answers.
            let decision = start_authoritative_access_decision().unwrap();
            latch_authoritative_access_pending(decision).expect("latch the refused answer");
            false
        }
        Trigger::DigestChangedMidFetch => {
            let decision = start_authoritative_access_decision().unwrap();
            assert!(fake_keyring::set("pos_api_key", "test-api-key-rotated"));
            latch_authoritative_access_pending(decision).expect("latch the stale answer");
            false
        }
        Trigger::KeyringReadFailure => {
            fake_keyring::fail_reads_for(
                crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
                "fixture keyring locked",
            );
            let failed = disabled_answer(&terminal.database.state);
            fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_ENTITLEMENT_V1);
            assert!(failed.is_err(), "the unreadable key must fail the revoke");
            false
        }
        Trigger::KeyringDeleteFailure => {
            fake_keyring::set(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, "{}");
            fake_keyring::fail_deletes_for(
                crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
                "fixture keyring locked",
            );
            let failed = disabled_answer(&terminal.database.state);
            fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_ENTITLEMENT_V1);
            assert!(failed.is_err(), "the undeletable key must fail the revoke");
            false
        }
        Trigger::CachePurgeFailure => {
            // `lib.rs` latches this when the attachment cache cannot be purged.
            latch_startup_repair_maintenance_failure();
            false
        }
        Trigger::JanitorFailure => {
            let connection = terminal.database.state.conn.lock().unwrap();
            let root = staging_root(&connection).unwrap();
            if root.exists() {
                fs::remove_dir_all(&root).unwrap();
            }
            fs::write(&root, b"not a directory").unwrap();
            assert!(run_startup_staging_janitor(&connection).is_err());
            fs::remove_file(&root).unwrap();
            false
        }
        Trigger::LogoutClearFailure => {
            fake_keyring::fail_deletes_for(
                crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
                "fixture keyring locked",
            );
            let cleared = crate::repair_transport::clear_repair_actor_attestation();
            fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1);
            if kind == Kind::WithRepairs {
                assert!(cleared.is_err());
            }
            false
        }
        Trigger::ExpiredActorOffline => {
            fake_keyring::set(
                crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
                &actor_attestation(false),
            );
            let decision = start_authoritative_access_decision().unwrap();
            assert!(retain_verified_access_after_network_failure(
                &terminal.database.state,
                decision
            )
            .is_err());
            false
        }
        Trigger::RevokePurgeFailsHalfway => {
            seed_repair_cache_row(terminal);
            fake_keyring::set(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, "{}");
            {
                let connection = terminal.database.state.conn.lock().unwrap();
                connection
                    .execute_batch(
                        "CREATE TRIGGER fixture_purge_fails BEFORE DELETE ON repair_cache
                         BEGIN SELECT RAISE(ABORT, 'fixture purge failure'); END;",
                    )
                    .unwrap();
            }
            assert!(disabled_answer(&terminal.database.state).is_err());
            assert_unverified_access_pending();
            false
        }
        Trigger::RevokeRemoveDirFailsHalfway => {
            fake_keyring::set(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, "{}");
            {
                let connection = terminal.database.state.conn.lock().unwrap();
                let scope = load_scope_raw().unwrap().unwrap();
                let directory = scope_staging_dir(&connection, &scope).unwrap();
                fs::create_dir_all(directory.parent().unwrap()).unwrap();
                // remove_dir_all refuses a file where the scope directory
                // belongs, as it refuses a folder an antivirus holds open.
                fs::write(&directory, b"locked").unwrap();
            }
            assert!(disabled_answer(&terminal.database.state).is_err());
            assert_unverified_access_pending();
            false
        }
        Trigger::ApiKeyRotationWhileBootstrapPending => {
            answer(&terminal.database.state, true)
                .expect("an enabled answer waiting for its bootstrap");
            assert!(fake_keyring::set("pos_api_key", "test-api-key-rotated"));
            false
        }
    }
}

fn assert_unverified_access_pending() {
    let scope = load_scope_raw().unwrap().unwrap();
    assert!(scope.transition_pending);
    assert!(matches!(
        scope.pending_purpose,
        Some(RepairPendingPurpose::AccessReconciliation {
            verified: false,
            ..
        })
    ));
}

#[test]
#[serial_test::serial]
fn no_repairs_trigger_refuses_an_ordinary_sale_or_reads_as_a_rebind() {
    let lifecycle = isolate_lifecycle_for_test();
    for kind in [Kind::WithRepairs, Kind::WithoutRepairs] {
        for trigger in TRIGGERS {
            lifecycle.reset();
            let context = format!("{kind:?} / {trigger:?}");
            let terminal = if kind == Kind::WithoutRepairs && trigger == Trigger::DisabledFirst {
                fresh_till()
            } else {
                till(kind)
            };
            let generation = binding_generation(&context);
            let repair_may_stay_open = apply(&terminal, kind, trigger);

            assert_sales_admitted(&terminal, generation, &context);
            let repair = acquire_transport_lease();
            if repair_may_stay_open {
                drop(repair.unwrap_or_else(|error| {
                    panic!(
                        "{context}: verified offline Repairs was lost: {}",
                        error.code()
                    )
                }));
            } else {
                assert!(
                    repair.is_err(),
                    "{context}: the repair transport stayed open after the trigger"
                );
            }

            // The same holds after a restart with the durable state it left.
            reset_lifecycle_state_for_test();
            assert_sales_admitted(&terminal, binding_generation(&context), &context);
            fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_ENTITLEMENT_V1);
        }
    }
}

#[test]
#[serial_test::serial]
fn a_repairs_decision_never_waits_for_a_card_payment_at_the_ecr() {
    let _lifecycle = isolate_lifecycle_for_test();
    let terminal = till(Kind::WithRepairs);
    seed_repair_cache_row(&terminal);
    // A fiscal checkout holds its binding lease across the device await.
    let slow_ecr = acquire_terminal_binding_lease().expect("the card payment starts");
    let generation = slow_ecr.generation();

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker = {
        let database = std::sync::Arc::clone(&terminal.database);
        let credentials = worker_credentials();
        std::thread::spawn(move || {
            let _keyring = fake_keyring::install_seeded(credentials);
            let result = disabled_answer(&database.state).map(|outcome| outcome.is_disabled());
            done_tx.send(result).unwrap();
        })
    };
    let revoked = done_rx.recv_timeout(Duration::from_secs(5));
    if revoked.is_err() {
        // Release and join even under the all-readers negative control.
        drop(slow_ecr);
        worker.join().unwrap();
        panic!("the revoke waited for a generic binding reader");
    }
    let revoked = revoked.unwrap();
    assert_eq!(revoked, Ok(true));
    worker.join().unwrap();
    // Other sales keep being admitted while the card payment is still open.
    let cart_save = acquire_terminal_binding_lease().expect("a cart save is admitted");
    assert_eq!(cart_save.generation(), generation);
    drop(cart_save);
    drop(slow_ecr);
    let connection = terminal.database.state.conn.lock().unwrap();
    let rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM repair_cache", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0, "the revoke purged Repairs state");
}

#[test]
#[serial_test::serial]
fn a_revoke_quarantine_waits_for_parity_holding_a_repair_lease_on_a_repair_row() {
    let _lifecycle = isolate_lifecycle_for_test();
    let terminal = till(Kind::WithRepairs);
    {
        let connection = terminal.database.state.conn.lock().unwrap();
        crate::sync_queue::enqueue_repair_with_fixed_id(
            &connection,
            OPERATION,
            REPAIR,
            &crate::sync_queue::EnqueueInput {
                table_name: "repairs".to_string(),
                record_id: REPAIR.to_string(),
                operation: "INSERT".to_string(),
                data: "ciphertext-only".to_string(),
                organization_id: ORG.to_string(),
                priority: Some(1),
                module_type: Some("repairs".to_string()),
                conflict_strategy: Some("manual".to_string()),
                version: Some(1),
            },
        )
        .unwrap();
    }
    // Parity takes the repair lease before it claims the repair row.
    let parity = acquire_transport_lease().expect("parity holds its repair lease");
    assert_eq!(lifecycle_snapshot_for_test().repair_readers, 1);

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker = {
        let database = std::sync::Arc::clone(&terminal.database);
        let credentials = worker_credentials();
        std::thread::spawn(move || {
            let _keyring = fake_keyring::install_seeded(credentials);
            done_tx
                .send(disabled_answer(&database.state).is_ok())
                .unwrap();
        })
    };
    assert!(
        done_rx.recv_timeout(Duration::from_millis(400)).is_err(),
        "the purge ran while parity held its repair lease"
    );
    let queued: i64 = terminal
        .database
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
            [OPERATION],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queued, 1, "the repair row was deleted mid-claim");
    // The binding stays open to sales while the access decision waits.
    drop(acquire_terminal_binding_lease().expect("sales are admitted meanwhile"));
    drop(parity);
    assert!(done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the purge resumes once parity releases its lease"));
    worker.join().unwrap();
    let remaining: i64 = terminal
        .database
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
            [OPERATION],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        remaining, 1,
        "the unacknowledged repair row stays quarantined"
    );
}

#[test]
#[serial_test::serial]
fn binding_writers_still_close_the_binding_gate() {
    let lifecycle = isolate_lifecycle_for_test();

    // Rebind: an identity credential write.
    let terminal = till(Kind::WithRepairs);
    let generation = binding_generation("before the rebind");
    before_identity_credential_write("organization_id", Some(STAFF)).unwrap();
    assert_eq!(
        acquire_terminal_binding_lease().unwrap_err(),
        "REPAIR_SCOPE_TRANSITION_PENDING"
    );
    assert!(rebind_pending(&terminal), "a rebind must stay durable");
    assert!(lifecycle_snapshot_for_test().binding_epoch > generation);
    drop(terminal);

    // An identity write on top of a pending Repairs decision relabels it, so
    // the rebind still survives a restart.
    lifecycle.reset();
    let terminal = till(Kind::WithRepairs);
    answer(&terminal.database.state, true).expect("an enabled answer waiting for its bootstrap");
    assert!(!rebind_pending(&terminal));
    before_identity_credential_write("branch_id", Some(STAFF)).unwrap();
    assert!(matches!(
        load_scope_raw().unwrap().unwrap().pending_purpose,
        Some(RepairPendingPurpose::IdentityTransition)
    ));
    reset_lifecycle_state_for_test();
    assert!(rebind_pending(&terminal));
    drop(terminal);

    // Rollback publication pending.
    lifecycle.reset();
    let terminal = till(Kind::WithRepairs);
    let generation = binding_generation("before the rollback");
    let publication = prepare_legacy_terminal_identity_rollback(ORG, BRANCH, TERMINAL).unwrap();
    assert!(acquire_terminal_binding_lease().is_err());
    assert!(rebind_pending(&terminal));
    finish_terminal_identity_rollback(publication).unwrap();
    assert!(binding_generation("after the rollback") > generation);
    drop(terminal);

    // An abandoned rollback publication stays closed.
    lifecycle.reset();
    let terminal = till(Kind::WithRepairs);
    drop(prepare_legacy_terminal_identity_rollback(ORG, BRANCH, TERMINAL).unwrap());
    assert!(acquire_terminal_binding_lease().is_err());
    assert!(rebind_pending(&terminal));
    drop(terminal);

    // Operational clear.
    lifecycle.reset();
    let terminal = till(Kind::WithoutRepairs);
    let generation = binding_generation("before the clear");
    let guard = arm_operational_clear().unwrap();
    assert!(acquire_terminal_binding_lease().is_err());
    assert!(
        rebind_pending(&terminal),
        "an armed clear must stay durable"
    );
    {
        let connection = terminal.database.state.conn.lock().unwrap();
        complete_operational_clear(&connection, &guard).unwrap();
        finish_operational_clear(&connection, &guard).unwrap();
    }
    drop(guard);
    assert!(binding_generation("after the clear") > generation);
    assert!(!rebind_pending(&terminal));
    drop(terminal);

    // Reset.
    lifecycle.reset();
    let terminal = till(Kind::WithoutRepairs);
    let reset = arm_process_reset().unwrap();
    assert_eq!(
        acquire_terminal_binding_lease().unwrap_err(),
        "REPAIR_RESET_PENDING"
    );
    assert!(rebind_pending(&terminal));
    // The reset guard owns the transition mutex until the process exits.
    drop(reset);
    drop(terminal);

    // Identity compensation failure and the startup binding latch.
    lifecycle.reset();
    let terminal = till(Kind::WithoutRepairs);
    fake_keyring::replace_next_write_with("organization_id", "mixed-identity");
    fake_keyring::after_next_write("terminal_id", || {
        fake_keyring::fail_writes_for("organization_id", "fixture keyring locked")
    });
    assert_eq!(
        crate::storage::replace_repair_identity_uncoordinated(STAFF, BRANCH, TERMINAL).unwrap_err(),
        "REPAIR_IDENTITY_COMPENSATION_FAILED"
    );
    fake_keyring::clear_failures_for("organization_id");
    assert_eq!(
        acquire_terminal_binding_lease().unwrap_err(),
        "REPAIR_STAGING_MAINTENANCE_FAILED"
    );
    // A Repairs decision cannot clear a binding latch.
    let _ = disabled_answer(&terminal.database.state);
    assert!(acquire_terminal_binding_lease().is_err());
    drop(terminal);

    lifecycle.reset();
    latch_startup_binding_maintenance_failure();
    assert_eq!(
        acquire_terminal_binding_lease().unwrap_err(),
        "REPAIR_STAGING_MAINTENANCE_FAILED"
    );
}

#[test]
#[serial_test::serial]
fn a_binding_rewriting_answer_closes_and_reopens_the_binding_gate() {
    let _lifecycle = isolate_lifecycle_for_test();
    let terminal = till(Kind::WithoutRepairs);
    // The SQLite mirror diverged from the keyring: applying the answer is a
    // real binding write, so it is the binding writer's to own.
    {
        let connection = terminal.database.state.conn.lock().unwrap();
        crate::db::delete_setting(&connection, "terminal", "branch_id").unwrap();
    }
    fake_keyring::set(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, "{}");
    let generation = binding_generation("before the rewrite");
    let outcome = disabled_answer(&terminal.database.state).expect("the rewrite completes");
    assert!(outcome.is_disabled());
    assert!(binding_generation("after the rewrite") > generation);
    let connection = terminal.database.state.conn.lock().unwrap();
    assert_eq!(
        sqlite_runtime_identity(&connection).unwrap(),
        (ORG.to_string(), BRANCH.to_string(), TERMINAL.to_string())
    );
    drop(connection);

    // A rebind owning the binding is never reopened by a modules answer.
    {
        let connection = terminal.database.state.conn.lock().unwrap();
        crate::db::delete_setting(&connection, "terminal", "branch_id").unwrap();
    }
    fake_keyring::set(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, "{}");
    close_terminal_binding_for_test();
    assert_eq!(
        disabled_answer(&terminal.database.state).unwrap_err(),
        "REPAIR_SCOPE_TRANSITION_PENDING"
    );
    assert!(acquire_terminal_binding_lease().is_err());
    assert!(crate::storage::read_repair_transition_journal()
        .unwrap()
        .is_none());
}

#[test]
#[serial_test::serial]
fn a_binding_rewriting_answer_detects_keyring_only_identity_drift() {
    let _lifecycle = isolate_lifecycle_for_test();
    let terminal = till(Kind::WithRepairs);
    // Keep SQLite aligned with the answer: only the keyring comparison can
    // detect that publishing this answer is a real identity write.
    assert!(fake_keyring::set("branch_id", STAFF));
    let generation = binding_generation("before the keyring rewrite");
    let outcome = disabled_answer(&terminal.database.state).expect("the rewrite completes");
    assert!(outcome.is_disabled());
    assert!(binding_generation("after the keyring rewrite") > generation);
    assert_eq!(
        runtime_scope_identity_from_keyring().unwrap(),
        (ORG.to_string(), BRANCH.to_string(), TERMINAL.to_string())
    );
}

#[test]
#[serial_test::serial]
fn renderer_repair_access_reports_unavailable_while_repairs_is_latched() {
    let lifecycle = isolate_lifecycle_for_test();
    for latch in ["access", "repair_maintenance"] {
        lifecycle.reset();
        let terminal = till(Kind::WithRepairs);
        {
            let connection = terminal.database.state.conn.lock().unwrap();
            drop(acquire_renderer_access(&connection).expect("Repairs is available"));
        }
        match latch {
            "access" => {
                latch_startup_access_pending().unwrap();
                assert!(lifecycle_snapshot_for_test().access_blocked);
            }
            _ => {
                latch_startup_repair_maintenance_failure();
                assert!(lifecycle_snapshot_for_test().repair_maintenance_failed);
            }
        }
        let connection = terminal.database.state.conn.lock().unwrap();
        assert!(acquire_renderer_access(&connection).is_err(), "{latch}");
        drop(connection);
        drop(acquire_terminal_binding_lease().expect("sales stay admitted"));
    }
}

/// The scope JSON exactly as 1.4.134 serialized it, per durable purpose.
fn legacy_scope_json(purpose: Option<&str>, reset_pending: bool) -> String {
    let purpose = purpose.map_or(String::new(), |purpose| {
        format!(r#","pending_purpose":{purpose}"#)
    });
    format!(
        r#"{{"version":1,"organization_id":"{ORG}","branch_id":"{BRANCH}","terminal_id":"{TERMINAL}","scope_token":"33333333-3333-4333-8333-333333333333","scope_epoch":8,"transition_pending":true,"reset_pending":{reset_pending}{purpose},"offline_terminal_token":null,"offline_sequence_lease_start":null,"offline_sequence_lease_end":null}}"#
    )
}

#[test]
#[serial_test::serial]
fn upgrade_from_1_4_134_unblocks_only_the_access_purposes() {
    let lifecycle = isolate_lifecycle_for_test();
    let digest = "ab".repeat(32);
    let cases = [
        (
            "access verified",
            legacy_scope_json(
                Some(&format!(
                    r#"{{"kind":"access_reconciliation","binding_digest":"{digest}","verified":true}}"#
                )),
                false,
            ),
            false,
        ),
        (
            "access unverified",
            legacy_scope_json(
                Some(&format!(
                    r#"{{"kind":"access_reconciliation","binding_digest":"{digest}","verified":false,"retry_not_before":1}}"#
                )),
                false,
            ),
            false,
        ),
        (
            "access without digest",
            legacy_scope_json(
                Some(r#"{"kind":"access_reconciliation","binding_digest":null,"verified":false}"#),
                false,
            ),
            false,
        ),
        (
            "identity transition",
            legacy_scope_json(Some(r#"{"kind":"identity_transition"}"#), false),
            true,
        ),
        (
            "operational clear",
            legacy_scope_json(Some(r#"{"kind":"operational_clear"}"#), false),
            true,
        ),
        (
            "reset",
            legacy_scope_json(Some(r#"{"kind":"reset"}"#), true),
            true,
        ),
        (
            "legacy without purpose",
            legacy_scope_json(None, false),
            true,
        ),
    ];
    for (case, json, blocks) in cases {
        lifecycle.reset();
        let terminal = till(Kind::WithRepairs);
        assert!(fake_keyring::set(
            crate::storage::KEY_REPAIR_SCOPE_V1,
            &json
        ));
        load_scope_raw()
            .unwrap_or_else(|error| panic!("{case}: the 1.4.134 shape no longer parses: {error}"))
            .expect("scope");
        assert_eq!(rebind_pending(&terminal), blocks, "{case}");
        assert_eq!(
            operational_clear_transition_pending().unwrap(),
            blocks,
            "{case}"
        );
        // Repairs itself stays closed for every pending purpose.
        assert!(acquire_transport_lease().is_err(), "{case}");
    }
}

fn queue_repair_row(terminal: &Terminal) {
    let connection = terminal.database.state.conn.lock().unwrap();
    crate::sync_queue::enqueue_repair_with_fixed_id(
        &connection,
        OPERATION,
        REPAIR,
        &crate::sync_queue::EnqueueInput {
            table_name: "repairs".to_string(),
            record_id: REPAIR.to_string(),
            operation: "INSERT".to_string(),
            data: "ciphertext-only".to_string(),
            organization_id: ORG.to_string(),
            priority: Some(1),
            module_type: Some("repairs".to_string()),
            conflict_strategy: Some("manual".to_string()),
            version: Some(1),
        },
    )
    .unwrap();
}

/// While Repairs access is closed, a parity pass leaves repair rows exactly as
/// they were: no claim, no attempt, no dead letter. Android's repair drains
/// skip them the same way.
#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_parity_pass_skips_repair_rows_while_repairs_is_closed() {
    let _lifecycle = isolate_lifecycle_for_test();
    let terminal = till(Kind::WithRepairs);
    queue_repair_row(&terminal);
    let decision = start_authoritative_access_decision().unwrap();
    latch_authoritative_access_pending(decision).unwrap();
    let before: (String, i64, i64, Option<String>, Option<String>) = terminal
        .database
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT status, attempts, claim_generation, last_attempt, error_message
               FROM parity_sync_queue WHERE id = ?1",
            [OPERATION],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();

    let result = crate::sync_queue::process_queue_with_repair_hooks(
        &terminal.database.state.conn,
        "http://127.0.0.1:9",
        "test-api-key",
        &NATIVE_REPAIR_QUEUE_HOOKS,
    )
    .await
    .expect("the pass completes");
    assert_eq!(result.processed + result.failed + result.dead_lettered, 0);

    let after: (String, i64, i64, Option<String>, Option<String>) = terminal
        .database
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT status, attempts, claim_generation, last_attempt, error_message
               FROM parity_sync_queue WHERE id = ?1",
            [OPERATION],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(after, before, "a closed Repairs gate touched a repair row");
    assert_eq!(after.0, "pending");
    assert_eq!(lifecycle_snapshot_for_test().repair_readers, 0);
}
