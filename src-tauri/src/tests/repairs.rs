//! Task 9C RED-first contract tests for the durable native repair cache.

use rusqlite::Connection;

use crate::recovery::{self, RecoveryPointKind};
use crate::storage;
use crate::sync_queue::{self, EnqueueInput};
use crate::tests::harness::{TempDir, TestDb};

const ORG_ID: &str = "11111111-1111-4111-8111-111111111111";
const REPAIR_ID: &str = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID: &str = "33333333-3333-4333-8333-333333333333";

#[test]
fn repair_ipc_allowlist_exposes_only_named_typed_commands() {
    let source = include_str!("../lib.rs");
    assert!(
        !source.contains("repair_transport::repair_json_request"),
        "the raw tagged JSON transport must never remain renderer-invokable"
    );

    for command in [
        "commands::repairs::repairs_list",
        "commands::repairs::repairs_workspace",
        "commands::repairs::repairs_settings",
        "commands::repairs::repairs_search_customers",
        "commands::repairs::repairs_customer_devices",
        "commands::repairs::repairs_create_customer_device",
        "commands::repairs::repairs_execute_command",
        "commands::repairs::repairs_stage_attachment",
        "commands::repairs::repairs_list_attachments",
        "commands::repairs::repairs_open_attachment",
        "commands::repairs::repairs_list_conflicts",
        "commands::repairs::repairs_resolve_conflict",
        "commands::repairs::repairs_print_projection",
    ] {
        assert!(
            source.contains(command),
            "missing typed IPC command {command}"
        );
    }
}

#[test]
fn repair_ipc_inputs_deny_renderer_scope_and_transport_fields() {
    use crate::commands::repairs::RepairListInput;

    let valid = serde_json::json!({
        "staffSessionId": "44444444-4444-4444-8444-444444444444",
        "status": null,
        "search": "R-OFF",
        "limit": 25,
        "offset": 0
    });
    serde_json::from_value::<RepairListInput>(valid.clone())
        .expect("the frozen one-object list input must deserialize");

    for forbidden in [
        "organizationId",
        "branchId",
        "terminalId",
        "apiKey",
        "url",
        "method",
        "headers",
        "queuePayload",
        "ciphertext",
        "localPath",
        "signedUrl",
    ] {
        let mut candidate = valid.clone();
        candidate
            .as_object_mut()
            .expect("fixture object")
            .insert(forbidden.to_string(), serde_json::json!("forbidden"));
        assert!(
            serde_json::from_value::<RepairListInput>(candidate).is_err(),
            "strict IPC input accepted renderer-controlled {forbidden}"
        );
    }
}

#[test]
fn repair_attachment_open_ipc_is_identity_only_and_never_returns_a_path() {
    use crate::commands::repairs::{RepairOpenAttachmentInput, RepairOpenAttachmentSnapshot};

    let valid = serde_json::json!({
        "staffSessionId": "44444444-4444-4444-8444-444444444444",
        "repairId": REPAIR_ID,
        "attachmentId": "55555555-5555-4555-8555-555555555555"
    });
    serde_json::from_value::<RepairOpenAttachmentInput>(valid.clone())
        .expect("bounded attachment-open input");
    for forbidden in ["url", "path", "mimeType", "filename", "contentDisposition"] {
        let mut candidate = valid.clone();
        candidate
            .as_object_mut()
            .unwrap()
            .insert(forbidden.to_string(), serde_json::json!("forbidden"));
        assert!(serde_json::from_value::<RepairOpenAttachmentInput>(candidate).is_err());
    }

    let snapshot = serde_json::to_value(RepairOpenAttachmentSnapshot {
        scope_token: "66666666-6666-4666-8666-666666666666".to_string(),
        attachment_id: "55555555-5555-4555-8555-555555555555".to_string(),
        opened: true,
    })
    .unwrap();
    assert_eq!(
        snapshot,
        serde_json::json!({
            "scopeToken": "66666666-6666-4666-8666-666666666666",
            "attachmentId": "55555555-5555-4555-8555-555555555555",
            "opened": true
        })
    );
}

#[test]
fn repair_device_snapshot_serialization_redacts_tenant_and_private_transport_state() {
    use crate::commands::repairs::{RepairCustomerDevicesSnapshot, RepairDeviceSnapshot};

    let snapshot = RepairCustomerDevicesSnapshot {
        scope_token: "55555555-5555-4555-8555-555555555555".to_string(),
        devices: vec![RepairDeviceSnapshot {
            id: "66666666-6666-4666-8666-666666666666".to_string(),
            label: Some("Pixel 9".to_string()),
            device_type: "phone".to_string(),
            manufacturer: Some("Google".to_string()),
            model: Some("Pixel 9".to_string()),
            variant: None,
            storage_capacity: Some("256 GB".to_string()),
            color: Some("black".to_string()),
            serial_masked: Some("•••• A1B2".to_string()),
            imei_masked: None,
            created_at: "2026-08-26T12:00:00Z".to_string(),
            updated_at: "2026-08-26T12:00:00Z".to_string(),
        }],
    };
    let serialized = serde_json::to_string(&snapshot).expect("serialize safe device snapshot");

    for forbidden in [
        "organizationId",
        "organization_id",
        "branchId",
        "terminalId",
        "customerId",
        "queuePayload",
        "ciphertext",
        "localPath",
        "signedUrl",
        "rawSerial",
        "rawImei",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "safe snapshot leaked forbidden field {forbidden}: {serialized}"
        );
    }
    assert!(serialized.contains("scopeToken"));
    assert!(serialized.contains("•••• A1B2"));
}

#[test]
fn strict_repair_session_read_distinguishes_missing_from_backend_failure() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    assert!(storage::session_get_strict()
        .expect("a missing session is not a keyring backend failure")
        .is_none());

    crate::tests::fake_keyring::fail_reads_for("pos_session", "KEYRING_READ_FAILED");
    assert_eq!(
        storage::session_get_strict().expect_err("backend failure must stay distinguishable"),
        "REPAIR_SESSION_KEYRING_UNAVAILABLE"
    );
}

#[test]
fn renderer_generic_keyring_getters_never_expose_native_repair_state() {
    let sentinels = [
        (
            storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "sentinel-aes-renderer-must-never-see",
        ),
        (
            storage::KEY_REPAIR_SCOPE_V1,
            "sentinel-scope-renderer-must-never-see",
        ),
        (
            storage::KEY_REPAIR_ENTITLEMENT_V1,
            "sentinel-entitlement-renderer-must-never-see",
        ),
        (
            storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            "sentinel-actor-renderer-must-never-see",
        ),
    ];
    let _keyring = crate::tests::fake_keyring::install_seeded(sentinels);

    for (key, sentinel) in sentinels {
        assert_eq!(
            storage::get_setting(Some("terminal"), Some(key)),
            serde_json::Value::Null,
            "terminal-config generic getter exposed {key}"
        );
        assert_eq!(
            storage::settings_get(Some(key)),
            serde_json::Value::Null,
            "legacy generic settings getter exposed {key}"
        );
        assert_eq!(
            storage::get_credential_strict(key)
                .expect("native strict read remains available")
                .as_ref()
                .map(|value| value.as_str()),
            Some(sentinel),
            "renderer protection must not break native strict access"
        );
    }
}

#[test]
fn renderer_reachable_generic_credential_mutators_cannot_replace_or_delete_native_actor() {
    let _keyring = crate::tests::fake_keyring::install_seeded([(
        storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        "server-issued-actor",
    )]);

    assert_eq!(
        storage::set_credential(
            storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            "renderer-forged-actor",
        )
        .expect_err("generic credential setter must reject native actor replacement"),
        "REPAIR_ACTOR_ATTESTATION_NATIVE_ONLY"
    );
    assert_eq!(
        storage::delete_credential(storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
            .expect_err("generic credential deleter must reject native actor removal"),
        "REPAIR_ACTOR_ATTESTATION_NATIVE_ONLY"
    );
    assert_eq!(
        storage::get_credential_strict(storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
            .expect("native strict read remains available")
            .as_ref()
            .map(|value| value.as_str()),
        Some("server-issued-actor")
    );
}

#[test]
fn terminal_settings_snapshot_never_persists_native_repair_shadows() {
    let td = TestDb::open();
    let response = serde_json::json!({
        "settings": {
            "terminal": {
                "repair_queue_aes_key_v1": "shadow-aes-sentinel",
                "repair_scope_v1": "shadow-scope-sentinel",
                "repair_entitlement_v1": "shadow-entitlement-sentinel",
                "repair_actor_attestation_v1": "shadow-actor-sentinel",
                "display_brightness": "80"
            }
        }
    });

    crate::cache_terminal_settings_snapshot(&td.state, &response)
        .expect("cache safe terminal settings only");
    let conn = td.state.conn.lock().expect("lock settings database");
    for key in [
        storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
        storage::KEY_REPAIR_SCOPE_V1,
        storage::KEY_REPAIR_ENTITLEMENT_V1,
        storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
    ] {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_settings WHERE setting_key = ?1",
                [key],
                |row| row.get(0),
            )
            .expect("inspect forbidden repair shadow");
        assert_eq!(count, 0, "terminal settings snapshot persisted {key}");
    }
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get::<_, bool>(0),
    )
    .expect("inspect sqlite table")
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = conn.prepare(&sql).expect("inspect sqlite columns");
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query sqlite columns")
        .filter_map(Result::ok)
        .any(|name| name == column);
    exists
}

fn rewind_v79_for_upgrade(td: &TestDb) {
    let conn = td.state.conn.lock().expect("lock database");
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_parity_sync_queue_repair_aggregate_order;
         DELETE FROM schema_version WHERE version = 79;",
    )
    .expect("rewind v79 metadata");
    if column_exists(&conn, "parity_sync_queue", "repair_aggregate_id") {
        conn.execute(
            "ALTER TABLE parity_sync_queue DROP COLUMN repair_aggregate_id",
            [],
        )
        .expect("rewind v79 aggregate column");
    }
}

fn rewind_v78_for_upgrade(td: &TestDb) {
    rewind_v79_for_upgrade(td);
    let conn = td.state.conn.lock().expect("lock database");
    conn.execute_batch(
        "DELETE FROM schema_version WHERE version = 78;
         DROP INDEX IF EXISTS idx_parity_sync_queue_repair_dependencies;
         DROP TABLE IF EXISTS repair_conflicts;
         DROP TABLE IF EXISTS repair_attachment_staging;
         DROP TABLE IF EXISTS repair_alias_cache;
         DROP TABLE IF EXISTS repair_cache;",
    )
    .expect("rewind v78 objects");
}

fn raw_migration_fixture(sql: &str) -> TempDir {
    let tmp = TempDir::new();
    let db_path = tmp.path().join("pos.db");
    let conn = Connection::open(&db_path).expect("open raw migration fixture");
    conn.execute_batch(sql).expect("seed raw migration fixture");
    drop(conn);
    tmp
}

fn raw_schema_versions(tmp: &TempDir) -> Vec<i64> {
    let conn = Connection::open(tmp.path().join("pos.db")).expect("reopen raw migration fixture");
    let mut statement = conn
        .prepare("SELECT version FROM schema_version ORDER BY version")
        .expect("prepare schema version inventory");
    statement
        .query_map([], |row| row.get(0))
        .expect("query schema version inventory")
        .collect::<Result<Vec<_>, _>>()
        .expect("read schema version inventory")
}

#[test]
fn migration_v78_fresh_install_creates_exact_repair_tables() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .expect("read schema version");
    assert_eq!(version, 79, "Task 9C must install SQLite schema v79");

    for table in [
        "repair_cache",
        "repair_alias_cache",
        "repair_attachment_staging",
        "repair_conflicts",
    ] {
        assert!(table_exists(&conn, table), "missing v78 table {table}");
    }
}

#[test]
fn migration_v79_backfills_provable_aggregates_and_quarantines_ambiguous_rows() {
    const VALID_ATTACHMENT_ID: &str = "44444444-4444-4444-8444-444444444444";
    const VALID_ATTACHMENT_OP: &str = "55555555-5555-4555-8555-555555555555";
    const ORPHAN_ATTACHMENT_ID: &str = "66666666-6666-4666-8666-666666666666";
    const ORPHAN_ATTACHMENT_OP: &str = "77777777-7777-4777-8777-777777777777";
    const AMBIGUOUS_ATTACHMENT_ID: &str = "88888888-8888-4888-8888-888888888888";
    const AMBIGUOUS_ATTACHMENT_OP: &str = "99999999-9999-4999-8999-999999999999";

    let td = TestDb::open();
    rewind_v79_for_upgrade(&td);
    {
        let conn = td.state.conn.lock().expect("lock rewound v78 database");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, priority, module_type, conflict_strategy, version, status
             ) VALUES (?1, 'repairs', ?2, 'INSERT', 'opaque-command', ?3,
                       '2026-08-26T08:00:00Z', 100, 'repairs', 'manual', 0, 'pending')",
            rusqlite::params![OPERATION_ID, REPAIR_ID, ORG_ID],
        )
        .expect("seed v78 repair command");
        for (operation_id, attachment_id, version) in [
            (VALID_ATTACHMENT_OP, VALID_ATTACHMENT_ID, 1_i64),
            (ORPHAN_ATTACHMENT_OP, ORPHAN_ATTACHMENT_ID, 2_i64),
            (AMBIGUOUS_ATTACHMENT_OP, AMBIGUOUS_ATTACHMENT_ID, 3_i64),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, priority, module_type, conflict_strategy, version, status
                 ) VALUES (?1, 'repair_attachments', ?2, 'INSERT', 'opaque-attachment', ?3,
                           '2026-08-26T08:01:00Z', 90, 'repairs', 'manual', ?4, 'pending')",
                rusqlite::params![operation_id, attachment_id, ORG_ID, version],
            )
            .expect("seed v78 repair attachment queue row");
        }
        conn.execute(
            "UPDATE parity_sync_queue
                SET status = 'processing', claim_generation = 4,
                    next_retry_at = '2099-01-01T00:00:00Z'
              WHERE id = ?1",
            [ORPHAN_ATTACHMENT_OP],
        )
        .expect("seed in-flight orphan requiring generation fencing");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, module_type, conflict_strategy, version, status
             ) VALUES ('generic-v78', 'orders', 'order-v78', 'INSERT', '{}', ?1,
                       '2026-08-26T08:02:00Z', 'orders', 'server-wins', 1, 'failed')",
            [ORG_ID],
        )
        .expect("seed generic v78 queue row");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, module_type, conflict_strategy, version, status
             ) VALUES ('bad-command-v78', 'repairs', 'not-a-canonical-uuid', 'INSERT',
                       'opaque-command', ?1, '2026-08-26T08:03:00Z', 'repairs',
                       'manual', 4, 'pending')",
            [ORG_ID],
        )
        .expect("seed malformed v78 repair command");

        let insert_staging = |branch: &str,
                              terminal: &str,
                              attachment_id: &str,
                              operation_id: &str,
                              expected_version: i64| {
            conn.execute(
                "INSERT INTO repair_attachment_staging (
                     organization_id, branch_id, terminal_id, attachment_id, repair_id,
                     operation_id, queue_id, expected_version, scope_generation, file_key,
                     metadata_nonce, metadata_ciphertext, sha256_hex, mime_type, size_bytes,
                     state, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, 1, ?8, zeroblob(12),
                           zeroblob(16), ?9, 'image/jpeg', 1, 'queued',
                           '2026-08-26T08:00:00Z', '2026-08-26T08:00:00Z')",
                rusqlite::params![
                    ORG_ID,
                    branch,
                    terminal,
                    attachment_id,
                    REPAIR_ID,
                    operation_id,
                    expected_version,
                    uuid::Uuid::new_v4().to_string(),
                    "0".repeat(64),
                ],
            )
            .expect("seed v78 attachment staging row");
        };
        insert_staging(
            "branch-valid",
            "terminal-valid",
            VALID_ATTACHMENT_ID,
            VALID_ATTACHMENT_OP,
            1,
        );
        insert_staging(
            "branch-ambiguous-a",
            "terminal-ambiguous-a",
            AMBIGUOUS_ATTACHMENT_ID,
            AMBIGUOUS_ATTACHMENT_OP,
            3,
        );
        insert_staging(
            "branch-ambiguous-b",
            "terminal-ambiguous-b",
            AMBIGUOUS_ATTACHMENT_ID,
            AMBIGUOUS_ATTACHMENT_OP,
            3,
        );
    }

    let recovery_root = recovery::recovery_root_for_app_data(td.dir());
    assert!(
        !recovery_root.exists(),
        "fresh test database must not start with recovery artifacts"
    );
    drop(crate::db::init(td.dir()).expect("upgrade rewound v78 database to v79"));
    assert!(
        !recovery_root.exists(),
        "native repair atomic-only migration must not create a generic recovery artifact"
    );
    let conn = td.state.conn.lock().expect("lock upgraded v79 database");
    assert!(column_exists(
        &conn,
        "parity_sync_queue",
        "repair_aggregate_id"
    ));
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .expect("read upgraded schema version");
    assert_eq!(version, 79);

    let binding = |id: &str| {
        conn.query_row(
            "SELECT repair_aggregate_id, status, error_message, data, version
               FROM parity_sync_queue WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .expect("read migrated aggregate binding")
    };
    assert_eq!(
        binding(OPERATION_ID),
        (
            Some(REPAIR_ID.to_string()),
            "pending".to_string(),
            None,
            "opaque-command".to_string(),
            0,
        )
    );
    assert_eq!(
        binding(VALID_ATTACHMENT_OP),
        (
            Some(REPAIR_ID.to_string()),
            "pending".to_string(),
            None,
            "opaque-attachment".to_string(),
            1,
        )
    );
    for id in [
        ORPHAN_ATTACHMENT_OP,
        AMBIGUOUS_ATTACHMENT_OP,
        "bad-command-v78",
    ] {
        let (aggregate, status, error, _, _) = binding(id);
        assert_eq!(aggregate, None, "unprovable aggregate must remain NULL");
        assert_eq!(
            status, "conflict",
            "unprovable repair row must be quarantined"
        );
        assert_eq!(error.as_deref(), Some("REPAIR_AGGREGATE_ID_MISSING"));
    }
    assert_eq!(
        conn.query_row(
            "SELECT claim_generation, next_retry_at
               FROM parity_sync_queue WHERE id = ?1",
            [ORPHAN_ATTACHMENT_OP],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .expect("read quarantined in-flight aggregate"),
        (5, None),
        "quarantining an in-flight row must invalidate its claim and retry schedule"
    );
    assert_eq!(
        binding("generic-v78"),
        (None, "failed".to_string(), None, "{}".to_string(), 1),
        "v79 must not rewrite generic queue rows"
    );
    let index_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
                            WHERE type='index'
                              AND name='idx_parity_sync_queue_repair_aggregate_order')",
            [],
            |row| row.get(0),
        )
        .expect("inspect aggregate ordering index");
    assert!(
        index_exists,
        "v79 must install the scoped partial ordering index"
    );
}

#[test]
fn migration_v79_repairs_missing_column_and_index_even_when_version_is_current() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().expect("lock current v79 database");
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_parity_sync_queue_repair_aggregate_order;
             ALTER TABLE parity_sync_queue DROP COLUMN repair_aggregate_id;",
        )
        .expect("simulate incomplete v79 schema with current version marker");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, priority, module_type, conflict_strategy, version, status
             ) VALUES (?1, 'repairs', ?2, 'INSERT', 'opaque', ?3,
                       '2026-08-26T08:00:00Z', 100, 'repairs', 'manual', 0, 'pending')",
            rusqlite::params![OPERATION_ID, REPAIR_ID, ORG_ID],
        )
        .expect("seed current-version row awaiting preflight repair");
    }

    let recovery_root = recovery::recovery_root_for_app_data(td.dir());
    assert!(
        !recovery_root.exists(),
        "fresh test database must not start with recovery artifacts"
    );
    drop(crate::db::init(td.dir()).expect("repair incomplete current v79 schema"));
    assert!(
        !recovery_root.exists(),
        "current-version native repair self-heal must not create a generic recovery artifact"
    );
    let conn = td.state.conn.lock().expect("lock repaired v79 database");
    assert!(column_exists(
        &conn,
        "parity_sync_queue",
        "repair_aggregate_id"
    ));
    assert_eq!(
        conn.query_row(
            "SELECT repair_aggregate_id FROM parity_sync_queue WHERE id = ?1",
            [OPERATION_ID],
            |row| row.get::<_, Option<String>>(0),
        )
        .expect("read repaired aggregate")
        .as_deref(),
        Some(REPAIR_ID)
    );
    let index_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
                            WHERE type='index'
                              AND name='idx_parity_sync_queue_repair_aggregate_order')",
            [],
            |row| row.get(0),
        )
        .expect("inspect repaired aggregate index");
    assert!(index_exists);
}

#[test]
fn migration_v79_native_repair_state_before_supported_boundary_fails_closed_without_artifacts() {
    let td = TestDb::open();
    let before = {
        let conn = td.state.conn.lock().expect("lock current database");
        conn.execute("DELETE FROM schema_version WHERE version >= 75", [])
            .expect("rewind schema marker to v74");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, priority, module_type, conflict_strategy, version,
                 repair_aggregate_id, status
             ) VALUES (?1, 'repairs', ?2, 'INSERT', 'opaque', ?3,
                       '2026-08-26T08:00:00Z', 100, 'repairs', 'manual', 0,
                       ?2, 'pending')",
            rusqlite::params![OPERATION_ID, REPAIR_ID, ORG_ID],
        )
        .expect("seed native repair row on unsupported source schema");
        conn.query_row(
            "SELECT MAX(schema_version.version), status, repair_aggregate_id
               FROM schema_version CROSS JOIN parity_sync_queue
              WHERE parity_sync_queue.id = ?1",
            [OPERATION_ID],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .expect("snapshot unsupported source state")
    };

    let recovery_root = recovery::recovery_root_for_app_data(td.dir());
    assert!(!recovery_root.exists());
    let error = match crate::db::init(td.dir()) {
        Ok(_) => panic!("unsupported native repair migration unexpectedly succeeded"),
        Err(error) => error,
    };
    assert!(
        error.contains("REPAIR_MIGRATION_ATOMIC_ONLY_UNSAFE"),
        "unexpected failure: {error}"
    );
    assert!(
        !recovery_root.exists(),
        "failed-closed migration must not create recovery artifacts"
    );

    let conn = td.state.conn.lock().expect("lock failed-closed database");
    let after = conn
        .query_row(
            "SELECT MAX(schema_version.version), status, repair_aggregate_id
               FROM schema_version CROSS JOIN parity_sync_queue
              WHERE parity_sync_queue.id = ?1",
            [OPERATION_ID],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .expect("read failed-closed source state");
    assert_eq!(after, before, "failed preflight must not mutate SQLite");
}

#[test]
fn migration_v79_detector_errors_fail_closed_before_artifacts_or_schema_changes() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().expect("lock current database");
        conn.execute("DELETE FROM schema_version WHERE version >= 76", [])
            .expect("rewind schema marker to v75");
        conn.execute_batch(
            "ALTER TABLE parity_sync_queue RENAME TO parity_sync_queue_detector_fixture;
             CREATE VIEW parity_sync_queue AS SELECT 1 AS id;",
        )
        .expect("install deterministic repair detector failure");
    }

    let recovery_root = recovery::recovery_root_for_app_data(td.dir());
    assert!(!recovery_root.exists());
    let error = match crate::db::init(td.dir()) {
        Ok(_) => panic!("migration unexpectedly ignored repair detector failure"),
        Err(error) => error,
    };
    assert!(
        error.contains("REPAIR_MIGRATION_REPAIR_STATE_CHECK_FAILED"),
        "unexpected failure: {error}"
    );
    assert!(
        !recovery_root.exists(),
        "detector failure must happen before recovery artifacts"
    );
    let conn = td.state.conn.lock().expect("lock detector fixture");
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .expect("read failed-closed schema version");
    assert_eq!(version, 75, "detector failure must precede migrations");
}

#[test]
fn migration_v79_without_native_repair_data_keeps_generic_pre_migration_snapshot() {
    let td = TestDb::open();
    rewind_v79_for_upgrade(&td);

    let restarted = crate::db::init(td.dir()).expect("upgrade clean v78 database");
    let points = recovery::list_recovery_points(&restarted)
        .expect("list clean pre-migration recovery points");
    assert!(
        points
            .iter()
            .any(|point| point.kind == RecoveryPointKind::PreMigration),
        "clean migration must retain the generic pre-migration snapshot policy"
    );
}

#[test]
fn migration_v79_missing_schema_metadata_on_existing_app_or_repair_objects_fails_before_bootstrap()
{
    for (case, sql) in [
        ("generic", "CREATE TABLE orders (id TEXT PRIMARY KEY);"),
        (
            "native-repair",
            "CREATE TABLE repair_cache (repair_id TEXT PRIMARY KEY);",
        ),
    ] {
        let tmp = raw_migration_fixture(sql);
        let recovery_root = recovery::recovery_root_for_app_data(tmp.path());
        let error = match crate::db::init(tmp.path()) {
            Ok(_) => panic!("{case}: existing database without schema metadata migrated"),
            Err(error) => error,
        };
        assert!(
            error.contains("SCHEMA_VERSION_METADATA_MISSING"),
            "{case}: unexpected error: {error}"
        );
        let conn = Connection::open(tmp.path().join("pos.db")).expect("reopen failed fixture");
        assert!(
            !table_exists(&conn, "schema_version"),
            "{case}: bootstrap must not create schema_version"
        );
        assert!(
            !recovery_root.exists(),
            "{case}: metadata rejection must not create recovery artifacts"
        );
    }
}

#[test]
fn migration_v79_empty_schema_metadata_is_fresh_only_without_other_application_objects() {
    let pristine = raw_migration_fixture(
        "CREATE TABLE schema_version (
             version INTEGER PRIMARY KEY,
             applied_at TEXT DEFAULT (datetime('now'))
         );",
    );
    drop(crate::db::init(pristine.path()).expect("empty metadata-only database is pristine"));
    assert_eq!(
        raw_schema_versions(&pristine).last().copied(),
        Some(79),
        "pristine metadata-only database must migrate normally"
    );

    let existing = raw_migration_fixture(
        "CREATE TABLE schema_version (
             version INTEGER PRIMARY KEY,
             applied_at TEXT DEFAULT (datetime('now'))
         );
         CREATE TABLE repair_cache (repair_id TEXT PRIMARY KEY);",
    );
    let error = match crate::db::init(existing.path()) {
        Ok(_) => panic!("empty schema metadata with repair objects migrated"),
        Err(error) => error,
    };
    assert!(
        error.contains("SCHEMA_VERSION_METADATA_EMPTY_EXISTING_DATABASE"),
        "unexpected error: {error}"
    );
    assert!(raw_schema_versions(&existing).is_empty());
    assert!(
        !recovery::recovery_root_for_app_data(existing.path()).exists(),
        "unsupported empty metadata must not create recovery artifacts"
    );
}

#[test]
fn migration_v79_zero_or_negative_schema_versions_fail_before_bootstrap_mutation() {
    for version in [0_i64, -1_i64] {
        let tmp = raw_migration_fixture(&format!(
            "CREATE TABLE schema_version (
                 version INTEGER PRIMARY KEY,
                 applied_at TEXT DEFAULT (datetime('now'))
             );
             INSERT INTO schema_version (version) VALUES ({version});"
        ));
        let error = match crate::db::init(tmp.path()) {
            Ok(_) => panic!("non-positive schema version {version} migrated"),
            Err(error) => error,
        };
        assert!(
            error.contains("SCHEMA_VERSION_METADATA_NON_POSITIVE"),
            "version {version}: unexpected error: {error}"
        );
        assert_eq!(raw_schema_versions(&tmp), vec![version]);
        let conn = Connection::open(tmp.path().join("pos.db")).expect("reopen failed fixture");
        assert!(
            !table_exists(&conn, "orders"),
            "version {version}: migrations mutated the database"
        );
        assert!(
            !recovery::recovery_root_for_app_data(tmp.path()).exists(),
            "version {version}: metadata rejection created recovery artifacts"
        );
    }
}

#[test]
fn migration_v79_schema_version_query_and_type_failures_propagate_before_mutation() {
    for (case, sql) in [
        (
            "query",
            "CREATE VIEW schema_version AS SELECT version FROM missing_schema_source;",
        ),
        (
            "type",
            "CREATE TABLE schema_version (version BLOB);
             INSERT INTO schema_version (version) VALUES (X'0102');",
        ),
    ] {
        let tmp = raw_migration_fixture(sql);
        let error = match crate::db::init(tmp.path()) {
            Ok(_) => panic!("{case}: malformed schema metadata migrated"),
            Err(error) => error,
        };
        assert!(
            error.contains("SCHEMA_VERSION_METADATA_READ_FAILED"),
            "{case}: unexpected error: {error}"
        );
        let conn = Connection::open(tmp.path().join("pos.db")).expect("reopen failed fixture");
        assert!(
            !table_exists(&conn, "orders"),
            "{case}: metadata failure must precede migrations"
        );
        assert!(
            !recovery::recovery_root_for_app_data(tmp.path()).exists(),
            "{case}: metadata failure created recovery artifacts"
        );
    }
}

#[test]
fn repair_keyring_entries_are_managed_by_factory_reset() {
    let managed = storage::managed_keys();

    for key in [
        "repair_queue_aes_key_v1",
        "repair_scope_v1",
        "repair_entitlement_v1",
        "repair_actor_attestation_v1",
    ] {
        assert!(
            managed.contains(&key),
            "factory/emergency reset must own repair credential {key}"
        );
    }
}

#[test]
fn startup_repair_staging_janitor_runs_after_identity_reconcile_before_sync_loop() {
    let source = include_str!("../lib.rs");
    let identity = source
        .find("commands::settings::reconcile_startup_terminal_binding(&db_state)")
        .expect("startup must use checked canonical terminal binding reconciliation");
    let janitor = source
        .find("repairs::run_startup_staging_janitor")
        .expect("startup must invoke the native repair staging janitor");
    let identity_failure_log = source
        .find("Terminal identity reconciliation failed; repair access remains blocked")
        .expect("identity reconciliation failure must be observable");
    let sync = source
        .find("sync::start_sync_loop(")
        .expect("startup must launch the background sync loop");
    let identity_failure_latch = identity
        + source[identity..janitor]
            .find("repairs::latch_startup_maintenance_failure();")
            .expect("identity reconciliation failure must latch repair replay closed");
    let janitor_lock_failure_latch = janitor
        + source[janitor..sync]
            .find("repairs::latch_startup_maintenance_failure();")
            .expect("startup DB lock failure must latch repair replay closed");
    let janitor_lock_failure_log = source
        .find("Repair staging startup janitor could not lock SQLite")
        .expect("startup DB lock failure must be observable");
    let latch_count = source
        .match_indices("repairs::latch_startup_maintenance_failure();")
        .count();

    assert!(
        latch_count >= 2
            && identity < identity_failure_log
            && identity_failure_log < identity_failure_latch
            && identity_failure_latch < janitor
            && janitor < janitor_lock_failure_latch
            && janitor_lock_failure_latch < janitor_lock_failure_log
            && janitor_lock_failure_log < sync,
        "repair staging cleanup must run after identity reconciliation and before queue replay"
    );
}

#[test]
fn repair_renderer_queue_guard_rejects_generic_repair_enqueue() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    let result = sync_queue::enqueue(
        &conn,
        &EnqueueInput {
            table_name: "repairs".to_string(),
            record_id: REPAIR_ID.to_string(),
            operation: "INSERT".to_string(),
            data: "ciphertext-only".to_string(),
            organization_id: ORG_ID.to_string(),
            priority: Some(1),
            module_type: Some("repairs".to_string()),
            conflict_strategy: Some("manual".to_string()),
            version: Some(1),
        },
    );

    assert_eq!(
        result.expect_err("generic repair enqueue must fail"),
        "REPAIR_NATIVE_PRODUCER_REQUIRED",
        "generic enqueue must never mint a random queue id for repair commands"
    );
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE module_type = 'repairs'",
            [],
            |row| row.get(0),
        )
        .expect("count repair queue rows");
    assert_eq!(count, 0, "rejected generic enqueue must not mutate SQLite");
}

#[test]
fn migration_v78_purges_only_literal_repair_get_namespace() {
    let td = TestDb::open();
    rewind_v78_for_upgrade(&td);
    {
        let conn = td.state.conn.lock().expect("lock database");
        for key in [
            "admin_api_get::/api/pos/repairs",
            "admin_api_get::/api/pos/repairs/22222222-2222-4222-8222-222222222222",
            "admin_api_get::/api/pos/repairs?status=ready",
            "admin_api_get::/api/pos/repairs#workspace",
            "admin_api_get::/api/pos/repairs-export",
            "adminXapiYget::/api/pos/repairs",
            "admin_api_get::/api/pos/repairshop",
        ] {
            conn.execute(
                "INSERT INTO local_settings
                    (setting_category, setting_key, setting_value)
                 VALUES ('local', ?1, '{}')",
                [key],
            )
            .expect("seed legacy GET cache key");
        }
    }

    drop(crate::db::init(td.dir()).expect("upgrade rewound v77 database"));
    let conn = td.state.conn.lock().expect("lock database");
    let remaining = [
        "admin_api_get::/api/pos/repairs",
        "admin_api_get::/api/pos/repairs/22222222-2222-4222-8222-222222222222",
        "admin_api_get::/api/pos/repairs?status=ready",
        "admin_api_get::/api/pos/repairs#workspace",
        "admin_api_get::/api/pos/repairs-export",
        "adminXapiYget::/api/pos/repairs",
        "admin_api_get::/api/pos/repairshop",
    ]
    .map(|key| {
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM local_settings
                  WHERE setting_category = 'local' AND setting_key = ?1
             )",
            [key],
            |row| row.get::<_, bool>(0),
        )
        .expect("inspect migrated cache key")
    });

    assert_eq!(
        remaining,
        [false, false, false, false, true, true, true],
        "only the literal repairs route and its '/', '?' or '#' namespace may be purged"
    );
}

#[test]
fn migration_v78_checks_repair_enums_and_resolution_coherence() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    let insert_cache = |status: &str, priority: &str, intake_mode: &str| {
        conn.execute(
            "INSERT INTO repair_cache (
                 organization_id, branch_id, terminal_id, repair_id,
                 display_number, status, priority, intake_mode,
                 authoritative_version, optimistic_version, scope_generation,
                 created_at, updated_at
             ) VALUES (?1, 'branch', 'terminal', ?2, 'R-OFF-ABCD-000001',
                       ?3, ?4, ?5, 0, 0, 1, '2026-08-26T00:00:00Z',
                       '2026-08-26T00:00:00Z')",
            rusqlite::params![ORG_ID, REPAIR_ID, status, priority, intake_mode],
        )
    };

    assert!(insert_cache("not_a_status", "normal", "standard").is_err());
    assert!(insert_cache("received", "impossible", "standard").is_err());
    assert!(insert_cache("received", "normal", "other_mode").is_err());

    let conflict = conn.execute(
        "INSERT INTO repair_conflicts (
             organization_id, branch_id, terminal_id, conflict_id, repair_id,
             operation_id, expected_version, current_version, display_number,
             status_summary, updated_at_summary, allowed_transitions_json,
             local_nonce, local_ciphertext, state, rebased_operation_id,
             created_at, resolved_at
         ) VALUES (?1, 'branch', 'terminal', 'conflict', ?2, 'operation',
                   1, 2, 'R-OFF-ABCD-000001', 'received',
                   '2026-08-26T00:00:00Z', 'not-json', zeroblob(12),
                   zeroblob(16), 'rebased', NULL, '2026-08-26T00:00:00Z', NULL)",
        rusqlite::params![ORG_ID, REPAIR_ID],
    );
    assert!(
        conflict.is_err(),
        "rebased conflicts require valid JSON, resolution time and replacement operation"
    );
}

fn repair_enqueue_input() -> EnqueueInput {
    EnqueueInput {
        table_name: "repairs".to_string(),
        record_id: REPAIR_ID.to_string(),
        operation: "INSERT".to_string(),
        data: "encrypted-repair-envelope".to_string(),
        organization_id: ORG_ID.to_string(),
        priority: Some(100),
        module_type: Some("repairs".to_string()),
        conflict_strategy: Some("manual".to_string()),
        version: Some(0),
    }
}

#[test]
fn native_repair_enqueue_uses_operation_id_and_collision_is_atomic() {
    let td = TestDb::open();
    let mut conn = td.state.conn.lock().expect("lock database");

    let tx = conn
        .transaction()
        .expect("begin repair producer transaction");
    let queue_id = sync_queue::enqueue_repair_with_fixed_id(
        &tx,
        OPERATION_ID,
        REPAIR_ID,
        &repair_enqueue_input(),
    )
    .expect("native repair enqueue");
    assert_eq!(queue_id, OPERATION_ID);
    tx.commit().expect("commit repair queue row");
    assert_eq!(
        conn.query_row(
            "SELECT repair_aggregate_id FROM parity_sync_queue WHERE id = ?1",
            [OPERATION_ID],
            |row| row.get::<_, Option<String>>(0),
        )
        .expect("read native aggregate binding")
        .as_deref(),
        Some(REPAIR_ID)
    );

    let tx = conn.transaction().expect("begin colliding transaction");
    tx.execute(
        "INSERT INTO repair_alias_cache (
             organization_id, branch_id, terminal_id, alias, repair_id,
             is_official, created_at
         ) VALUES (?1, 'branch', 'terminal', 'R-OFF-ABCD-000001', ?2, 0,
                   '2026-08-26T00:00:00Z')",
        rusqlite::params![ORG_ID, REPAIR_ID],
    )
    .expect("seed transaction side effect");
    let collision = sync_queue::enqueue_repair_with_fixed_id(
        &tx,
        OPERATION_ID,
        REPAIR_ID,
        &repair_enqueue_input(),
    );
    assert!(collision.is_err(), "queue id collision must fail closed");
    tx.rollback().expect("rollback entire producer transaction");

    let alias_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM repair_alias_cache", [], |row| {
            row.get(0)
        })
        .expect("count rolled-back aliases");
    assert_eq!(
        alias_count, 0,
        "queue collision must not leave partial producer state"
    );
}

#[test]
fn native_repair_enqueue_rejects_noncanonical_identity_operation_and_version() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    let mut invalid = Vec::new();

    let mut wrong_operation = repair_enqueue_input();
    wrong_operation.operation = "UPDATE".to_string();
    invalid.push((OPERATION_ID.to_string(), wrong_operation));

    let mut wrong_org = repair_enqueue_input();
    wrong_org.organization_id = "not-an-org-uuid".to_string();
    invalid.push((OPERATION_ID.to_string(), wrong_org));

    let mut wrong_record = repair_enqueue_input();
    wrong_record.record_id = "not-a-repair-uuid".to_string();
    invalid.push((OPERATION_ID.to_string(), wrong_record));

    let mut unsafe_version = repair_enqueue_input();
    unsafe_version.version = Some(9_007_199_254_740_992);
    invalid.push((OPERATION_ID.to_string(), unsafe_version));

    invalid.push((
        "33333333-3333-4333-8333-33333333333Z".to_string(),
        repair_enqueue_input(),
    ));

    for (operation_id, input) in invalid {
        assert!(
            sync_queue::enqueue_repair_with_fixed_id(&conn, &operation_id, REPAIR_ID, &input,)
                .is_err(),
            "invalid native repair envelope must fail closed"
        );
    }

    let other_repair = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert_eq!(
        sync_queue::enqueue_repair_with_fixed_id(
            &conn,
            OPERATION_ID,
            other_repair,
            &repair_enqueue_input(),
        )
        .expect_err("command record id must equal aggregate id"),
        "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0,
        "every rejected envelope must leave the queue unchanged"
    );
}

#[test]
fn native_attachment_enqueue_binds_parent_repair_not_attachment_record() {
    const ATTACHMENT_ID: &str = "44444444-4444-4444-8444-444444444444";
    const ATTACHMENT_OPERATION_ID: &str = "55555555-5555-4555-8555-555555555555";
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    let input = EnqueueInput {
        table_name: "repair_attachments".to_string(),
        record_id: ATTACHMENT_ID.to_string(),
        operation: "INSERT".to_string(),
        data: "encrypted-attachment-metadata".to_string(),
        organization_id: ORG_ID.to_string(),
        priority: Some(90),
        module_type: Some("repairs".to_string()),
        conflict_strategy: Some("manual".to_string()),
        version: Some(1),
    };
    assert_eq!(
        sync_queue::enqueue_repair_with_fixed_id(
            &conn,
            ATTACHMENT_OPERATION_ID,
            REPAIR_ID,
            &input,
        )
        .expect_err("attachment queue row requires an exact staged parent binding"),
        "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID"
    );
    conn.execute(
        "INSERT INTO repair_attachment_staging (
             organization_id, branch_id, terminal_id, attachment_id, repair_id,
             operation_id, queue_id, expected_version, scope_generation, file_key,
             metadata_nonce, metadata_ciphertext, sha256_hex, mime_type, size_bytes,
             state, created_at, updated_at
         ) VALUES (?1, 'branch', 'terminal', ?2, ?3, ?4, ?4, 1, 1, ?5,
                   zeroblob(12), zeroblob(16), ?6, 'image/jpeg', 1, 'queued',
                   '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z')",
        rusqlite::params![
            ORG_ID,
            ATTACHMENT_ID,
            REPAIR_ID,
            ATTACHMENT_OPERATION_ID,
            "66666666-6666-4666-8666-666666666666",
            "0".repeat(64),
        ],
    )
    .expect("seed exact staged attachment parent");
    assert_eq!(
        sync_queue::enqueue_repair_with_fixed_id(
            &conn,
            ATTACHMENT_OPERATION_ID,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            &input,
        )
        .expect_err("attachment aggregate must equal staged parent repair"),
        "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID"
    );
    sync_queue::enqueue_repair_with_fixed_id(&conn, ATTACHMENT_OPERATION_ID, REPAIR_ID, &input)
        .expect("enqueue attachment with explicit parent aggregate");
    let (record_id, aggregate): (String, Option<String>) = conn
        .query_row(
            "SELECT record_id, repair_aggregate_id
               FROM parity_sync_queue WHERE id = ?1",
            [ATTACHMENT_OPERATION_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read attachment aggregate binding");
    assert_eq!(record_id, ATTACHMENT_ID);
    assert_eq!(aggregate.as_deref(), Some(REPAIR_ID));
}

#[test]
fn renderer_queue_surface_excludes_repair_rows_but_internal_drain_sees_them() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    sync_queue::enqueue_repair_with_fixed_id(
        &conn,
        OPERATION_ID,
        REPAIR_ID,
        &repair_enqueue_input(),
    )
    .expect("seed native repair row");
    let ordinary_id = sync_queue::enqueue(
        &conn,
        &EnqueueInput {
            table_name: "orders".to_string(),
            record_id: "44444444-4444-4444-8444-444444444444".to_string(),
            operation: "UPDATE".to_string(),
            data: "{}".to_string(),
            organization_id: ORG_ID.to_string(),
            priority: Some(1),
            module_type: Some("orders".to_string()),
            conflict_strategy: Some("server-wins".to_string()),
            version: Some(1),
        },
    )
    .expect("seed ordinary row");

    assert_eq!(
        sync_queue::renderer_peek(&conn)
            .expect("renderer peek")
            .expect("ordinary renderer row")
            .id,
        ordinary_id
    );
    assert_eq!(
        sync_queue::renderer_dequeue(&conn)
            .expect("renderer dequeue")
            .expect("ordinary renderer row")
            .id,
        ordinary_id
    );
    assert_eq!(sync_queue::renderer_get_length(&conn).unwrap(), 1);
    assert_eq!(sync_queue::renderer_get_status(&conn).unwrap().total, 1);
    assert!(sync_queue::renderer_list_actionable_items(
        &conn,
        &sync_queue::QueueListQuery::default()
    )
    .unwrap()
    .iter()
    .all(|item| item.module_type != "repairs"));

    conn.execute(
        "UPDATE parity_sync_queue SET status = 'failed', attempts = 4 WHERE id = ?1",
        [OPERATION_ID],
    )
    .expect("make repair row retryable");
    assert_eq!(
        sync_queue::renderer_retry_item(&conn, OPERATION_ID).unwrap_err(),
        "REPAIR_TYPED_CONFLICT_REQUIRED"
    );
    assert_eq!(
        sync_queue::renderer_retry_items_by_module(&conn, "repairs").unwrap_err(),
        "REPAIR_TYPED_CONFLICT_REQUIRED"
    );

    conn.execute(
        "INSERT INTO conflict_audit_log (
             id, operation_type, entity_id, entity_type, local_version,
             server_version, timestamp, discarded_payload, resolution,
             is_monetary, reviewed_by_operator
         ) VALUES ('repair-conflict', 'UPDATE', ?1, 'repairs', 1, 2,
                   '2026-08-26T00:00:00Z', 'secret', 'manual', 0, 0)",
        [REPAIR_ID],
    )
    .expect("seed legacy repair conflict audit");
    assert!(sync_queue::renderer_list_conflict_audit_entries(&conn, 100)
        .unwrap()
        .is_empty());

    sync_queue::renderer_clear(&conn).expect("renderer clear ordinary rows");
    assert_eq!(sync_queue::renderer_get_length(&conn).unwrap(), 0);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
            [OPERATION_ID],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        1,
        "renderer clear must preserve native repair outbox"
    );

    conn.execute(
        "UPDATE parity_sync_queue SET status = 'pending' WHERE id = ?1",
        [OPERATION_ID],
    )
    .expect("restore repair pending state");
    assert_eq!(
        sync_queue::peek(&conn)
            .expect("internal peek")
            .expect("internal repair row")
            .id,
        OPERATION_ID,
        "background/internal drain must remain unfiltered"
    );
}

#[test]
fn recovery_center_raw_retry_rejects_repair_rows_without_mutating_mixed_module() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    conn.execute(
        "INSERT INTO parity_sync_queue (
             id, table_name, record_id, operation, data, organization_id,
             created_at, attempts, error_message, retry_delay_ms, priority,
             module_type, conflict_strategy, version, status
         ) VALUES ('recovery-repair', 'repairs', ?1, 'INSERT', 'opaque', ?2,
                   '2026-08-26T00:00:00Z', 4, 'REPAIR_CONFLICT_OPEN', 8000, 100,
                   'mixed-recovery', 'manual', 1, 'conflict'),
                  ('recovery-generic', 'orders', 'order-recovery', 'UPDATE', '{}', ?2,
                   '2026-08-26T00:00:01Z', 3, 'GENERIC_FAILURE', 4000, 1,
                   'mixed-recovery', 'server-wins', 1, 'failed')",
        rusqlite::params![REPAIR_ID, ORG_ID],
    )
    .expect("seed mixed Recovery Center module");

    let fingerprint = |id: &str| {
        conn.query_row(
            "SELECT status, attempts, error_message, retry_delay_ms,
                    COALESCE(next_retry_at, ''), COALESCE(last_attempt, '')
               FROM parity_sync_queue WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .expect("fingerprint Recovery Center row")
    };
    let repair_before = fingerprint("recovery-repair");
    let generic_before = fingerprint("recovery-generic");

    assert_eq!(
        sync_queue::retry_item(&conn, "recovery-repair")
            .expect_err("raw Recovery Center retry must reject typed repair conflicts"),
        "REPAIR_TYPED_CONFLICT_REQUIRED"
    );
    assert_eq!(fingerprint("recovery-repair"), repair_before);

    assert_eq!(
        sync_queue::retry_items_by_module(&conn, "mixed-recovery")
            .expect_err("module retry containing repair rows must fail atomically"),
        "REPAIR_TYPED_CONFLICT_REQUIRED"
    );
    assert_eq!(fingerprint("recovery-repair"), repair_before);
    assert_eq!(
        fingerprint("recovery-generic"),
        generic_before,
        "mixed-module guard must not partially retry generic rows"
    );
}

#[test]
fn renderer_queue_predicate_keeps_legacy_null_module_rows() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().expect("lock database");
    conn.execute_batch(
        "CREATE TABLE parity_sync_queue_legacy AS
             SELECT * FROM parity_sync_queue WHERE 0;
         DROP TABLE parity_sync_queue;
         ALTER TABLE parity_sync_queue_legacy RENAME TO parity_sync_queue;",
    )
    .expect("simulate a legacy nullable module_type queue");
    conn.execute(
        "INSERT INTO parity_sync_queue (
             id, table_name, record_id, operation, data, organization_id,
             created_at, attempts, retry_delay_ms, priority, module_type,
             conflict_strategy, version, claim_generation, status
         ) VALUES ('legacy-null-module', 'orders', 'legacy-order', 'UPDATE',
                   '{}', ?1, '2026-08-26T00:00:00Z', 0, 1000, 1, NULL,
                   'server-wins', 1, 0, 'pending')",
        [ORG_ID],
    )
    .expect("seed legacy nullable module row");

    assert_eq!(sync_queue::renderer_get_length(&conn).unwrap(), 1);
    assert_eq!(
        sync_queue::renderer_peek(&conn)
            .unwrap()
            .expect("legacy row must be renderer-visible")
            .id,
        "legacy-null-module"
    );
    sync_queue::renderer_retry_item(&conn, "legacy-null-module")
        .expect("legacy row remains mutable");
    sync_queue::renderer_clear(&conn).expect("legacy row remains clearable");
    assert_eq!(sync_queue::renderer_get_length(&conn).unwrap(), 0);
}
