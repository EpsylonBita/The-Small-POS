use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuditEntry {
    pub terminal_seq: i64,
    pub session_id: Option<String>,
    pub command_id: Option<String>,
    pub phase: String,
    pub status: Option<String>,
    pub outcome: Option<String>,
    pub input_sha256: Option<String>,
    pub result_sha256: Option<String>,
    pub created_at: String,
}

/// Must be called inside the same transaction as the state transition.
pub fn append(conn: &Connection, entry: &AuditEntry) -> rusqlite::Result<i64> {
    let seq: i64 = conn.query_row(
        "UPDATE support_audit_sequence SET last_seq=last_seq+1 WHERE id=1 RETURNING last_seq",
        [],
        |r| r.get(0),
    )?;
    conn.execute("INSERT INTO support_audit_local (terminal_seq,session_id,command_id,phase,status,outcome,input_sha256,result_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![seq,entry.session_id,entry.command_id,entry.phase,entry.status,entry.outcome,entry.input_sha256,entry.result_sha256,entry.created_at])?;
    Ok(seq)
}

pub fn pending(conn: &Connection) -> rusqlite::Result<Vec<AuditEntry>> {
    let mut stmt = conn.prepare("SELECT terminal_seq,session_id,command_id,phase,status,outcome,input_sha256,result_sha256,created_at FROM support_audit_local WHERE synced_at IS NULL ORDER BY terminal_seq LIMIT 200")?;
    let rows = stmt.query_map([], |r| {
        Ok(AuditEntry {
            terminal_seq: r.get(0)?,
            session_id: r.get(1)?,
            command_id: r.get(2)?,
            phase: r.get(3)?,
            status: r.get(4)?,
            outcome: r.get(5)?,
            input_sha256: r.get(6)?,
            result_sha256: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// Acknowledgement is restricted to entries actually sent, excluding reported gaps.
pub fn acknowledge(
    conn: &Connection,
    sent: &[AuditEntry],
    through: i64,
    gaps: &[(i64, i64)],
    now: &str,
) -> rusqlite::Result<()> {
    let tx = super::db::transaction(conn)?;
    for entry in sent {
        if entry.terminal_seq <= through
            && !gaps
                .iter()
                .any(|(a, b)| (*a..=*b).contains(&entry.terminal_seq))
        {
            tx.execute(
                "UPDATE support_audit_local SET synced_at=?1 WHERE terminal_seq=?2",
                params![now, entry.terminal_seq],
            )?;
        }
    }
    tx.commit()
}

pub fn prune(conn: &Connection, now_ms: i64) -> rusqlite::Result<usize> {
    let before = chrono::DateTime::from_timestamp_millis(
        now_ms - super::contracts::cap("accountability", "localAuditMinimumMs") as i64,
    )
    .ok_or(rusqlite::Error::InvalidQuery)?
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "DELETE FROM support_audit_local WHERE synced_at IS NOT NULL AND created_at <= ?1",
        [before],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audit_sequence_survives_pruning_and_only_sent_nongaps_are_acked() {
        let root = std::env::temp_dir().join(format!("support-audit-{}", uuid::Uuid::new_v4()));
        let db = super::super::db::SupportDb::open(&root).unwrap();
        let e = AuditEntry {
            terminal_seq: 0,
            session_id: None,
            command_id: None,
            phase: "refused".into(),
            status: None,
            outcome: None,
            input_sha256: None,
            result_sha256: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        };
        for _ in 0..3 {
            let tx = db.conn.unchecked_transaction().unwrap();
            append(&tx, &e).unwrap();
            tx.commit().unwrap();
        }
        let sent = pending(&db.conn).unwrap();
        acknowledge(
            &db.conn,
            &sent[..2],
            99,
            &[(2, 2)],
            "2026-02-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            prune(
                &db.conn,
                chrono::DateTime::parse_from_rfc3339("2026-03-01T00:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
            .unwrap(),
            1
        );
        let tx = db.conn.unchecked_transaction().unwrap();
        assert_eq!(append(&tx, &e).unwrap(), 4);
        tx.commit().unwrap();
        assert_eq!(pending(&db.conn).unwrap().len(), 3);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
