//! Trusted group identity for shared till data. Store/financial scope is unchanged.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const SHARED_TABLES: &str =
    "'customers','customer_addresses','loyalty_transactions','coupons','suppliers'";

fn raw_setting(conn: &Connection, category: &str, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT setting_value FROM local_settings WHERE setting_category=?1 AND setting_key=?2",
        params![category, key],
        |r| r.get(0),
    )
    .ok()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SharedScope {
    pub organization: String,
    pub group: String,
    pub terminal: String,
    pub branch: String,
}
impl SharedScope {
    pub fn read(conn: &Connection) -> Self {
        let setting = |key| raw_setting(conn, "terminal", key).unwrap_or_default();
        let identity = |key, binding| {
            raw_setting(conn, "terminal", key)
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| setting(binding))
        };
        let organization = identity("organization_id", "group_organization_id");
        let branch = identity("branch_id", "group_branch_id");
        let terminal = identity("terminal_id", "group_terminal_id");
        let trusted = setting("group_organization_id") == organization
            && setting("group_branch_id") == branch
            && setting("group_terminal_id") == terminal;
        let group = if trusted {
            setting("group_id")
        } else {
            String::new()
        };
        Self {
            group: if group.is_empty() {
                organization.clone()
            } else {
                group
            },
            organization,
            branch,
            terminal,
        }
    }
    pub fn capture(db: &crate::db::DbState) -> Result<Self, String> {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        Ok(Self::read(&conn))
    }
    pub fn ensure(&self, db: &crate::db::DbState) -> Result<(), String> {
        if *self != Self::capture(db)? {
            return Err("SHARED_GROUP_CHANGED".into());
        }
        Ok(())
    }
    pub fn key(&self) -> String {
        json!([self.organization, self.group, self.terminal]).to_string()
    }
}

pub(crate) fn is_shared_setting(category: &str, key: &str) -> bool {
    category == "staff_auth_cache"
        || (category == "local"
            && (key == "customer_cache_v1"
                || key == "customer_replay_aliases_v1"
                || key.starts_with("loyalty_")
                || key
                    .strip_prefix("admin_api_get::")
                    .is_some_and(is_shared_path)))
}
pub(crate) fn is_shared_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    [
        "/api/pos/customers",
        "/api/pos/loyalty",
        "/api/pos/coupons",
        "/api/pos/suppliers",
        "/api/pos/staff-directory",
    ]
    .iter()
    .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

pub(crate) fn setting_key(conn: &Connection, category: &str, key: &str) -> String {
    if key.starts_with("shared_v2:") {
        return key.into();
    }
    if !is_shared_setting(category, key) {
        return key.into();
    }
    let scope = SharedScope::read(conn);
    // An unregistered database has no usable shared identity yet.
    if scope.organization.is_empty() {
        return key.into();
    }
    format!("shared_v2:{}:{key}", scope.key())
}

/// Move legacy blobs without changing their contents. Never infer a group from a row.
pub(crate) fn migrate_legacy_settings(conn: &Connection) -> Result<(), String> {
    let scope = SharedScope::read(conn);
    if scope.organization.is_empty() {
        return Ok(());
    }
    let rows = {
        let mut stmt = conn.prepare("SELECT setting_category,setting_key,setting_value FROM local_settings WHERE setting_category IN ('local','staff_auth_cache')").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (category, key, value) in rows {
        if key.starts_with("shared_v2:") || !is_shared_setting(&category, &key) {
            continue;
        }
        let scoped = setting_key(conn, &category, &key);
        conn.execute("INSERT OR IGNORE INTO local_settings(setting_category,setting_key,setting_value,updated_at) VALUES(?1,?2,?3,datetime('now'))",params![category,scoped,value]).map_err(|e|e.to_string())?;
        conn.execute(
            "DELETE FROM local_settings WHERE setting_category=?1 AND setting_key=?2",
            params![category, key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn record_queue_scope(
    conn: &Connection,
    id: &str,
    table: &str,
    organization: &str,
) -> Result<(), String> {
    if !matches!(
        table,
        "customers" | "customer_addresses" | "loyalty_transactions" | "coupons" | "suppliers"
    ) {
        return Ok(());
    }
    let scope = SharedScope::read(conn);
    conn.execute("INSERT OR IGNORE INTO shared_queue_scope(queue_id,organization_id,group_key,terminal_id,branch_id) VALUES(?1,?2,?3,?4,?5)",params![id,organization,scope.group,scope.terminal,scope.branch]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Used before claiming, so holding an old group never spends an attempt.
pub(crate) fn queue_predicate(alias: &str) -> String {
    format!("({alias}.table_name NOT IN ({SHARED_TABLES}) OR EXISTS (SELECT 1 FROM shared_queue_scope sqs, pos_shared_scope active WHERE sqs.queue_id={alias}.id AND sqs.organization_id={alias}.organization_id AND sqs.organization_id=active.organization_id AND sqs.group_key=active.group_key AND sqs.terminal_id=active.terminal_id AND sqs.branch_id=active.branch_id))")
}
pub(crate) fn queue_item_allowed(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        &format!(
            "SELECT {} FROM parity_sync_queue WHERE id=?1",
            queue_predicate("parity_sync_queue")
        ),
        [id],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.unwrap_or(false))
    .map_err(|e| e.to_string())
}

/// Missing sidecars have no durable group-change history to prove ownership.
/// Payload group/terminal claims and current settings are not that proof. Only
/// the migration's recorded org-only ownership may bootstrap via
/// `adopt_legacy_queue_scope`; never manufacture ownership here.
/// Keep every original/retry column intact and publish the hold through the
/// existing Health/diagnostic set-aside listing. One INSERT is atomic and
/// idempotent, including when a renderer and native drain race.
pub(crate) fn set_aside_unclaimable(conn: &Connection) -> Result<usize, String> {
    let allowed = queue_predicate("q");
    conn.execute(&format!(r#"
        INSERT OR IGNORE INTO parity_sync_set_aside
            (queue_id,table_name,record_id,z_report_id,reason_code,server_message,
             set_aside_by_staff_id,set_aside_at,organization_id)
        SELECT q.id,q.table_name,q.record_id,NULL,
            CASE WHEN EXISTS(SELECT 1 FROM shared_queue_scope s WHERE s.queue_id=q.id)
                 THEN 'SHARED_SCOPE_CHANGED' ELSE 'SHARED_SCOPE_UNKNOWN' END,
            'Shared work kept on this till. Its original group cannot be used by the active terminal. Contact support to verify the original group before retrying.',
            'system:shared-scope',strftime('%Y-%m-%dT%H:%M:%fZ','now'),q.organization_id
        FROM parity_sync_queue q
        WHERE q.table_name IN ({SHARED_TABLES})
          AND q.status IN ('pending','failed','conflict') AND NOT {allowed}
    "#), []).map_err(|e| format!("shared queue set-aside: {e}"))
}

/// Clear old read caches only after their pending writes have durable scope metadata.
/// Queue payloads, retry state and all financial tables remain untouched.
pub(crate) fn cleanup_old_settings(conn: &Connection) -> Result<(), String> {
    let scope = SharedScope::read(conn);
    if scope.organization.is_empty() || scope.terminal.is_empty() {
        return Ok(());
    }
    let prefix = format!("shared_v2:{}:", scope.key());
    let keys = {
        let mut stmt=conn.prepare("SELECT setting_category,setting_key FROM local_settings WHERE setting_category IN ('local','staff_auth_cache') AND setting_key LIKE 'shared_v2:%'").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (category, key) in keys {
        if key.starts_with(&prefix) {
            continue;
        }
        let Some(end) = key.find("]:") else {
            continue;
        };
        let old: Vec<String> = serde_json::from_str(&key[10..=end])
            .map_err(|e| format!("shared cache identity: {e}"))?;
        if old.len() != 3 {
            continue;
        }
        let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM shared_queue_scope s JOIN parity_sync_queue q ON q.id=s.queue_id WHERE s.organization_id=?1 AND s.group_key=?2 AND s.terminal_id=?3)",params![old[0],old[1],old[2]],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !pending {
            conn.execute(
                "DELETE FROM local_settings WHERE setting_category=?1 AND setting_key=?2",
                params![category, key],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn validate_group_payload(resp: &Value) -> Result<(), String> {
    if let Some(value) = resp
        .pointer("/branch_info/group_id")
        .filter(|v| !v.is_null())
    {
        let id = value.as_str().ok_or("Invalid trusted group_id")?;
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid trusted group_id")?;
    }
    Ok(())
}

/// Additive cache identity migration. The queue payload and retry columns are never rewritten.
/// Called inside db::run_migration_tx's immediate transaction.
pub(crate) fn migrate_v109(conn: &Connection) -> Result<(), String> {
    // Idempotent like the other migrations: a database that already carries the group
    // scope (re-run from a lower recorded version) only records the version again.
    let already_applied: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='pos_shared_scope')              AND EXISTS(SELECT 1 FROM pragma_table_info('loyalty_customers') WHERE name='group_id')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if already_applied {
        conn.execute(
            "INSERT OR IGNORE INTO schema_version(version) VALUES(109)",
            [],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    conn.execute_batch(r#"
        CREATE VIEW pos_shared_scope AS
        WITH identity AS (SELECT
            COALESCE(NULLIF((SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='organization_id'),''),(SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_organization_id'),'') AS organization_id,
            COALESCE(NULLIF((SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='branch_id'),''),(SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_branch_id'),'') AS branch_id,
            COALESCE(NULLIF((SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='terminal_id'),''),(SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_terminal_id'),'') AS terminal_id)
        SELECT organization_id,branch_id,terminal_id,
            CASE WHEN (SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_organization_id')=organization_id
                  AND (SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_branch_id')=branch_id
                  AND (SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_terminal_id')=terminal_id
            THEN COALESCE(NULLIF((SELECT setting_value FROM local_settings WHERE setting_category='terminal' AND setting_key='group_id'),''),organization_id)
            ELSE organization_id END AS group_key FROM identity;
        CREATE TABLE shared_legacy_queue_scope (
            queue_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, group_key TEXT NOT NULL,
            terminal_id TEXT NOT NULL, branch_id TEXT NOT NULL);
        CREATE TABLE shared_queue_scope (
            queue_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, group_key TEXT NOT NULL,
            terminal_id TEXT NOT NULL, branch_id TEXT NOT NULL);
    "#).map_err(|e|e.to_string())?;
    conn.execute("INSERT INTO shared_legacy_queue_scope SELECT q.id,active.organization_id,active.group_key,active.terminal_id,active.branch_id FROM sync_queue q,pos_shared_scope active WHERE q.entity_type='loyalty_transaction'",[]).map_err(|e|e.to_string())?;
    // Rows written by the previous client belong to its original org-only shared scope.
    conn.execute(&format!("INSERT INTO shared_queue_scope SELECT q.id,q.organization_id,q.organization_id,active.terminal_id,active.branch_id FROM parity_sync_queue q,pos_shared_scope active WHERE q.table_name IN ({SHARED_TABLES})"),[]).map_err(|e|e.to_string())?;
    for table in [
        "loyalty_settings",
        "loyalty_customers",
        "loyalty_transactions",
    ] {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN group_id TEXT NOT NULL DEFAULT ''; ALTER TABLE {table} ADD COLUMN cache_terminal_id TEXT NOT NULL DEFAULT ''; UPDATE {table} SET group_id=organization_id,cache_terminal_id=(SELECT terminal_id FROM pos_shared_scope);")).map_err(|e|e.to_string())?;
    }
    // The legacy inline UNIQUE(profile,org) cannot be dropped as an index.
    let schema: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='loyalty_customers'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let schema = schema
        .replacen("loyalty_customers", "loyalty_customers_v109", 1)
        .replace(
            "UNIQUE(user_profile_id, organization_id)",
            "UNIQUE(user_profile_id, organization_id, group_id, cache_terminal_id)",
        )
        .replace("user_profile_id TEXT NOT NULL", "user_profile_id TEXT");
    conn.execute_batch(&schema).map_err(|e| e.to_string())?;
    conn.execute_batch(r#"
        INSERT INTO loyalty_customers_v109 SELECT * FROM loyalty_customers;
        DROP TABLE loyalty_customers;
        ALTER TABLE loyalty_customers_v109 RENAME TO loyalty_customers;
        CREATE UNIQUE INDEX idx_loyalty_customers_customer_group ON loyalty_customers(organization_id,group_id,cache_terminal_id,customer_id) WHERE customer_id IS NOT NULL AND TRIM(customer_id)<>'';
        CREATE INDEX idx_loyalty_customers_phone_group ON loyalty_customers(organization_id,group_id,cache_terminal_id,customer_phone);
        CREATE INDEX idx_loyalty_customers_card_group ON loyalty_customers(organization_id,group_id,cache_terminal_id,loyalty_card_uid);
    "#).map_err(|e|e.to_string())?;
    for table in [
        "loyalty_settings",
        "loyalty_customers",
        "loyalty_transactions",
    ] {
        conn.execute_batch(&format!(r#"
            CREATE TRIGGER {table}_group_identity AFTER INSERT ON {table}
            WHEN NEW.group_id='' BEGIN
                UPDATE {table} SET group_id=COALESCE(NULLIF((SELECT group_key FROM pos_shared_scope WHERE organization_id=NEW.organization_id),''),NEW.organization_id),
                    cache_terminal_id=(SELECT terminal_id FROM pos_shared_scope)
                WHERE id=NEW.id;
            END;
            CREATE INDEX idx_{table}_group ON {table}(organization_id,group_id,cache_terminal_id);
        "#)).map_err(|e|e.to_string())?;
    }
    migrate_legacy_settings(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_version(version) VALUES(109)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Org-as-group queues were created by this same store before the server migration.
/// They can keep replaying through its first trusted group. A real group-to-group
/// transition is held instead; it never changes the original operation's store.
pub(crate) fn adopt_legacy_queue_scope(conn: &Connection, old: &SharedScope) -> Result<(), String> {
    let current = SharedScope::read(conn);
    if old.group != old.organization
        || old.organization != current.organization
        || old.branch != current.branch
        || old.terminal != current.terminal
    {
        return Ok(());
    }
    if old.group != current.group {
        // Carry only replay IDs across the one-group bootstrap, never another
        // group's phone/name/address directory. Existing UUIDs stay unchanged.
        let old_key = format!("shared_v2:{}:customer_cache_v1", old.key());
        let old_cache: Vec<Value> = crate::db::get_setting(conn, "local", &old_key)
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default();
        let mut aliases: Vec<Value> =
            crate::db::get_setting(conn, "local", "customer_replay_aliases_v1")
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default();
        for entry in old_cache {
            if let (Some(id), Some(alias)) = (
                entry.get("id").and_then(Value::as_str),
                entry
                    .get(crate::sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD)
                    .and_then(Value::as_str),
            ) {
                if !aliases
                    .iter()
                    .any(|v| v.get("id").and_then(Value::as_str) == Some(id))
                {
                    aliases.push(
                        json!({"id":id,(crate::sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD):alias}),
                    );
                }
            }
        }
        crate::db::set_setting(
            conn,
            "local",
            "customer_replay_aliases_v1",
            &json!(aliases).to_string(),
        )?;
    }
    for table in ["shared_queue_scope", "shared_legacy_queue_scope"] {
        conn.execute(&format!("UPDATE {table} SET group_key=?1 WHERE organization_id=?2 AND group_key=?2 AND terminal_id=?3 AND branch_id=?4"),params![current.group,old.organization,old.terminal,old.branch]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn bind(conn: &Connection, group: &str) {
        for (key, value) in [
            ("organization_id", "org"),
            ("terminal_id", "till"),
            ("branch_id", "store"),
            ("group_organization_id", "org"),
            ("group_terminal_id", "till"),
            ("group_branch_id", "store"),
            ("group_id", group),
        ] {
            db::set_setting(conn, "terminal", key, value).unwrap();
        }
    }
    #[test]
    fn old_loyalty_cache_is_dropped_only_after_pending_ledger_is_replayed() {
        let database = crate::tests::harness::TestDb::open();
        let conn = database.state.conn.lock().unwrap();
        bind(&conn, "first");
        conn.execute("INSERT INTO loyalty_customers(id,user_profile_id,customer_id,organization_id,points_balance) VALUES('balance','profile','customer','org',17)",[]).unwrap();
        conn.execute("INSERT INTO loyalty_transactions(id,customer_id,organization_id,points,transaction_type,sync_state) VALUES('earn','customer','org',17,'earn','pending')",[]).unwrap();
        bind(&conn, "second");
        cleanup_old_loyalty_caches(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT points_balance FROM loyalty_customers WHERE id='balance'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            17
        );
        assert_eq!(
            conn.query_row(
                "SELECT sync_state FROM loyalty_transactions WHERE id='earn'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "pending"
        );
        conn.execute(
            "UPDATE loyalty_transactions SET sync_state='applied' WHERE id='earn'",
            [],
        )
        .unwrap();
        cleanup_old_loyalty_caches(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM loyalty_customers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn trusted_cache_scope_survives_plaintext_terminal_mirror_purge() {
        let database = crate::tests::harness::TestDb::open();
        let conn = database.state.conn.lock().unwrap();
        bind(&conn, "first");
        crate::db::set_setting(&conn, "local", "customer_cache_v1", "directory").unwrap();
        for key in ["organization_id", "branch_id", "terminal_id"] {
            crate::db::delete_setting(&conn, "terminal", key).unwrap();
        }
        assert_eq!(SharedScope::read(&conn).group, "first");
        assert_eq!(
            crate::db::get_setting(&conn, "local", "customer_cache_v1").as_deref(),
            Some("directory")
        );
        assert_eq!(
            conn.query_row("SELECT group_key FROM pos_shared_scope", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "first"
        );
    }

    #[test]
    fn trusted_settings_persist_group_and_older_payload_restores_org_fallback() {
        let database = crate::tests::harness::TestDb::open();
        {
            let conn = database.state.conn.lock().unwrap();
            bind(&conn, "");
        }
        let group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        crate::cache_terminal_settings_snapshot(&database.state,&json!({"branch_info":{"group_id":group,"group_name":"Shared","group_business_type":"restaurant"}})).unwrap();
        {
            let conn = database.state.conn.lock().unwrap();
            assert_eq!(SharedScope::read(&conn).group, group);
            assert_eq!(
                db::get_setting(&conn, "terminal", "group_name").as_deref(),
                Some("Shared")
            );
        }
        crate::cache_terminal_settings_snapshot(&database.state, &json!({"branch_info":{}}))
            .unwrap();
        let conn = database.state.conn.lock().unwrap();
        assert_eq!(SharedScope::read(&conn).group, "org");
    }
    #[test]
    fn only_legacy_org_queue_scope_is_adopted_into_its_store_first_group() {
        let database = crate::tests::harness::TestDb::open();
        let conn = database.state.conn.lock().unwrap();
        bind(&conn, "");
        conn.execute(
            "INSERT INTO shared_queue_scope VALUES('legacy','org','org','till','store')",
            [],
        )
        .unwrap();
        crate::db::set_setting(
            &conn,
            "local",
            "customer_cache_v1",
            r#"[{"id":"canonical","local_customer_id":"cust-local","phone":"210"}]"#,
        )
        .unwrap();
        let old = SharedScope::read(&conn);
        bind(&conn, "first");
        adopt_legacy_queue_scope(&conn, &old).unwrap();
        let aliases: Vec<Value> = serde_json::from_str(
            &crate::db::get_setting(&conn, "local", "customer_replay_aliases_v1").unwrap(),
        )
        .unwrap();
        assert_eq!(aliases[0]["local_customer_id"], "cust-local");
        assert!(aliases[0].get("phone").is_none());
        assert_eq!(
            conn.query_row("SELECT group_key FROM shared_queue_scope", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "first"
        );
        let old = SharedScope::read(&conn);
        bind(&conn, "second");
        adopt_legacy_queue_scope(&conn, &old).unwrap();
        assert_eq!(
            conn.query_row("SELECT group_key FROM shared_queue_scope", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "first"
        );
    }

    #[test]
    fn same_phone_code_and_aliases_are_isolated_and_legacy_group_is_unchanged() {
        let database = crate::tests::harness::TestDb::open();
        let conn = database.state.conn.lock().unwrap();
        bind(&conn, "");
        for (category, key, value) in [
            (
                "local",
                "customer_cache_v1",
                r#"[{"id":"one","phone":"210","_local_customer_id":"local-one"}]"#,
            ),
            (
                "local",
                "admin_api_get::/api/pos/coupons",
                r#"{"coupons":[{"code":"SAME"}]}"#,
            ),
            ("local", "admin_api_get::/api/pos/suppliers", "supplier-one"),
            ("staff_auth_cache", "branch_store", "staff-one"),
            ("local", "loyalty_customers_snapshot_v1", "points-one"),
        ] {
            db::set_setting(&conn, category, key, value).unwrap();
            let physical_key = setting_key(&conn, category, key);
            db::set_setting(&conn, category, &physical_key, value).unwrap();
            migrate_legacy_settings(&conn).unwrap();
            assert_eq!(
                db::get_setting(&conn, category, key).as_deref(),
                Some(value)
            );
            bind(&conn, "org");
            assert_eq!(
                db::get_setting(&conn, category, key).as_deref(),
                Some(value)
            );
            bind(&conn, "other");
            assert!(db::get_setting(&conn, category, key).is_none());
            db::set_setting(&conn, category, key, "other-value").unwrap();
            bind(&conn, "org");
            assert_eq!(
                db::get_setting(&conn, category, key).as_deref(),
                Some(value)
            );
        }
        bind(&conn, "other");
        db::set_setting(&conn, "terminal", "branch_id", "another-store").unwrap();
        assert_eq!(
            SharedScope::read(&conn).group,
            "org",
            "stale settings from a different store are never trusted"
        );
    }
    #[test]
    fn changed_group_holds_original_shared_queue_without_claiming_financial_operations() {
        let database = crate::tests::harness::TestDb::open();
        let conn = database.state.conn.lock().unwrap();
        bind(&conn, "first");
        conn.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,attempts,status) VALUES('customer','customers','c','INSERT','{\"phone\":\"210\"}','org',3,'pending')",[]).unwrap();
        record_queue_scope(&conn, "customer", "customers", "org").unwrap();
        conn.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,attempts,status) VALUES('payment','payments','p','INSERT','{\"branch_id\":\"store\"}','org',2,'pending')",[]).unwrap();
        bind(&conn, "second");
        assert!(!queue_item_allowed(&conn, "customer").unwrap());
        assert!(queue_item_allowed(&conn, "payment").unwrap());
        assert_eq!(
            conn.query_row(
                "SELECT attempts FROM parity_sync_queue WHERE id='customer'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        assert_eq!(
            conn.query_row(
                "SELECT data FROM parity_sync_queue WHERE id='payment'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            r#"{"branch_id":"store"}"#
        );
        bind(&conn, "first");
        assert!(queue_item_allowed(&conn, "customer").unwrap());
    }
    #[test]
    fn loyalty_phone_card_and_profile_uniqueness_use_group() {
        let database = crate::tests::harness::TestDb::open();
        let conn = database.state.conn.lock().unwrap();
        for (group, id, customer, points) in [
            ("first", "one", "customer-one", 17),
            ("second", "two", "customer-two", 91),
        ] {
            bind(&conn, group);
            conn.execute("INSERT INTO loyalty_customers(id,user_profile_id,customer_id,organization_id,customer_phone,loyalty_card_uid,points_balance) VALUES(?1,'same-profile',?2,'org','210','CARD',?3)",params![id,customer,points]).unwrap();
        }
        for (group, points) in [("first", 17), ("second", 91)] {
            bind(&conn, group);
            assert_eq!(conn.query_row("SELECT points_balance FROM loyalty_customers WHERE organization_id='org' AND group_id=(SELECT group_key FROM pos_shared_scope) AND cache_terminal_id=(SELECT terminal_id FROM pos_shared_scope) AND customer_phone='210' AND loyalty_card_uid='CARD'",[],|r|r.get::<_,i64>(0)).unwrap(),points);
        }
    }
    #[test]
    fn migration_preserves_all_pending_payloads_retry_states_and_ledger_ids() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(r#"
            CREATE TABLE schema_version(version INTEGER);
            CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT,updated_at TEXT,UNIQUE(setting_category,setting_key));
            CREATE TABLE parity_sync_queue(id TEXT,table_name TEXT,data TEXT,status TEXT,attempts INTEGER,claim_generation INTEGER,next_retry_at TEXT,organization_id TEXT);
            CREATE TABLE sync_queue(id TEXT,entity_type TEXT,payload TEXT,status TEXT,retry_count INTEGER);
            CREATE TABLE loyalty_settings(id TEXT PRIMARY KEY,organization_id TEXT);
            CREATE TABLE loyalty_customers(id TEXT PRIMARY KEY,user_profile_id TEXT,organization_id TEXT,customer_id TEXT,customer_phone TEXT,loyalty_card_uid TEXT,points_balance INTEGER,UNIQUE(user_profile_id, organization_id));
            CREATE TABLE loyalty_transactions(id TEXT PRIMARY KEY,organization_id TEXT,sync_state TEXT,points INTEGER,order_id TEXT);
            INSERT INTO loyalty_transactions VALUES('ledger-original','org','pending',17,'store-order');
            INSERT INTO loyalty_customers VALUES('balance-original','profile','org','customer','210','CARD',17);
            INSERT INTO sync_queue VALUES('legacy','loyalty_transaction','{"branch_id":"store","points":17}','pending',4);
        "#).unwrap();
        bind(&conn, "");
        for (i, table) in [
            "customers",
            "customer_addresses",
            "loyalty_transactions",
            "coupons",
            "suppliers",
            "orders",
            "payments",
            "staff_shifts",
            "cash_drawer_sessions",
        ]
        .iter()
        .enumerate()
        {
            for status in ["pending", "processing", "failed", "conflict"] {
                conn.execute("INSERT INTO parity_sync_queue VALUES(?1,?2,?3,?4,3,7,'later','org')",params![format!("{i}-{status}"),table,json!({"branch_id":"store","order_id":"original","idempotency_key":"original"}).to_string(),status]).unwrap();
            }
        }
        let snapshot = || {
            let mut stmt=conn.prepare("SELECT json_array(id,table_name,data,status,attempts,claim_generation,next_retry_at,organization_id) FROM parity_sync_queue ORDER BY id").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let before = snapshot();
        let tx = db::immediate_transaction(&conn).unwrap();
        migrate_v109(&tx).unwrap();
        tx.commit().unwrap();
        assert_eq!(snapshot(), before);
        assert_eq!(
            conn.query_row(
                "SELECT points_balance FROM loyalty_customers WHERE id='balance-original'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            17
        );
        assert_eq!(
            conn.query_row(
                "SELECT points FROM loyalty_transactions WHERE id='ledger-original'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            17
        );
        assert_eq!(
            conn.query_row(
                "SELECT retry_count FROM sync_queue WHERE id='legacy'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            4
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM shared_queue_scope", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            20
        );
    }
    #[test]
    fn only_trusted_group_uuid_or_legacy_null_is_accepted() {
        assert!(validate_group_payload(&json!({"branch_info":{"group_id":null}})).is_ok());
        assert!(validate_group_payload(&json!({})).is_ok());
        assert!(validate_group_payload(
            &json!({"branch_info":{"group_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}})
        )
        .is_ok());
        assert!(validate_group_payload(&json!({"branch_info":{"group_id":"untrusted"}})).is_err());
    }
}

pub(crate) fn prime_legacy_terminal_scope(
    conn: &Connection,
    scope: &crate::terminal_helpers::TerminalScopeSnapshot,
) -> Result<(), String> {
    for (key, source) in [
        ("group_organization_id", "organization_id"),
        ("group_branch_id", "branch_id"),
        ("group_terminal_id", "terminal_id"),
    ] {
        if raw_setting(conn, "terminal", key).is_none() {
            if let Some(value) = scope.value(source) {
                crate::db::set_setting(conn, "terminal", key, &value)?;
            }
        }
    }
    Ok(())
}

/// Shared read models may be discarded; pending ledger rows and their balance
/// copies stay until their original replay has completed or is explicitly kept.
pub(crate) fn cleanup_old_loyalty_caches(conn: &Connection) -> Result<(), String> {
    let scope = SharedScope::read(conn);
    if scope.organization.is_empty() || scope.terminal.is_empty() {
        return Ok(());
    }
    conn.execute_batch(r#"
        DELETE FROM loyalty_settings WHERE NOT (
            organization_id=(SELECT organization_id FROM pos_shared_scope)
            AND group_id=(SELECT group_key FROM pos_shared_scope)
            AND cache_terminal_id=(SELECT terminal_id FROM pos_shared_scope));
        DELETE FROM loyalty_customers WHERE NOT (
            organization_id=(SELECT organization_id FROM pos_shared_scope)
            AND group_id=(SELECT group_key FROM pos_shared_scope)
            AND cache_terminal_id=(SELECT terminal_id FROM pos_shared_scope))
            AND NOT EXISTS(SELECT 1 FROM loyalty_transactions pending WHERE pending.organization_id=loyalty_customers.organization_id AND pending.group_id=loyalty_customers.group_id AND pending.cache_terminal_id=loyalty_customers.cache_terminal_id AND pending.sync_state<>'applied')
            AND NOT EXISTS(SELECT 1 FROM shared_queue_scope s JOIN parity_sync_queue q ON q.id=s.queue_id WHERE s.organization_id=loyalty_customers.organization_id AND s.group_key=loyalty_customers.group_id AND s.terminal_id=loyalty_customers.cache_terminal_id);
        DELETE FROM loyalty_transactions WHERE sync_state='applied' AND NOT (
            organization_id=(SELECT organization_id FROM pos_shared_scope)
            AND group_id=(SELECT group_key FROM pos_shared_scope)
            AND cache_terminal_id=(SELECT terminal_id FROM pos_shared_scope))
            AND NOT EXISTS(SELECT 1 FROM parity_sync_queue q WHERE q.table_name='loyalty_transactions' AND q.record_id=loyalty_transactions.id)
            AND NOT EXISTS(SELECT 1 FROM sync_queue q WHERE q.entity_type='loyalty_transaction' AND q.entity_id=loyalty_transactions.id);
    "#).map_err(|e|e.to_string())?;
    Ok(())
}
