//! Shipped tier-one dispatch. All database observations open private read handles.
use super::{
    collectors,
    contracts::Command,
    critical_op::SupportPermit,
    dispatch, network,
    replica::{self, ReplicaManager},
    sql_query,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
pub const KINDS: &[&str] = &[
    "till_health",
    "till_error_codes",
    "till_sync_queue",
    "till_settings",
    "till_shifts",
    "till_modules",
    "till_printers",
    "till_diagnostics_bundle",
    "till_logs",
    "till_sql_schema",
    "till_sql_query",
    "till_sql_refresh_replica",
    "till_network_info",
    "till_network_scan",
    "till_network_identify",
];
pub struct Tools {
    live: PathBuf,
    replicas: Mutex<ReplicaManager>,
    network: Mutex<network::DiscoveryState>,
}
fn installed() -> &'static Mutex<Option<Arc<Tools>>> {
    static TOOLS: OnceLock<Mutex<Option<Arc<Tools>>>> = OnceLock::new();
    TOOLS.get_or_init(Mutex::default)
}
pub fn initialize(dir: &Path) -> Result<(), String> {
    replica::cleanup_startup(dir)?;
    let evidence =
        rusqlite::Connection::open(dir.join("support.db")).map_err(|_| "INTERNAL_ERROR")?;
    let evidence_tx = super::db::transaction(&evidence).map_err(|_| "INTERNAL_ERROR")?;
    evidence_tx.execute_batch("CREATE TABLE IF NOT EXISTS support_network_evidence(command_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,kind TEXT NOT NULL,parameters_json TEXT NOT NULL,created_at TEXT NOT NULL);DELETE FROM support_network_evidence WHERE julianday(created_at)<julianday('now','-30 days')").map_err(|_|"INTERNAL_ERROR")?;
    evidence_tx.commit().map_err(|_| "INTERNAL_ERROR")?;
    let tools = Arc::new(Tools {
        live: dir.join("pos.db"),
        replicas: Mutex::default(),
        network: Mutex::default(),
    });
    // register only native reviewed handlers, never code from a command payload.
    for kind in KINDS {
        let tools = tools.clone();
        dispatch::register_tier_one(
            kind,
            Arc::new(move |command, permit| tools.run(command, permit)),
        )?;
    }
    *installed().lock().map_err(|_| "INTERNAL_ERROR")? = Some(tools);
    Ok(())
}
pub fn end_session() {
    let tools = installed().lock().ok().and_then(|t| t.clone());
    if let Some(tools) = tools {
        // A collector never owns the Core mutex. Ending takes away authority
        // first; cancelled workers cannot publish a new replica afterwards.
        if let Ok(mut replica) = tools.replicas.lock() {
            replica.clear();
        }
        if let Ok(mut network) = tools.network.lock() {
            *network = network::DiscoveryState::default();
        }
    }
}
impl Tools {
    fn run(&self, c: &Command, permit: &SupportPermit) -> Result<Value, String> {
        let input = &c.payload["data"];
        let result = match c.kind.as_str() {
            "till_sql_query" | "till_sql_schema" | "till_sql_refresh_replica" => {
                if input["database"].as_str().is_some_and(|db| db != "main") {
                    return Err("UNSUPPORTED_ON_PLATFORM".into());
                }
                let mut manager = self.replicas.lock().map_err(|_| "INTERNAL_ERROR")?;
                let at = Instant::now();
                let r = manager.get(
                    &self.live,
                    &c.session_id,
                    c.kind == "till_sql_refresh_replica",
                    permit,
                )?;
                if c.kind == "till_sql_query" {
                    sql_query::query(r, input, permit)?
                } else if c.kind == "till_sql_schema" {
                    json!({"database":"main","replica_taken_at":r.taken_at,"sqlite_version":rusqlite::version(),"tables":r.schema})
                } else {
                    json!({"replica_taken_at":r.taken_at,"databases":["main"],"build_ms":at.elapsed().as_millis(),"size_bytes":std::fs::metadata(&r.path).map_err(|_|"INTERNAL_ERROR")?.len()})
                }
            }
            "till_network_info" => network::info::collect(permit, self.public_admin_base(permit)?)?,
            "till_network_scan" | "till_network_identify" => {
                let configured = self.configured(permit)?;
                let pairs = configured
                    .iter()
                    .map(|(ip, port, _, _)| (ip.clone(), *port))
                    .collect::<Vec<_>>();
                let mut state = self.network.lock().map_err(|_| "INTERNAL_ERROR")?;
                state.session(&c.session_id);
                let result = if c.kind == "till_network_identify" {
                    self.audit_network(c, input)?;
                    network::identify::identify(input, &mut state, &pairs, permit)?
                } else {
                    let interfaces = network::info::interfaces(permit)?;
                    let (selected, ports) = network::scan::parameters(input, &interfaces)?;
                    self.audit_network(c,&json!({"input":input,"selected_interfaces":selected,"ports":ports,"per_host_timeout_ms":500,"concurrency":32,"deadline_ms":15000,"result_cap":100,"port_allowlist_version":1}))?;
                    let mut result = network::scan::sweep(
                        input,
                        &interfaces,
                        &mut state,
                        permit,
                        &network::scan::TcpConnector,
                    )?;
                    if let Some(devices) = result["devices"].as_array_mut() {
                        for d in devices {
                            if let Some((_, _, kind, id)) = configured
                                .iter()
                                .find(|(ip, _, _, _)| d["ip"] == ip.as_str())
                            {
                                d["matches_configured_device"] =
                                    json!({"device_kind":kind,"device_id":id});
                            }
                        }
                    }
                    result
                };
                self.audit_network_result(c, &result)?;
                result
            }
            "till_logs" => {
                collectors::logs::collect(&crate::diagnostics::get_log_dir(), input, permit)?
            }
            "till_error_codes" => collectors::error_codes::collect(input, permit)?,
            kind => {
                let conn = replica::read_connection(
                    &self.live,
                    permit,
                    Instant::now() + Duration::from_secs(5),
                )?;
                conn.execute_batch("PRAGMA query_only=ON")
                    .map_err(replica::sql_error)?;
                match kind {
                    "till_health" => collectors::health::collect(&conn)?,
                    "till_settings" => collectors::settings::collect(&conn)?,
                    "till_sync_queue" => collectors::sync_queue::collect(&conn, &permit)?,
                    "till_shifts" => collectors::shifts::collect(&conn, &permit)?,
                    "till_modules" => collectors::modules::collect(&conn)?,
                    "till_printers" => collectors::printers::collect(&conn)?,
                    "till_diagnostics_bundle" => {
                        collectors::diagnostics::collect(&conn, input, permit)?
                    }
                    _ => return Err("FEATURE_DISABLED".into()),
                }
            }
        };
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        collectors::meta(result)
    }
    fn public_admin_base(&self, permit: &SupportPermit) -> Result<Option<String>, String> {
        let conn =
            replica::read_connection(&self.live, permit, Instant::now() + Duration::from_secs(2))?;
        if let Some(url) = collectors::setting(&conn, "terminal", "admin_dashboard_url")
            .or_else(|| collectors::setting(&conn, "sync", "admin_dashboard_url"))
        {
            return Ok(Some(url));
        }
        let Some(org) = collectors::setting(&conn, "terminal", "organization_id")
            .or_else(|| collectors::setting(&conn, "organization", "id"))
        else {
            return Ok(None);
        };
        let path = self
            .live
            .parent()
            .ok_or("INTERNAL_ERROR")?
            .join("module-cache.json");
        if !std::fs::metadata(&path).is_ok_and(|m| m.len() <= 256 * 1024) {
            return Ok(None);
        }
        let Some(cache) = std::fs::read(path)
            .ok()
            .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
        else {
            return Ok(None);
        };
        if cache["organizationId"] != org {
            return Ok(None);
        }
        Ok(cache["adminDashboardUrl"].as_str().map(str::to_string))
    }
    fn audit_network_result(&self, c: &Command, result: &Value) -> Result<(), String> {
        let path = self
            .live
            .parent()
            .ok_or("INTERNAL_ERROR")?
            .join("support.db");
        let conn = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        let tx = super::db::transaction(&conn).map_err(|_| "INTERNAL_ERROR")?;
        let summary = json!({"parameters":result["parameters"],"probe":result["probe"],"probe_status":result["probe_status"],"devices":result["devices"].as_array().map(Vec::len),"hosts_probed":result["hosts_probed"],"stopped":result["stopped"]});
        tx.execute("UPDATE support_network_evidence SET parameters_json=json_set(parameters_json,'$.native_result',json(?1)) WHERE command_id=?2 AND session_id=?3",rusqlite::params![summary.to_string(),c.command_id,c.session_id]).map_err(|_|"INTERNAL_ERROR")?;
        tx.commit().map_err(|_| "INTERNAL_ERROR".into())
    }
    fn audit_network(&self, c: &Command, parameters: &Value) -> Result<(), String> {
        let path = self
            .live
            .parent()
            .ok_or("INTERNAL_ERROR")?
            .join("support.db");
        let conn = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        let tx = super::db::transaction(&conn).map_err(|_| "INTERNAL_ERROR")?;
        tx.execute("INSERT INTO support_network_evidence(command_id,session_id,kind,parameters_json,created_at) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![c.command_id,c.session_id,c.kind,parameters.to_string(),chrono::Utc::now().to_rfc3339()]).map_err(|_|"INTERNAL_ERROR")?;
        tx.commit().map_err(|_| "INTERNAL_ERROR".into())
    }
    fn configured(
        &self,
        permit: &SupportPermit,
    ) -> Result<Vec<(String, u16, String, String)>, String> {
        let conn =
            replica::read_connection(&self.live, permit, Instant::now() + Duration::from_secs(2))?;
        let mut targets = Vec::new();
        for row in collectors::rows(
            &conn,
            "SELECT id,connection_json FROM printer_profiles WHERE enabled=1 LIMIT 50",
        )? {
            if let Some(v) = row["connection_json"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            {
                if let Some(ip) = v["ip"].as_str().or_else(|| v["host"].as_str()).filter(|s| {
                    s.parse::<std::net::Ipv4Addr>()
                        .is_ok_and(network::info::private)
                }) {
                    let port = v["port"].as_u64().unwrap_or(9100);
                    if let Ok(port) = u16::try_from(port) {
                        targets.push((
                            ip.into(),
                            port,
                            "printer".into(),
                            row["id"].as_str().unwrap_or("").into(),
                        ));
                    }
                    // The printer web probe is its separate read-only endpoint.
                    targets.push((
                        ip.into(),
                        80,
                        "printer".into(),
                        row["id"].as_str().unwrap_or("").into(),
                    ));
                }
            }
        }
        for row in collectors::rows(&conn,"SELECT id,device_type,connection_details FROM ecr_devices WHERE connection_type='network' LIMIT 50")? {
            if let Some(v)=row["connection_details"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()){
                if let Some(ip)=v["ip"].as_str().or_else(||v["host"].as_str()).or_else(||v["ipAddress"].as_str()).filter(|s|s.parse::<std::net::Ipv4Addr>().is_ok_and(network::info::private)){
                    if let Some(port)=v["port"].as_u64().and_then(|n|u16::try_from(n).ok()).filter(|p|network::scan::PORTS.contains(p)){
                        targets.push((ip.into(),port,if row["device_type"]=="cash_register"{"cash_register"}else{"card_terminal"}.into(),row["id"].as_str().unwrap_or("").into()));
                    }
                }
            }
        }
        Ok(targets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collectors_are_read_only_and_preserve_business_file_hash() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _test_gate = super::super::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        {
            let conn = db.state.conn.lock().unwrap();
            crate::db::set_setting(
                &conn,
                "terminal",
                "organization_id",
                "your-test-organization",
            )
            .unwrap();
            crate::db::set_setting(&conn, "staff", "pin_hash", "your-test-secret").unwrap();
            crate::db::set_setting(
                &conn,
                "local",
                "printer_last_known_brand:192.168.1.19",
                "Star",
            )
            .unwrap();
            conn.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,connection_json,character_set,created_at,updated_at) VALUES('your-test-printer','Front printer','192.168.1.19','escpos','network',?1,'PC737_GREEK','2026-11-01','2026-11-01')",[json!({"ip":"192.168.1.19","emulation":"auto"}).to_string()]).unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .unwrap();
        }
        std::fs::write(db.dir().join("module-cache.json"),json!({"organizationId":"your-test-organization","apiModules":[{"module_id":"orders"}],"apiTimestamp":"2026-11-01T00:00:00Z"}).to_string()).unwrap();
        let log_root = db.dir().join("support-log-fixture");
        std::fs::create_dir_all(&log_root).unwrap();
        std::fs::write(log_root.join("pos.log"), "2026-11-01T00:00:00Z WARN the_small_pos_lib::sync: Parity sync failed: AUTH_LOCKED_OUT customer private@example.invalid your-test-secret\n").unwrap();
        let before = super::super::contracts::sha256(&std::fs::read(db.db_path()).unwrap());
        let gate = super::super::critical_op::CriticalOpGate::new();
        let permit = gate.try_begin_support(false, None).unwrap();
        let conn = replica::read_connection(
            db.db_path(),
            &permit,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
        for kind in [
            "health",
            "settings",
            "shifts",
            "modules",
            "printers",
            "diagnostics",
            "sync_queue",
            "logs",
            "error_codes",
        ] {
            let result = match kind {
                "health" => collectors::health::collect(&conn),
                "settings" => collectors::settings::collect(&conn),
                "shifts" => collectors::shifts::collect(&conn, &permit),
                "modules" => collectors::modules::collect(&conn),
                "printers" => collectors::printers::collect(&conn),
                "logs" => collectors::logs::collect(&log_root, &json!({}), &permit),
                "error_codes" => {
                    collectors::error_codes::collect_from(&log_root, &json!({}), &permit)
                }
                "diagnostics" => {
                    collectors::diagnostics::collect(&conn, &json!({"section":"about"}), &permit)
                }
                _ => collectors::sync_queue::collect(&conn, &permit),
            }
            .unwrap_or_else(|e| panic!("{kind}: {e}"));
            if kind == "printers" {
                let p = &result["printers"][0];
                assert_eq!(p["resolved_brand"], "unknown");
                assert_eq!(p["brand_source"], "unknown_fallback");
                assert_eq!(p["last_known_brand"], "star");
                assert!(p["effective_emulation"].is_null());
                assert!(p["code_page"].is_null());
                assert_eq!(p["layout_status"], "unavailable");
            }
            let result = collectors::meta(result).unwrap();
            assert!(!result.to_string().contains("your-test-secret"), "{kind}");
            assert_eq!(
                before,
                super::super::contracts::sha256(&std::fs::read(db.db_path()).unwrap()),
                "{kind}"
            );
        }
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/support-redaction-vectors.json"
        ))
        .unwrap();
        for kind in KINDS {
            for v in vectors["vectors"].as_array().unwrap() {
                let result =
                    collectors::meta(json!({"collector":kind,"record":v["input"]})).unwrap();
                for absent in v["absent"].as_array().unwrap() {
                    assert!(
                        !result.to_string().contains(absent.as_str().unwrap()),
                        "{kind}: {}",
                        v["id"]
                    );
                }
            }
        }
    }
    #[test]
    fn every_native_tier_one_handler_is_registered_and_business_schema_is_v106() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _test_gate = super::super::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        initialize(db.dir()).unwrap();
        assert_eq!(KINDS.len(), 15);
        assert!(super::super::dispatch::capabilities()
            .iter()
            .any(|s| s == "support.tier1.v1"));
        let tools = installed().lock().unwrap().clone().unwrap();
        let gate = super::super::critical_op::CriticalOpGate::new();
        let permit = gate.try_begin_support(false, None).unwrap();
        let mut command:Command=serde_json::from_value(json!({"command_id":uuid::Uuid::new_v4().to_string(),"session_id":"your-test-session","sequence":1,"kind":"till_health","tier":1,"payload":{"data":{}},"payload_sha256":"your-test-hash","idempotency_key":"your-test-key","call_id":uuid::Uuid::new_v4().to_string(),"created_at":"2026-11-01T00:00:00Z","expires_at":"2026-11-01T00:05:00Z","server_time":"2026-11-01T00:00:00Z","approval":null})).unwrap();
        assert!(tools.run(&command, &permit).is_ok());
        command.kind = "till_sql_schema".into();
        let schema = tools.run(&command, &permit).unwrap();
        assert!(!schema["tables"].as_array().unwrap().is_empty());
        end_session();
        assert!(tools.replicas.lock().unwrap().replica.is_none());
        command.kind = "till_network_scan".into();
        tools
            .audit_network(&command, &json!({"port_groups":["printers"]}))
            .unwrap();
        tools.audit_network_result(&command,&json!({"parameters":{"ports":[9100]},"devices":[{}],"hosts_probed":3,"stopped":null})).unwrap();
        let evidence = rusqlite::Connection::open(db.dir().join("support.db")).unwrap();
        let count:i64=evidence.query_row("SELECT json_extract(parameters_json,'$.native_result.devices') FROM support_network_evidence WHERE command_id=?1",[&command.command_id],|r|r.get(0)).unwrap();
        assert_eq!(count, 1);
        assert!(!include_str!("network/info.rs").contains("storage::"));
        // Support adds exactly one business-schema change: the break-glass
        // commit marker (v106, design 11.3). Everything else lives in support.db.
        // v107 is Health's order-payment index, not support.
        assert_eq!(crate::db::CURRENT_SCHEMA_VERSION, 107);
    }
}

#[cfg(test)]
#[path = "tests/desktop_output_contract_tests.rs"]
mod desktop_output_contract_tests;
