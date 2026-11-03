//! A closed build-time catalogue; the renderer only supplies current Health matches.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[derive(Default)]
pub struct ActionGate(AtomicBool);
pub struct ActionLease<'a>(&'a AtomicBool);
impl ActionGate {
    pub fn try_begin(&self) -> Result<ActionLease<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ActionLease(&self.0))
            .map_err(|_| "CONCURRENT_OPERATION".into())
    }
}
impl Drop for ActionLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
pub fn action_gate() -> &'static ActionGate {
    static GATE: ActionGate = ActionGate(AtomicBool::new(false));
    &GATE
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Remedy {
    pub id: String,
    pub version: u32,
    pub source: String,
    pub action_id: String,
    pub title_key: String,
    pub explanation_key: String,
    pub verification_key: String,
    pub mutates_data: bool,
    pub needs_onsite: bool,
    pub needs_staff_pin: bool,
    pub requires_snapshot: bool,
    pub attempt_cap: u64,
    pub cooldown_ms: u64,
}
#[derive(Deserialize)]
struct Catalogue {
    version: u32,
    recipes: Vec<Remedy>,
}
pub fn shipped() -> &'static [Remedy] {
    static RECIPES: OnceLock<Vec<Remedy>> = OnceLock::new();
    RECIPES.get_or_init(|| {
        let c: Catalogue =
            serde_json::from_str(include_str!("../../generated/recovery-recipes.json"))
                .expect("shipped recovery recipes");
        assert_eq!(c.version, 1);
        c.recipes
    })
}
pub fn recipe(id: &str, version: u64) -> Result<&'static Remedy, String> {
    let recipe = shipped()
        .iter()
        .find(|r| r.id == id)
        .ok_or("REMEDY_NOT_APPLICABLE")?;
    if u64::from(recipe.version) != version {
        return Err("PAYLOAD_MISMATCH".into());
    }
    Ok(recipe)
}
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Match {
    pub id: String,
    pub version: u32,
    pub title: String,
    pub explanation: String,
    pub matches_now: Value,
    pub target_count: u64,
}
#[derive(Default)]
pub struct Budget {
    pub attempts: u64,
    pub next: Option<i64>,
    pub last: Option<Value>,
}
pub fn budget(conn: &Connection, r: &Remedy, target: Option<&str>) -> Result<Budget, String> {
    let mut budget = Budget::default();
    let org = super::collectors::setting(conn, "terminal", "organization_id")
        .or_else(|| super::collectors::setting(conn, "organization", "id"))
        .ok_or("REMEDY_NOT_APPLICABLE")?;
    if r.id == "customer-address-default.retry" {
        let mut stmt=conn.prepare("SELECT s.setting_value FROM local_settings s JOIN parity_sync_queue q ON s.setting_key='customer-address-default.retry.v1:' || q.id WHERE q.organization_id=?2 AND s.setting_category='recovery_probe' AND (?1 IS NULL OR q.id=?1)").map_err(|_|"REMEDY_NOT_APPLICABLE")?;
        let rows = stmt
            .query_map(rusqlite::params![target, org], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| "REMEDY_NOT_APPLICABLE")?;
        for row in rows {
            let raw: Value = serde_json::from_str(&row.map_err(|_| "REMEDY_NOT_APPLICABLE")?)
                .map_err(|_| "REMEDY_ATTEMPT_CAP")?;
            if raw["recipeId"] != r.id || raw["recipeVersion"] != r.version {
                return Err("REMEDY_ATTEMPT_CAP".into());
            }
            let attempts = raw["attempts"].as_u64().ok_or("REMEDY_ATTEMPT_CAP")?;
            let at = super::clock::parse(raw["lastProbeAt"].as_str().ok_or("REMEDY_ATTEMPT_CAP")?)
                .map_err(|_| "REMEDY_ATTEMPT_CAP")?;
            budget.attempts = budget.attempts.max(attempts);
            budget.next = Some(budget.next.unwrap_or(0).max(at + r.cooldown_ms as i64));
        }
    }
    budget.last=conn.query_row("SELECT COALESCE(json_extract(a.payload_json,'$.outcome'),CASE a.success WHEN 1 THEN 'pending' ELSE 'failed' END),a.created_at FROM recovery_action_log a WHERE (a.recipe_id=?1 OR a.action_id=?2) AND (EXISTS(SELECT 1 FROM parity_sync_queue q WHERE (q.id=CAST(a.queue_id AS TEXT) OR q.id=a.entity_id) AND q.organization_id=?3) OR EXISTS(SELECT 1 FROM orders o WHERE o.id=a.order_id AND o.organization_id=?3) OR json_extract(a.payload_json,'$.organizationId')=?3) AND (?4 IS NULL OR a.entity_id=?4) ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1",rusqlite::params![r.id,r.action_id,org,target],|row|Ok(json!({"outcome":row.get::<_,String>(0)?,"at":row.get::<_,String>(1)?}))).optional().map_err(|_|"REMEDY_NOT_APPLICABLE")?;
    if budget.last.as_ref().is_some_and(|last| {
        !matches!(
            last["outcome"].as_str(),
            Some("resolved" | "failed" | "pending" | "unknown")
        )
    }) {
        budget.last = None;
    }
    Ok(budget)
}

/// Only the native queue owner can prove that a scheduled address retry was
/// accepted by the server. Renderer audit claims are never verification.
pub fn native_outcome(
    conn: &Connection,
    r: &Remedy,
    target: Option<&str>,
    since: Option<i64>,
) -> Result<Option<String>, String> {
    if r.id != "customer-address-default.retry" {
        return Ok(None);
    }
    let org = super::collectors::setting(conn, "terminal", "organization_id")
        .or_else(|| super::collectors::setting(conn, "organization", "id"))
        .ok_or("REMEDY_NOT_APPLICABLE")?;
    let evidence: Option<(String, String)> = conn.query_row("SELECT json_extract(a.payload_json,'$.outcome'),COALESCE(json_extract(a.payload_json,'$.verifiedAt'),a.created_at) FROM recovery_action_log a JOIN parity_sync_queue q ON q.id=a.entity_id AND q.organization_id=?1 WHERE a.recipe_id=?2 AND a.recipe_version=?3 AND a.action_id='auto_retry' AND a.entity_type='parity_sync_queue' AND (?4 IS NULL OR a.entity_id=?4) ORDER BY a.rowid DESC LIMIT 1", rusqlite::params![org,r.id,r.version,target], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "REMEDY_NOT_APPLICABLE")?;
    Ok(evidence
        .filter(|(_, at)| {
            since
                .zip(super::clock::parse(at).ok())
                .is_some_and(|(start, at)| at >= start)
        })
        .map(|(outcome, _)| outcome))
}
pub fn eligible(
    r: &Remedy,
    m: &Match,
    b: &Budget,
    now: i64,
    stale: bool,
    busy: bool,
) -> Result<(), String> {
    if busy {
        return Err("CONCURRENT_OPERATION".into());
    }
    if stale || m.matches_now != true || m.target_count == 0 {
        return Err("REMEDY_NOT_APPLICABLE".into());
    }
    if b.attempts >= r.attempt_cap {
        return Err("REMEDY_ATTEMPT_CAP".into());
    }
    if b.next.is_some_and(|at| at > now) {
        return Err("REMEDY_COOLDOWN".into());
    }
    Ok(())
}
pub fn summarize(r: &Remedy, m: Option<&Match>, b: &Budget, now: i64) -> Value {
    json!({"id":r.id,"version":r.version,"source":r.source,"platform":"windows","title":m.map(|m|m.title.as_str()).unwrap_or(&r.title_key),"explanation":m.map(|m|m.explanation.as_str()).unwrap_or(&r.explanation_key),"mutates_data":r.mutates_data,"needs_onsite":r.needs_onsite,"needs_staff_pin":r.needs_staff_pin,"matches_now":m.map(|m|m.matches_now.clone()).unwrap_or(json!("not_applicable")),"target_count":m.map(|m|m.target_count).unwrap_or(0),"cooldown":{"active":b.next.is_some_and(|at|at>now),"next_allowed_at":b.next.map(super::clock::iso)},"attempts":{"used":b.attempts,"cap":r.attempt_cap},"last_outcome":b.last})
}
#[cfg(test)]
mod tests {
    #[test]
    fn reconnect_is_guidance_only_and_remote_run_refuses_it() {
        assert!(!super::shipped().iter().any(|r| r.id == "reconnect"));
        assert_eq!(
            super::recipe("reconnect", 1).unwrap_err(),
            "REMEDY_NOT_APPLICABLE"
        );
    }
    #[test]
    fn drift_check_rejects_a_stale_generated_catalogue() {
        let target =
            std::env::temp_dir().join(format!("your-stale-recipes-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&target, "{\"version\":1,\"recipes\":[]}\n").unwrap();
        let output = std::process::Command::new("node")
            .args([
                "../scripts/emit-recovery-recipes.mjs",
                "--check",
                "--output",
            ])
            .arg(&target)
            .output()
            .unwrap();
        std::fs::remove_file(target).unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("recovery-recipes.json drift"));
    }
    #[test]
    fn emitted_renderer_and_native_recipe_drift() {
        let output = std::process::Command::new("node")
            .arg("../scripts/emit-recovery-recipes.mjs")
            .arg("--check")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(super::shipped().len(), 15);
    }
}
