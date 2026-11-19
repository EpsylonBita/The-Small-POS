//! Versioned recovery actions share the till owners and confirmed write fence.
use super::{
    clock, confirmed_actions as existing,
    contracts::{self, Command},
    critical_op::SupportPermit,
    guards::{self, Scope},
    snapshot,
};
use crate::{order_notice_recovery as owner, sync_queue};
use owner::CorrectionRecipe;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path, time::Duration};

pub(super) const CAPABILITY: &str = "support.confirmed-actions.v2";
const REMEDY: &str = "remedy.run.v1";
const QUEUE: &str = "parity_sync_queue";

#[derive(Clone, Copy, PartialEq, Eq)]
enum QueueAction {
    Retry,
    SetAside,
    Return,
}
impl QueueAction {
    fn parse(id: &str) -> Option<Self> {
        match id {
            "queue.retry_row.v2" => Some(Self::Retry),
            "queue.set_aside.v2" => Some(Self::SetAside),
            "queue.return_to_queue.v2" => Some(Self::Return),
            _ => None,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Retry => "queue.retry_row.v2",
            Self::SetAside => "queue.set_aside.v2",
            Self::Return => "queue.return_to_queue.v2",
        }
    }
}

pub(super) fn manifest_ready() -> bool {
    CorrectionRecipe::ALL.into_iter().all(|recipe| {
        super::remedies::recipe(recipe.id(), 1)
            .is_ok_and(|entry| entry.action_id == recipe.action())
            && contracts::shared().other["confirmed_recipe_owners"][recipe.id()]["capability"]
                == CAPABILITY
    })
}

pub(super) fn handles(c: &Command) -> bool {
    c.payload["action"]["action_id"]
        .as_str()
        .is_some_and(|id| id == REMEDY || QueueAction::parse(id).is_some())
}

fn reference(id: &str) -> Value {
    json!({"kind":"queue","id":id})
}

pub(super) fn refusal(code: String) -> String {
    let value = match code.as_str() {
        "EDIT_CANONICAL_PREFLIGHT_UNREACHABLE" => return "TILL_OFFLINE".into(),
        "EDIT_SETTLEMENT_SCOPE_MISMATCH" => "ORDER_CORRECTION_SCOPE_CHANGED",
        "EDIT_CANONICAL_SNAPSHOT_INVALID" => "ORDER_CORRECTION_STALE_SERVER",
        "ORDER_VERSION_CONFLICT" => "ORDER_CORRECTION_CHANGED_DURING_READ",
        other => other,
    };
    if super::collectors::recovery_attempts::owner_refusal(value) {
        let error = match value {
            "ORDER_CORRECTION_CHANGED_DURING_READ"
            | "ORDER_CORRECTION_STALE_SERVER"
            | "ORDER_CORRECTION_NO_LONGER_ELIGIBLE"
            | "ORDER_CORRECTION_SCOPE_CHANGED" => "PAYLOAD_DRIFT",
            "SYNC_SET_ASIDE_CLAIMED_BY_Z" => "PROTECTED_RECORD",
            _ => "POLICY_REFUSED",
        };
        format!("{error}|{value}")
    } else if contracts::shared()
        .error_codes
        .iter()
        .any(|code| code == value)
    {
        value.into()
    } else {
        "POLICY_REFUSED".into()
    }
}

pub(super) struct Correction {
    row: owner::Refused,
    before: Value,
    answer: Value,
    fingerprint: String,
}

fn read_correction(
    conn: &Connection,
    scope: &Scope,
    key: &str,
    order_id: &str,
) -> Result<(owner::Refused, Value), String> {
    if super::identity::local(conn)? != *scope {
        return Err("ORDER_CORRECTION_SCOPE_CHANGED".into());
    }
    let row = owner::refused(conn, key)?
        .filter(|row| row.order == order_id)
        .ok_or("ORDER_CORRECTION_NO_LONGER_ELIGIBLE")?;
    existing::parked_queue_scope(conn, &existing::row(conn, QUEUE, key)?, scope)?;
    existing::not_claimed(conn, key)?;
    let before = owner::capture(conn, &row)?;
    Ok((row, before))
}

pub(super) fn prepare_correction(
    db: &crate::db::DbState,
    scope: &Scope,
    key: &str,
    order: &str,
    permit: &SupportPermit,
    check: impl Fn() -> Result<(), String>,
) -> Result<Correction, String> {
    check()?;
    let conn = super::replica::read_connection(
        &db.db_path,
        permit,
        clock::monotonic_now() + Duration::from_secs(2),
    )?;
    let (row, before) = read_correction(&conn, scope, key, order)?;
    if crate::order_notice_auto::editing(&row.order) {
        return Err("ORDER_CORRECTION_NEWER_HEADER_EDIT".into());
    }
    drop(conn);
    let result = tauri::async_runtime::block_on(async {
        let cancelled = async {
            while !permit.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::select! {
            biased;
            _ = cancelled => Err("PREEMPTED_BY_CRITICAL_OPERATION".into()),
            answer = tokio::time::timeout(Duration::from_secs(3), owner::fetch_canonical(db, &before)) => {
                answer.map_err(|_| "TILL_OFFLINE".to_string())?
            }
        }
    });
    check()?;
    let answer = result?;
    let canonical = owner::verify(&before, &answer)?;
    let conn = super::replica::read_connection(
        &db.db_path,
        permit,
        clock::monotonic_now() + Duration::from_secs(2),
    )?;
    let (current, captured) = read_correction(&conn, scope, key, order)?;
    if current.data != row.data
        || current.error != row.error
        || current.status != row.status
        || captured != before
    {
        return Err("ORDER_CORRECTION_CHANGED_DURING_READ".into());
    }
    let fingerprint = contracts::payload_hash(&json!({
        "scope":[scope.organization_id,scope.branch_id,scope.terminal_id],
        "source":row.id,"order":row.order,"status":row.status,"error":row.error,"original":row.data,
        "local":before,"canonical":canonical,
    }));
    Ok(Correction {
        row,
        before,
        answer,
        fingerprint,
    })
}

pub(super) fn correction_previews(
    db: &crate::db::DbState,
    scope: &Scope,
    permit: &SupportPermit,
    check: impl Fn() -> Result<(), String>,
) -> Result<Vec<Value>, String> {
    let conn = super::replica::read_connection(
        &db.db_path,
        permit,
        clock::monotonic_now() + Duration::from_secs(2),
    )?;
    let candidates = super::remedies::correction_notices(&conn, None)?;
    drop(conn);
    let mut previews = Vec::new();
    for notice in candidates
        .into_iter()
        .take(contracts::cap("confirmed", "perSession") as usize / 2)
    {
        check()?;
        let (Some(key), Some(order)) = (notice["queueId"].as_str(), notice["orderId"].as_str())
        else {
            continue;
        };
        let Ok(target) = prepare_correction(db, scope, key, order, permit, &check) else {
            continue;
        };
        for recipe in CorrectionRecipe::ALL {
            previews.push(json!({"action_id":REMEDY,"version":1,"observed_at":clock::iso(chrono::Utc::now().timestamp_millis()),
                "rows_cap":contracts::cap("confirmed","maxRows"),
                "inputs":{"recipe":{"id":recipe.id(),"version":1},"order_id":order,"target_key":key,"target_fingerprint":target.fingerprint}}));
        }
    }
    check()?;
    Ok(previews)
}

struct QueueMember {
    id: String,
    row: Value,
    marker: Option<Value>,
}
impl QueueMember {
    fn read(conn: &Connection, id: &str, scope: &Scope) -> Result<Self, String> {
        let row = existing::row(conn, QUEUE, id).map_err(|_| "PAYLOAD_DRIFT")?;
        existing::parked_queue_scope(conn, &row, scope)?;
        let marker = guards::rows(
            conn,
            "SELECT * FROM parity_sync_set_aside WHERE queue_id=?",
            &[id.to_string().into()],
        )?
        .into_iter()
        .next();
        if marker
            .as_ref()
            .is_some_and(|marker| !marker["z_report_id"].is_null())
        {
            return Err("SYNC_SET_ASIDE_CLAIMED_BY_Z".into());
        }
        if marker
            .as_ref()
            .is_some_and(|marker| marker["organization_id"] != scope.organization_id)
        {
            return Err("PROTECTED_RECORD".into());
        }
        Ok(Self {
            id: id.to_owned(),
            row,
            marker,
        })
    }
    fn fingerprint(&self) -> String {
        contracts::payload_hash(&json!({"row":self.row,"marker":self.marker}))
    }
    fn kind(&self) -> &'static str {
        match self.row["table_name"].as_str() {
            Some("orders") => "order",
            Some("payments" | "order_payments") => "payment_sync",
            Some("payment_adjustments") => "refund_sync",
            _ => "other",
        }
    }
    fn refusal(&self) -> &'static str {
        let error = self.row["error_message"].as_str().unwrap_or_default();
        let code = error.split_ascii_whitespace().next().unwrap_or_default();
        match code {
            "UNKNOWN_CONFLICT_REVIEW" => "UNKNOWN_CONFLICT_REVIEW",
            "ORDER_EDIT_BASE_UNAVAILABLE" => "ORDER_EDIT_BASE_UNAVAILABLE",
            _ if error.starts_with("Waiting for parent") || self.row["status"] == "pending" => {
                "DEPENDENCY_REFUSED"
            }
            _ if error.starts_with("HTTP 4") || error.starts_with("HTTP_4") => "HTTP_4XX_PERMANENT",
            _ => "UNKNOWN",
        }
    }
}

struct QueueGroup {
    members: Vec<QueueMember>,
    fingerprint: String,
}
impl QueueGroup {
    fn read(
        conn: &Connection,
        scope: &Scope,
        root: &str,
        action: QueueAction,
    ) -> Result<Self, String> {
        let root_row = QueueMember::read(conn, root, scope)?;
        if !matches!(root_row.row["status"].as_str(), Some("failed" | "conflict"))
            || !sync_queue::is_refused_for_good(
                root_row.row["error_message"].as_str().unwrap_or_default(),
                root_row.row["module_type"].as_str().unwrap_or_default(),
            )
        {
            return Err("SET_ASIDE_NOT_ELIGIBLE".into());
        }
        let max = contracts::cap("confirmed", "maxRows") as usize;
        let mut keys = vec![root.to_owned()];
        match action {
            QueueAction::Retry => sync_queue::confirm_parked_retry_ready(conn, root)?,
            QueueAction::Return => keys = sync_queue::retained_set_aside_group(conn, root)?,
            QueueAction::SetAside => {
                let mut cursor = 0;
                while cursor < keys.len() {
                    for id in sync_queue::rows_waiting_on_queue_row(conn, &keys[cursor])? {
                        if !keys.contains(&id) {
                            keys.push(id);
                        }
                    }
                    if keys.len() > max {
                        return Err("SET_ASIDE_NOT_ELIGIBLE".into());
                    }
                    cursor += 1;
                }
            }
        }
        let members = keys
            .iter()
            .map(|id| QueueMember::read(conn, id, scope))
            .collect::<Result<Vec<_>, _>>()?;
        if members.len() > max
            || members
                .iter()
                .any(|m| m.marker.is_some() != (action == QueueAction::Return))
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        if action != QueueAction::Retry {
            for member in &members {
                sync_queue::support_set_aside_owner_check(conn, &member.id)?;
            }
        }
        if action == QueueAction::Return {
            verify_retained_group(conn, &root_row, &members)?;
        }
        let tree = members
            .iter()
            .map(|m| (&m.id, m.fingerprint()))
            .collect::<std::collections::BTreeMap<_, _>>();
        let fingerprint = contracts::payload_hash(
            &json!({"root":root,"scope":[scope.organization_id,scope.branch_id,scope.terminal_id],"members":tree}),
        );
        Ok(Self {
            members,
            fingerprint,
        })
    }
    fn verifies(&self, input: &Value) -> bool {
        let Some(ids) = input["member_ids"].as_array() else {
            return false;
        };
        let exact = ids
            .iter()
            .filter_map(Value::as_str)
            .collect::<BTreeSet<_>>();
        ids.len() == exact.len()
            && exact == self.members.iter().map(|m| m.id.as_str()).collect()
            && input["target_fingerprint"] == self.members[0].fingerprint()
            && input["group_fingerprint"] == self.fingerprint
    }
}

/// A v2-created group remains bound to its original hashes, including when a
/// later return preview is requested. Older owner markers keep their durable
/// dependency proof and use the current, explicitly enumerated preimages.
fn verify_retained_group(
    conn: &Connection,
    root: &QueueMember,
    members: &[QueueMember],
) -> Result<(), String> {
    let Some(actor) = root
        .marker
        .as_ref()
        .and_then(|marker| marker["set_aside_by_staff_id"].as_str())
    else {
        return Ok(());
    };
    let Some(command) = actor
        .strip_prefix("support:")
        .and_then(|id| id.rsplit(':').next())
    else {
        return Ok(());
    };
    let recorded: Option<String> = conn
        .query_row(
            "SELECT json_extract(payload_json,'$.members') FROM recovery_action_log
         WHERE action_id='queue.set_aside.v2' AND entity_id=?1 AND actor_staff_id=?2
           AND json_extract(payload_json,'$.commandId')=?3 ORDER BY rowid DESC LIMIT 1",
            params![root.id, actor, command],
            |row| row.get(0),
        )
        .optional()
        .map_err(guards::error)?;
    let Some(recorded) = recorded else {
        return Ok(());
    };
    let recorded: Vec<Value> = serde_json::from_str(&recorded).map_err(|_| "PAYLOAD_DRIFT")?;
    if recorded.len() != members.len()
        || members.iter().any(|member| {
            !recorded.iter().any(|original| {
                original["id"] == member.id
                    && original["payloadSha256"] == existing::payload_hash(&member.row)
            }) || member
                .marker
                .as_ref()
                .is_none_or(|marker| marker["set_aside_by_staff_id"] != actor)
        })
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(())
}

pub(super) fn queue_previews(
    conn: &Connection,
    scope: &Scope,
    permit: &SupportPermit,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare("SELECT id FROM parity_sync_queue WHERE organization_id=?1 AND status IN ('failed','conflict') ORDER BY COALESCE(last_attempt,created_at) DESC,id LIMIT 50").map_err(guards::error)?;
    let ids = stmt
        .query_map([&scope.organization_id], |row| row.get::<_, String>(0))
        .map_err(guards::error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(guards::error)?;
    let mut previews = Vec::new();
    let max = contracts::cap("confirmed", "maxRows") as usize;
    for id in ids {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        for action in [
            QueueAction::Retry,
            QueueAction::SetAside,
            QueueAction::Return,
        ] {
            let Ok(group) = QueueGroup::read(conn, scope, &id, action) else {
                continue;
            };
            if 2 * group.members.len() + 1 > max {
                continue;
            }
            previews.push(json!({"action_id":action.id(),"version":2,"observed_at":clock::iso(chrono::Utc::now().timestamp_millis()),
                "rows_cap":max,"inputs":{"queue_id":id,"target_fingerprint":group.members[0].fingerprint(),"group_fingerprint":group.fingerprint,
                "member_ids":group.members.iter().map(|m| &m.id).collect::<Vec<_>>()},
                "members":group.members.iter().map(|m|json!({"queue_id":m.id,"record_kind":m.kind()})).collect::<Vec<_>>()}));
            if previews.len() == contracts::cap("confirmed", "perSession") as usize {
                return Ok(previews);
            }
        }
    }
    Ok(previews)
}

struct Outcome {
    affected: Vec<String>,
    pending: bool,
    evidence: Value,
    undo: Value,
}

fn apply_queue(
    conn: &Connection,
    c: &Command,
    scope: &Scope,
    now: i64,
    action: QueueAction,
) -> Result<Outcome, String> {
    let input = &c.payload["action"]["inputs"];
    let root = input["queue_id"].as_str().ok_or("INVALID_INPUT")?;
    let group = QueueGroup::read(conn, scope, root, action)?;
    if !group.verifies(input) {
        return Err("PAYLOAD_DRIFT".into());
    }
    let actor = format!("support:{}:{}", c.session_id, c.command_id);
    let audit = uuid::Uuid::new_v4().to_string();
    let reason = group.members[0].refusal();
    // Retain local preimages for the audit before resetting scheduling metadata.
    conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,entity_type,entity_id,success,actor_staff_id,payload_json,created_at) VALUES(?1,?2,?3,'parity_sync_queue',?4,1,?5,?6,?7)",
        params![audit,action.id(),reason,root,actor,json!({"actor":"founder_confirmed","commandId":c.command_id,"groupFingerprint":group.fingerprint,
            "members":group.members.iter().map(|m|json!({"id":m.id,"refusal":m.row["error_message"],"payloadSha256":existing::payload_hash(&m.row)})).collect::<Vec<_>>()}).to_string(),clock::iso(now)]).map_err(guards::error)?;
    let pending = action == QueueAction::Retry;
    let aside = action == QueueAction::SetAside;
    for member in &group.members {
        match action {
            QueueAction::Retry => sync_queue::retry_confirmed_parked_row(conn, &member.id)?,
            QueueAction::SetAside => {
                sync_queue::set_aside_confirmed_row(conn, &member.id, &actor)?;
            }
            QueueAction::Return => sync_queue::undo_set_aside(conn, &member.id, &actor)?,
        }
    }
    let mut members = Vec::new();
    let mut after_root = None;
    for source in &group.members {
        let after = QueueMember::read(conn, &source.id, scope)?;
        let before_hash = existing::payload_hash(&source.row);
        let after_hash = existing::payload_hash(&after.row);
        if before_hash != after_hash
            || after.marker.is_some() != aside
            || after.row["status"]
                != if pending {
                    json!("pending")
                } else {
                    source.row["status"].clone()
                }
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        if source.id == root {
            after_root = Some(after.fingerprint());
        }
        members.push(json!({"queue_id":source.id,"refusal_code":source.refusal(),"before_payload_sha256":before_hash,
            "after_payload_sha256":after_hash,"set_aside":aside,"record_kind":source.kind()}));
    }
    Ok(Outcome {
        affected: group
            .members
            .iter()
            .map(|member| member.id.clone())
            .collect(),
        pending,
        evidence: json!({"kind":"queue_v2","queue_id":root,"before_fingerprint":input["target_fingerprint"],
            "after_fingerprint":after_root.ok_or("PAYLOAD_DRIFT")?,"group_fingerprint":group.fingerprint,
            "disposition":if pending{"due"}else if aside{"set_aside"}else{"parked"},
            "actor":"founder_confirmed","audit_ref":audit,"retry_at":pending.then(||clock::iso(now)),"acknowledged_at":null,"members":members}),
        undo: json!({"kind":if aside{"set_aside_group"}else{"unavailable"},"reference":aside.then_some(root),
            "reason":if aside{None}else if pending{Some("original_may_have_reached_server")}else{Some("requires_new_confirmation")}}),
    })
}

fn apply_remedy(
    conn: &Connection,
    c: &Command,
    scope: &Scope,
    snap: &snapshot::Snapshot,
    prepared: Correction,
) -> Result<Outcome, String> {
    let input = &c.payload["action"]["inputs"];
    let recipe = input["recipe"]["id"]
        .as_str()
        .and_then(CorrectionRecipe::from_id)
        .ok_or("INVALID_INPUT")?;
    let order = input["order_id"].as_str().ok_or("INVALID_INPUT")?;
    let key = input["target_key"].as_str().ok_or("INVALID_INPUT")?;
    if input["target_fingerprint"] != prepared.fingerprint {
        return Err("ORDER_CORRECTION_STALE_SERVER".into());
    }
    let (_, captured) = read_correction(conn, scope, key, order)?;
    if captured != prepared.before {
        return Err("ORDER_CORRECTION_CHANGED_DURING_READ".into());
    }
    let applied = owner::apply_correction(
        conn,
        &prepared.row,
        &prepared.before,
        &prepared.answer,
        recipe,
        owner::CorrectionSnapshot::ConfirmedLocal(snap),
    )?;
    let remaining = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE id=?)",
            [key],
            |row| row.get::<_, bool>(0),
        )
        .map_err(guards::error)?;
    if remaining {
        return Err("PAYLOAD_DRIFT".into());
    }
    let replacement = applied.replacement_id.as_deref().map(reference);
    let pending = recipe == CorrectionRecipe::Resend;
    if pending {
        let replacement_row = existing::row(
            conn,
            QUEUE,
            applied.replacement_id.as_deref().ok_or("PAYLOAD_DRIFT")?,
        )?;
        if replacement_row["record_id"] != order || replacement_row["status"] != "pending" {
            return Err("PAYLOAD_DRIFT".into());
        }
    }
    let after = contracts::payload_hash(
        &json!({"before":prepared.fingerprint,"replacement":replacement,
        "applied_headers":crate::edit_settlement_recovery::capture_order_headers(conn,order)?,"canonical_version":applied.canonical_version}),
    );
    Ok(Outcome {
        affected: vec![order.to_owned()],
        pending,
        evidence: json!({"kind":"remedy","recipe":input["recipe"],"order_id":order,"source":reference(key),
            "before_fingerprint":prepared.fingerprint,"after_fingerprint":after,"retired_id":key,"replacement":replacement,
            "canonical_version":applied.canonical_version,"audit_ref":applied.audit_id,
            "verification":if pending{"replacement_queued"}else{"canonical_header_equal"}}),
        undo: if pending {
            json!({"kind":"unavailable","reference":null,"reason":"replacement_may_have_reached_server"})
        } else {
            json!({"kind":"snapshot","reference":snap.id,"reason":null})
        },
    })
}

pub(super) fn run(
    store: &Connection,
    live: &Path,
    c: &Command,
    scope: &Scope,
    now: i64,
    writer: &SupportPermit,
    snap: &snapshot::Snapshot,
    prepared: Option<Correction>,
    check: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    if snap.session != c.session_id
        || snap.reason != "pre_command"
        || snap.approval.is_some()
        || snapshot::metadata(store, &snap.id)?["integrity_hash"] != snap.hash
    {
        return Err("ORDER_CORRECTION_SNAPSHOT_INVALID".into());
    }
    let action = c.payload["action"]["action_id"]
        .as_str()
        .ok_or("INVALID_INPUT")?;
    let cap = c.payload["rows_cap"]
        .as_u64()
        .filter(|n| (1..=50).contains(n))
        .ok_or("INVALID_INPUT")?;
    let conn = owner::observer_connection(live, true)?;
    let schema_revision: i64 = conn
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(guards::error)?;
    let schema = guards::schema(&conn)?;
    if contracts::payload_hash(&json!(schema)) != snap.schema_sha256 {
        return Err("PAYLOAD_DRIFT".into());
    }
    let measurable = existing::Effects::install(&conn);
    check()?;
    let unedited = prepared
        .as_ref()
        .map(|target| crate::order_notice_auto::claim_unedited_order(&target.row.order))
        .transpose()?;
    let start = clock::monotonic_now();
    let tx = writer.begin_write_nowait(&conn)?;
    let revision: i64 = tx
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(guards::error)?;
    let deadline = start + Duration::from_millis(250);
    if revision != schema_revision
        || super::identity::local(&tx)? != *scope
        || snapshot::full_for_write(&tx, &schema, writer, deadline)? != snap.full
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    let result = if let Some(kind) = QueueAction::parse(action) {
        apply_queue(&tx, c, scope, now, kind)?
    } else {
        apply_remedy(&tx, c, scope, snap, prepared.ok_or("INVALID_INPUT")?)?
    };
    let changed = existing::changes(&tx, &measurable, cap)?;
    tx.execute(
        "INSERT INTO support_txn_marker VALUES(?,?)",
        params![c.command_id, clock::iso(now)],
    )
    .map_err(guards::error)?;
    let post = snapshot::full_for_write(&tx, &schema, writer, deadline)?;
    check()?;
    if writer.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    if clock::monotonic_now().duration_since(start) >= Duration::from_millis(250) {
        return Err("QUERY_TIMEOUT".into());
    }
    tx.commit().map_err(|_| "OUTCOME_UNKNOWN")?;
    drop(unedited);
    super::confirmed::save_post(store, &snap.id, &post)?;
    let _ = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM support_txn_marker WHERE command_id=?)",
            [&c.command_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(|_| "OUTCOME_UNKNOWN")?
        .filter(|seen| *seen)
        .ok_or("OUTCOME_UNKNOWN")?;
    owner::notify_queue_changed();
    Ok(
        json!({"step":"action","kind":"untrusted_till_data","observation_time":clock::iso(now+clock::monotonic_now().duration_since(start).as_millis() as i64),
        "snapshot_id":snap.id,
        "affected_ids":result.affected,"changed_rows":changed,"outcome":if result.pending{"pending"}else{"resolved"},
        "verification":{"fresh":true,"matches_expected":true,"sync":if result.pending{"pending"}else{"not_applicable"}},
        "evidence":result.evidence,"undo":result.undo}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::recovery::tests::{
        assert_order_notice_tomikro_outcome, order_notice_tomikro_endpoint,
        order_notice_tomikro_fixture, TOMIKRO_ORDER, TOMIKRO_QUEUE,
    };
    use crate::support::{confirmed_hash, critical_op, db::SupportDb, delivery, remedies};
    use std::time::Instant;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/confirmed-recovery-vectors.json"
        ))
        .unwrap()
    }

    fn command(index: usize) -> Command {
        serde_json::from_value(vectors()[index]["request_envelope"].clone()).unwrap()
    }

    fn dispatch(
        db: &crate::db::DbState,
        store: &SupportDb,
        c: &Command,
        scope: &Scope,
        correction: Option<Correction>,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<Value, String> {
        let gate = critical_op::global();
        let reader = gate
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let snap = snapshot::take(
            &store.conn,
            &db.db_path,
            &c.session_id,
            None,
            "pre_command",
            &reader,
        )?;
        check()?;
        drop(reader);
        let writer = gate.try_begin_support(true, None).map_err(str::to_string)?;
        run(
            &store.conn,
            &db.db_path,
            c,
            scope,
            chrono::Utc::now().timestamp_millis(),
            &writer,
            &snap,
            correction,
            check,
        )
    }

    #[test]
    fn embedded_confirmed_recovery_and_attempts_validate_the_wire_vectors() {
        assert!(manifest_ready());
        let contract = contracts::shared();
        for (index, vector) in vectors().as_array().unwrap().iter().enumerate() {
            let c = command(index);
            assert!(handles(&c));
            assert_eq!(confirmed_hash::hash(&c.payload), c.payload_sha256);
            assert!(
                delivery::valid_schema(&contract.payload_schemas[&c.kind], &c.payload, 0),
                "{}",
                vector["name"]
            );
            assert!(
                delivery::valid_schema(
                    &contract.other["schemas"]["ConfirmedResultSchema"],
                    &vector["result_envelope"]["data"],
                    0
                ),
                "{}",
                vector["name"]
            );
        }
        let history: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/recovery-attempts-vectors.json"
        ))
        .unwrap();
        let c: Command = serde_json::from_value(history[0]["request_envelope"].clone()).unwrap();
        assert_eq!(contracts::payload_hash(&c.payload), c.payload_sha256);
        assert!(delivery::valid_schema(
            &contract.payload_schemas[&c.kind],
            &c.payload,
            0
        ));
        assert!(delivery::valid_schema(
            &contract.other["schemas"]["RecoveryAttemptsResultSchema"],
            &history[0]["result_envelope"]["data"],
            0
        ));
    }

    #[test]
    fn both_confirmed_corrections_use_live_canonical_scope_without_staff_or_shift() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        for (index, recipe) in CorrectionRecipe::ALL.into_iter().enumerate() {
            let (db, answer) = order_notice_tomikro_fixture();
            let store = SupportDb::open(db.dir()).unwrap();
            let scope = super::super::identity::local(&db.state.conn.lock().unwrap()).unwrap();
            let server = crate::tests::fake_http::MockServer::new(answer.to_string());
            order_notice_tomikro_endpoint(&server.url);
            let reader = critical_op::global()
                .try_begin_support(false, None)
                .unwrap();
            let prepared = prepare_correction(
                &db.state,
                &scope,
                TOMIKRO_QUEUE,
                TOMIKRO_ORDER,
                &reader,
                || Ok(()),
            )
            .unwrap();
            let mut c = command(index);
            c.payload["rows_cap"] = json!(50);
            c.payload["action"]["inputs"] = json!({"recipe":{"id":recipe.id(),"version":1},
                "order_id":TOMIKRO_ORDER,"target_key":TOMIKRO_QUEUE,"target_fingerprint":prepared.fingerprint});
            drop(reader);
            let before = chrono::Utc::now().timestamp_millis();
            let result =
                dispatch(&db.state, &store, &c, &scope, Some(prepared), || Ok(())).unwrap();
            crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
            let resend = recipe == CorrectionRecipe::Resend;
            assert_eq!(
                result["outcome"],
                if resend { "pending" } else { "resolved" }
            );
            let conn = db.state.conn.lock().unwrap();
            assert_order_notice_tomikro_outcome(&conn, resend);
            let r = remedies::recipe(recipe.id(), 1).unwrap();
            assert_eq!(
                remedies::native_outcome(&conn, r, Some(TOMIKRO_QUEUE), Some(before))
                    .unwrap()
                    .as_deref(),
                Some(if resend { "pending" } else { "resolved" })
            );
            assert_eq!(
                remedies::native_outcome(&conn, r, Some("unrelated"), Some(before)).unwrap(),
                None
            );
            if let Some(replacement) = result["evidence"]["replacement"]["id"].as_str() {
                assert_eq!(
                    remedies::native_outcome(&conn, r, Some(replacement), Some(before))
                        .unwrap()
                        .as_deref(),
                    Some("pending")
                );
            }
            let reader = critical_op::global()
                .try_begin_support(false, None)
                .unwrap();
            let history = super::super::collectors::recovery_attempts::collect(
                &conn,
                &json!({"order_id":TOMIKRO_ORDER}),
                &scope,
                &reader,
            )
            .unwrap();
            assert!(delivery::valid_schema(
                &contracts::shared().other["schemas"]["RecoveryAttemptsResultSchema"],
                &history,
                0
            ));
            assert_eq!(
                history["content"]["attempts"][0]["actor"],
                "founder_confirmed"
            );
            assert!(!history.to_string().contains("Earlier customer"));
            drop(conn);
            assert_eq!(
                prepare_correction(
                    &db.state,
                    &scope,
                    TOMIKRO_QUEUE,
                    TOMIKRO_ORDER,
                    &reader,
                    || Ok(())
                )
                .err()
                .as_deref(),
                Some("ORDER_CORRECTION_NO_LONGER_ELIGIBLE")
            );
            assert_eq!(server.recorded().len(), 1);
        }
    }

    fn bind_queue(
        db: &crate::db::DbState,
        scope: &Scope,
        action: QueueAction,
        index: usize,
    ) -> Command {
        let conn = db.conn.lock().unwrap();
        let group = QueueGroup::read(&conn, scope, TOMIKRO_QUEUE, action).unwrap();
        let mut c = command(index);
        c.payload["action"]["inputs"] = json!({"queue_id":TOMIKRO_QUEUE,"target_fingerprint":group.members[0].fingerprint(),
            "group_fingerprint":group.fingerprint,"member_ids":group.members.iter().map(|m| &m.id).collect::<Vec<_>>()});
        c.payload["rows_cap"] = json!(50);
        c.payload_sha256 = confirmed_hash::hash(&c.payload);
        c
    }

    #[test]
    fn confirmed_set_aside_releases_tomikro_pre_z_conflict_and_return_stays_parked() {
        let _clock = clock::freeze_deadline_clock();
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, _) = order_notice_tomikro_fixture();
        let store = SupportDb::open(db.dir()).unwrap();
        let scope = super::super::identity::local(&db.state.conn.lock().unwrap()).unwrap();
        let status =
            || sync_queue::get_closeout_blocking_status(&db.state.conn.lock().unwrap()).unwrap();
        assert_eq!(status().conflicts, 1);
        let rows =
            || sync_queue::closeout_blocking_row_evidence(&db.state.conn.lock().unwrap()).unwrap();
        assert_eq!(
            rows()["rows"][0],
            json!({"queue_id":TOMIKRO_QUEUE,"table":"orders","status":"conflict",
            "code":"UNKNOWN_CONFLICT_REVIEW","set_aside":false})
        );
        let readiness = super::super::collectors::shifts::closeout_projection(Ok(
            json!({"parityPreDrain":rows()}),
        ));
        let blocker = &readiness["blockers"][0];
        assert_eq!(blocker["code"], "PARITY_PRE_Z");
        assert_eq!(blocker["count"], 1);
        assert!(blocker["detail"]["value"]
            .as_str()
            .unwrap()
            .contains("table=orders status=conflict code=UNKNOWN_CONFLICT_REVIEW set_aside=false"));
        let stale = bind_queue(&db.state, &scope, QueueAction::SetAside, 3);
        db.state.conn.lock().unwrap().execute(
            "INSERT INTO parity_sync_queue (id,table_name,record_id,operation,data,organization_id,module_type,status,error_message,created_at)
                VALUES('your-dependent','payments','your-payment','INSERT',json_object('orderId',?1),?2,'payment','pending','Waiting for parent order sync','2026-11-18T12:00:00Z')",
            params![TOMIKRO_ORDER,scope.organization_id],
        ).unwrap();
        assert_eq!(
            dispatch(&db.state, &store, &stale, &scope, None, || Ok(())).unwrap_err(),
            "PAYLOAD_DRIFT"
        );
        let set_aside = bind_queue(&db.state, &scope, QueueAction::SetAside, 3);
        assert!(delivery::valid_schema(
            &contracts::shared().payload_schemas[&set_aside.kind],
            &set_aside.payload,
            0
        ));
        let result = dispatch(&db.state, &store, &set_aside, &scope, None, || Ok(())).unwrap();
        crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
        assert_eq!(result["evidence"]["members"].as_array().unwrap().len(), 2);
        assert_eq!(status().conflicts, 0);
        assert_eq!(rows()["rows"], json!([]));
        {
            let conn = db.state.conn.lock().unwrap();
            conn.execute(
                "UPDATE parity_sync_set_aside SET z_report_id='listed-by-z' WHERE queue_id=?",
                [TOMIKRO_QUEUE],
            )
            .unwrap();
            let error = QueueGroup::read(&conn, &scope, TOMIKRO_QUEUE, QueueAction::Return).err();
            assert_eq!(error.as_deref(), Some("SYNC_SET_ASIDE_CLAIMED_BY_Z"));
            assert!(sync_queue::queue_row_is_set_aside(&conn, TOMIKRO_QUEUE).unwrap());
            conn.execute(
                "UPDATE parity_sync_set_aside SET z_report_id=NULL WHERE queue_id=?",
                [TOMIKRO_QUEUE],
            )
            .unwrap();
        }
        let returned = bind_queue(&db.state, &scope, QueueAction::Return, 4);
        let result = dispatch(&db.state, &store, &returned, &scope, None, || Ok(())).unwrap();
        assert_eq!(result["evidence"]["disposition"], "parked");
        assert_eq!(status().conflicts, 1);
        let unrelated = {
            let conn = db.state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,error_message,created_at)
                 VALUES('unrelated','orders','other-order','UPDATE','{}',?1,'orders','conflict','UNKNOWN_CONFLICT_REVIEW','2026-11-18T12:00:00Z')",
                [&scope.organization_id],
            ).unwrap();
            existing::row(&conn, QUEUE, "unrelated").unwrap()
        };
        let retry = bind_queue(&db.state, &scope, QueueAction::Retry, 2);
        let result = dispatch(&db.state, &store, &retry, &scope, None, || Ok(())).unwrap();
        crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
        assert_eq!(result["outcome"], "pending");
        assert_eq!(
            result["evidence"]["members"][0]["before_payload_sha256"],
            result["evidence"]["members"][0]["after_payload_sha256"]
        );
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(existing::row(&conn, QUEUE, "unrelated").unwrap(), unrelated);
        assert_eq!(
            existing::row(&conn, QUEUE, "your-dependent").unwrap()["error_message"],
            "Waiting for parent order sync"
        );
    }

    #[test]
    fn pending_canonical_fetch_and_commit_refuse_stale_scope_or_end() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let (db, mut answer) = order_notice_tomikro_fixture();
        let store = SupportDb::open(db.dir()).unwrap();
        let scope = super::super::identity::local(&db.state.conn.lock().unwrap()).unwrap();
        let reader = critical_op::global()
            .try_begin_support(false, None)
            .unwrap();
        let server = crate::tests::fake_http::MockServer::new(answer.to_string());
        order_notice_tomikro_endpoint(&server.url);
        assert!(prepare_correction(
            &db.state,
            &scope,
            TOMIKRO_QUEUE,
            "different-order",
            &reader,
            || Ok(())
        )
        .is_err());
        let original = prepare_correction(
            &db.state,
            &scope,
            TOMIKRO_QUEUE,
            TOMIKRO_ORDER,
            &reader,
            || Ok(()),
        )
        .unwrap();
        answer["orders"][0]["version"] = json!(5);
        let server = crate::tests::fake_http::MockServer::new(answer.to_string());
        order_notice_tomikro_endpoint(&server.url);
        let calls = std::cell::Cell::new(0);
        let end_after_wait = || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok(())
            } else {
                Err("SESSION_ENDED".into())
            }
        };
        assert_eq!(
            prepare_correction(
                &db.state,
                &scope,
                TOMIKRO_QUEUE,
                TOMIKRO_ORDER,
                &reader,
                end_after_wait
            )
            .err()
            .as_deref(),
            Some("SESSION_ENDED")
        );
        let refreshed = prepare_correction(
            &db.state,
            &scope,
            TOMIKRO_QUEUE,
            TOMIKRO_ORDER,
            &reader,
            || Ok(()),
        )
        .unwrap();
        let mut c = command(0);
        c.payload["action"]["inputs"]["order_id"] = json!(TOMIKRO_ORDER);
        c.payload["action"]["inputs"]["target_key"] = json!(TOMIKRO_QUEUE);
        c.payload["action"]["inputs"]["target_fingerprint"] = json!(original.fingerprint);
        drop(reader);
        assert_eq!(
            dispatch(&db.state, &store, &c, &scope, Some(refreshed), || Ok(())).unwrap_err(),
            "ORDER_CORRECTION_STALE_SERVER"
        );
        assert_eq!(
            dispatch(&db.state, &store, &c, &scope, Some(original), || Err(
                "SESSION_ENDED".into()
            ))
            .unwrap_err(),
            "SESSION_ENDED"
        );
        assert!(
            owner::refused(&db.state.conn.lock().unwrap(), TOMIKRO_QUEUE)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn confirmed_queue_v2_preempts_all_critical_operations_at_commit() {
        use critical_op::CriticalKind;
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, _) = order_notice_tomikro_fixture();
        let store = SupportDb::open(db.dir()).unwrap();
        let scope = super::super::identity::local(&db.state.conn.lock().unwrap()).unwrap();
        for kind in [
            CriticalKind::Checkout,
            CriticalKind::Card,
            CriticalKind::ShiftClose,
            CriticalKind::ZClose,
        ] {
            let calls = std::cell::Cell::new(0);
            let critical = std::cell::RefCell::new(None);
            let c = bind_queue(&db.state, &scope, QueueAction::SetAside, 3);
            let outcome = dispatch(&db.state, &store, &c, &scope, None, || {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    critical.replace(Some(critical_op::global().begin_critical(kind)));
                }
                Ok(())
            });
            assert_eq!(outcome.unwrap_err(), "PREEMPTED_BY_CRITICAL_OPERATION");
            drop(critical);
            let conn = db.state.conn.lock().unwrap();
            assert_eq!(
                sync_queue::get_closeout_blocking_status(&conn)
                    .unwrap()
                    .conflicts,
                1
            );
            assert!(!sync_queue::queue_row_is_set_aside(&conn, TOMIKRO_QUEUE).unwrap());
        }
    }

    #[test]
    fn confirmed_queue_crash_after_commit_keeps_the_marker_and_cannot_apply_twice() {
        use crate::support::{clock::ServerClock, delivery::Admission, executor::Executor};
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, _) = order_notice_tomikro_fixture();
        let store = SupportDb::open(db.dir()).unwrap();
        let scope = super::super::identity::local(&db.state.conn.lock().unwrap()).unwrap();
        let c = bind_queue(&db.state, &scope, QueueAction::SetAside, 3);
        let now = clock::parse(&c.server_time).unwrap();
        let admission = Admission {
            session_id: c.session_id.clone(),
            confirmed: true,
            active: true,
            online: true,
            visible: true,
            tier_ceiling: 3,
            tiers_enabled: [1, 2, 3].into_iter().collect(),
            disabled_tools: Default::default(),
            max_expires_at: c.expires_at.clone(),
        };
        let mut clock = ServerClock::default();
        clock
            .observe(&c.session_id, &c.server_time, Instant::now())
            .unwrap();
        store.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at)
            VALUES (?1,'active',3,?2,?2,?3)",params![c.session_id,c.expires_at,c.server_time]).unwrap();
        let mut executor = Executor::new(SupportDb::open(db.dir()).unwrap());
        assert!(executor.accept(&c, &admission, &clock).unwrap());
        executor.start(&c, &admission, &clock).unwrap();
        store.conn.execute_batch("CREATE TRIGGER stop_post_save BEFORE UPDATE OF post_change_watermark_json ON support_snapshots
            BEGIN SELECT RAISE(ABORT,'simulated crash after COMMIT'); END").unwrap();
        assert_eq!(
            dispatch(&db.state, &store, &c, &scope, None, || Ok(())).unwrap_err(),
            "OUTCOME_UNKNOWN"
        );
        drop(executor);
        let mut restarted = Executor::new(SupportDb::open(db.dir()).unwrap());
        restarted.recover(now + 1).unwrap();
        assert_eq!(
            restarted.pending_results(now + 1).unwrap()[0]["error_code"],
            "OUTCOME_UNKNOWN"
        );
        assert!(restarted.pending_results(now + 1).unwrap()[0]
            .get("data")
            .is_none());
        assert!(!restarted.accept(&c, &admission, &clock).unwrap());
        assert!(restarted.queued().unwrap().is_empty());
        let conn = db.state.conn.lock().unwrap();
        let marker: i64 = conn
            .query_row(
                "SELECT count(*) FROM support_txn_marker WHERE command_id=?",
                [&c.command_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marker, 1);
        assert!(sync_queue::queue_row_is_set_aside(&conn, TOMIKRO_QUEUE).unwrap());
    }
}
