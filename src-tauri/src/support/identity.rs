//! Support identity comes only from non-secret local mirrors. Never fall back
//! to credentials: missing, conflicting or unreadable mirrors are unavailable.
use super::{guards::Scope, session::Core};
use rusqlite::{Connection, OptionalExtension};

pub fn local(conn: &Connection) -> Result<Scope, String> {
    let read = |category: &str, key: &str| -> Result<Option<String>, String> {
        let value: Option<String> = conn
            .query_row(
                "SELECT setting_value FROM local_settings WHERE setting_category=?1 AND setting_key=?2",
                [category, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "PAYLOAD_DRIFT")?
            .flatten();
        Ok(value.filter(|v| !v.trim().is_empty()))
    };
    let organization = read("terminal", "organization_id")?;
    let alternate = read("organization", "id")?;
    if organization
        .as_ref()
        .zip(alternate.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(Scope {
        organization_id: organization.or(alternate).ok_or("PAYLOAD_DRIFT")?,
        branch_id: read("terminal", "branch_id")?.ok_or("PAYLOAD_DRIFT")?,
        terminal_id: read("terminal", "terminal_id")?.ok_or("PAYLOAD_DRIFT")?,
    })
}

pub fn for_session(conn: &Connection, core: &Core, session: &str) -> Result<Scope, String> {
    let scope = local(conn)?;
    if core.terminal_id.as_deref() != Some(scope.terminal_id.as_str())
        || !core
            .session
            .as_ref()
            .is_some_and(|s| s.info.session_id == session && s.admission.active)
    {
        return Err("SESSION_ENDED".into());
    }
    Ok(scope)
}

pub(super) fn observed_session(
    conn: &Connection,
    live: &std::path::Path,
    session: &str,
) -> Result<Scope, String> {
    let scope = local(conn)?;
    let support = Connection::open_with_flags(
        live.with_file_name("support.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "SESSION_ENDED")?;
    let encoded: String = support.query_row(
        "SELECT e.scope_json FROM support_evidence_sessions e JOIN support_session_state s USING(session_id) WHERE s.session_id=? AND s.status='active'",
        [session],|row| row.get(0),
    ).map_err(|_|"SESSION_ENDED")?;
    let observed: serde_json::Value =
        serde_json::from_str(&encoded).map_err(|_| "PAYLOAD_DRIFT")?;
    if observed["organization_id"] != scope.organization_id
        || observed["branch_id"] != scope.branch_id
        || observed["terminal_id"] != scope.terminal_id
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_requires_complete_consistent_mirrors_without_keyring() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
        assert!(local(&conn).is_err());
        for (key, value) in [
            ("organization_id", "your-org"),
            ("branch_id", "your-branch"),
            ("terminal_id", "your-terminal"),
        ] {
            crate::db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        assert_eq!(local(&conn).unwrap().terminal_id, "your-terminal");
        crate::db::set_setting(&conn, "organization", "id", "your-other-org").unwrap();
        assert!(local(&conn).is_err());
        conn.execute_batch("DROP TABLE local_settings").unwrap();
        assert!(local(&conn).is_err());
    }
}
