use crate::support::{collectors, network};
use serde_json::{json, Value};

#[test]
fn modules_refuse_non_string_versions_and_filter_entries() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = crate::tests::harness::TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    crate::db::set_setting(&conn, "terminal", "organization_id", "your-test-org").unwrap();
    let cache = db.dir().join("module-cache.json");
    for version in [json!(12), json!({"raw":"text"}), json!([])] {
        std::fs::write(&cache, json!({"organizationId":"your-test-org","apiModules":[{"id":"orders","version":version}]}).to_string()).unwrap();
        assert_eq!(
            collectors::modules::collect(&conn),
            Err("POLICY_REFUSED".into())
        );
    }
    std::fs::write(&cache, json!({"organizationId":"your-test-org","apiModules":[{"id":"orders","version":null}],"apiTimestamp":"bad"}).to_string()).unwrap();
    for filter in [
        json!(["orders", 12]),
        json!({"raw":"text"}),
        json!("orders"),
    ] {
        crate::db::set_setting(
            &conn,
            "terminal",
            "terminal_settings_snapshot",
            &json!({"enabled_modules":filter}).to_string(),
        )
        .unwrap();
        assert_eq!(
            collectors::modules::collect(&conn),
            Err("POLICY_REFUSED".into())
        );
    }
    crate::db::set_setting(
        &conn,
        "terminal",
        "terminal_settings_snapshot",
        &json!({"enabled_modules":["orders"]}).to_string(),
    )
    .unwrap();
    let value = collectors::modules::collect(&conn).unwrap();
    assert_eq!(value["terminal_filter"], json!(["orders"]));
    assert!(value["last_module_sync_at"].is_null());
}

#[test]
fn adapters_are_capped_and_ordered_by_actual_default_route() {
    let adapter = |id, route| json!({"id":id,"name":"Ethernet","virtual":false,"up":true,"kind":"ethernet","default_route":route,"ipv4":[{"address":"192.168.1.2","prefix":24}],"gateway":"192.168.1.1","dns":[]});
    let rows = vec![
        adapter(20, false),
        adapter(9, true),
        adapter(3, true),
        adapter(1, false),
    ];
    for input in [rows.clone(), rows.into_iter().rev().collect()] {
        let interfaces = network::info::parse(Value::Array(input));
        assert_eq!(
            interfaces
                .iter()
                .map(|i| i.interface_id.as_str())
                .collect::<Vec<_>>(),
            vec!["3", "9"]
        );
    }
}

// Closed structural oracle from the server-validated desktop goldens. The
// explicit overrides below describe unions/dictionaries/empty arrays erased by
// a JSON example; no blanket null or unknown-key escape is allowed.
#[derive(Clone)]
enum Shape {
    Text(usize),
    Iso,
    Number,
    SignedNumber,
    Count,
    Bool,
    Null,
    Any,
    Literal(Value),
    Enum(Vec<Value>),
    Object(std::collections::BTreeMap<String, Shape>, Vec<String>),
    Array(Box<Shape>, usize),
    Dictionary(Box<Shape>),
    Union(Vec<Shape>),
}
use Shape::*;
fn text() -> Shape {
    Text(usize::MAX)
}
fn enumeration(values: &[&str]) -> Shape {
    Enum(values.iter().map(|s| json!(s)).collect())
}
fn nullable(shape: Shape) -> Shape {
    Union(vec![Null, shape])
}
fn object(fields: &[(&str, Shape)]) -> Shape {
    Object(
        fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        vec![],
    )
}
fn wrapper(max: usize) -> Shape {
    object(&[
        ("kind", Literal(json!("untrusted_till_data"))),
        ("value", Text(max)),
    ])
}
fn truncation() -> Shape {
    Array(
        Box::new(object(&[
            ("field", text()),
            (
                "reason",
                enumeration(&["rows", "bytes", "cell", "lines", "results", "deadline"]),
            ),
        ])),
        usize::MAX,
    )
}
fn shape(tool: &str, path: &str, samples: &[&Value]) -> Shape {
    let is = |t, p| tool == t && path == p;
    if path == "observation_time"
        || path.ends_with(".observed_at")
        || matches!(
            path,
            "replica_taken_at"
                | "codes[].first_seen_at"
                | "codes[].last_seen_at"
                | "lines[].at"
                | "open_shifts[].opened_at"
                | "drawer_sessions[].opened_at"
                | "last_z.generated_at"
                | "printers[].recent_jobs[].at"
        )
    {
        return Iso;
    }
    if matches!(
        path,
        "last_observation_at"
            | "last_module_sync_at"
            | "drawer_sessions[].closed_at"
            | "printers[].last_probe.at"
            | "printers[].layout_observed_at"
            | "printers[].last_print_error_at"
            | "items[].next_retry_at"
            | "coverage.since"
            | "coverage.oldest_at"
            | "coverage.newest_at"
            | "coverage.tail.oldest_at"
            | "coverage.tail.newest_at"
    ) {
        return nullable(Iso);
    }
    if path == "truncation" && tool != "till_sql_query" {
        return truncation();
    }
    if is("till_diagnostics_bundle", "content") {
        return Any;
    } // shared contract declares unknown
    if is("till_diagnostics_bundle", "collector_status") {
        return enumeration(&["ok", "partial", "not_collected", "unavailable"]);
    }
    if is("till_health", "health_state") {
        return enumeration(&["healthy", "issues", "stale", "unavailable"]);
    }
    if is("till_health", "issues") {
        return Array(
            Box::new(object(&[
                ("code", text()),
                ("severity", enumeration(&["info", "warning", "critical"])),
                ("area", text()),
                ("recommended_action_id", nullable(text())),
                ("recommended_action", nullable(wrapper(1024))),
                ("observed_at", Iso),
                ("stale", Bool),
            ])),
            usize::MAX,
        );
    }
    if is("till_settings", "credentials") {
        return Dictionary(Box::new(Bool));
    }
    if tool == "till_settings" && ["terminal", "branch", "organization"].contains(&path) {
        return Dictionary(Box::new(Union(vec![
            SignedNumber,
            Bool,
            Null,
            wrapper(1024),
            Literal(json!("[REDACTED]")),
        ])));
    }
    if tool == "till_sync_queue" && ["counts_by_table", "counts_by_module"].contains(&path) {
        return Dictionary(Box::new(Count));
    }
    if is("till_sync_queue", "diagnostics_backlog") {
        return Dictionary(Box::new(Dictionary(Box::new(Count))));
    }
    if is("till_sync_queue", "oldest_item_age_s") {
        return nullable(Count);
    }
    if is("till_sync_queue", "items[].last_error") {
        return nullable(wrapper(1024));
    }
    if is("till_sync_queue", "items[].module") {
        return nullable(text());
    }
    if is("till_sync_queue", "items[].operation") {
        return enumeration(&["insert", "update", "delete"]);
    }
    if is("till_sync_queue", "items[].status") {
        return enumeration(&["pending", "processing", "failed", "conflict", "set_aside"]);
    }
    if is("till_sync_queue", "items[].payload") || path == "open_shifts[].staff" {
        return Literal(json!("redacted"));
    }
    if is("till_modules", "enabled_modules[].version") {
        return nullable(text());
    }
    if is("till_modules", "terminal_filter") {
        return nullable(Array(Box::new(text()), usize::MAX));
    }
    if is("till_modules", "source") {
        return enumeration(&["server", "cache"]);
    }
    if is("till_shifts", "last_z") {
        return nullable(object(&[
            ("z_id", text()),
            ("report_date", text()),
            ("generated_at", Iso),
            ("sync_state", text()),
        ]));
    }
    if is("till_shifts", "closeout_readiness.status") {
        return enumeration(&["ok", "unavailable"]);
    }
    if is("till_shifts", "closeout_readiness.blockers[].detail") {
        return nullable(wrapper(1024));
    }
    if is("till_printers", "printers[].connection_type") {
        return enumeration(&["network", "usb", "bluetooth", "system", "serial"]);
    }
    if is("till_printers", "printers[].configured_emulation") {
        return enumeration(&["auto", "escpos", "star_line"]);
    }
    if is("till_printers", "printers[].brand_source") {
        return enumeration(&["name", "web_probe", "last_known", "unknown_fallback"]);
    }
    if tool == "till_printers"
        && [
            "printers[].effective_emulation",
            "printers[].recent_jobs[].emulation_used",
        ]
        .contains(&path)
    {
        return nullable(enumeration(&["escpos", "star_line"]));
    }
    if is(
        "till_printers",
        "printers[].effective_layout.effective_emulation",
    ) {
        return enumeration(&["escpos", "star_line"]);
    }
    if tool == "till_printers"
        && [
            "printers[].code_page",
            "printers[].effective_layout.code_page",
            "printers[].recent_jobs[].bytes",
        ]
        .contains(&path)
    {
        return nullable(Count);
    }
    if tool == "till_printers"
        && ["printers[].address", "printers[].last_known_brand"].contains(&path)
    {
        return nullable(text());
    }
    if tool == "till_printers"
        && [
            "printers[].last_probe.detail",
            "printers[].last_print_error",
        ]
        .contains(&path)
    {
        return nullable(wrapper(1024));
    }
    if is("till_printers", "printers[].last_probe.result") {
        return enumeration(&[
            "answered",
            "no_answer",
            "error",
            "not_applicable",
            "unavailable",
        ]);
    }
    if is("till_printers", "printers[].layout_status") {
        return enumeration(&["cached", "unavailable"]);
    }
    if is("till_printers", "printers[].recent_jobs_status") {
        return enumeration(&["ok", "unavailable"]);
    }
    if is("till_printers", "printers[].recent_jobs[].outcome") {
        return enumeration(&["printed", "failed", "pending"]);
    }
    if is("till_printers", "printers[].effective_layout") {
        let nonnull = samples
            .iter()
            .filter(|v| !v.is_null())
            .copied()
            .collect::<Vec<_>>();
        return nullable(infer(tool, path, &nonnull));
    }
    if is("till_network_info", "network_name") {
        return Literal(json!("not_collected"));
    }
    if is("till_network_info", "interfaces[].kind") {
        return enumeration(&["ethernet", "wifi", "other"]);
    }
    if is("till_network_info", "interfaces[].dns") {
        return Array(Box::new(text()), usize::MAX);
    }
    if is("till_network_info", "interfaces[].gateway") {
        return nullable(text());
    }
    if is("till_network_info", "support_server.rtt_ms") {
        return nullable(Number);
    }
    if is("till_network_scan", "stopped") {
        return nullable(enumeration(&[
            "deadline",
            "result_cap",
            "critical_operation",
        ]));
    }
    if is("till_network_scan", "interfaces_note") {
        return nullable(text());
    }
    if is("till_network_scan", "devices[].protocol_guess") {
        return enumeration(&[
            "raw_9100", "lpd", "ipp", "zvt", "pax", "rbs_elio", "mat_ecr", "http", "unknown",
        ]);
    }
    if is("till_network_scan", "devices[].mdns_name") {
        return nullable(wrapper(64));
    }
    if tool == "till_network_scan"
        && ["devices[].mdns_service", "devices[].mac_vendor"].contains(&path)
    {
        return nullable(Text(64));
    }
    if is("till_network_scan", "devices[].matches_configured_device") {
        return nullable(object(&[
            (
                "device_kind",
                enumeration(&["printer", "card_terminal", "cash_register"]),
            ),
            ("device_id", text()),
        ]));
    }
    if tool == "till_network_scan"
        && ["parameters.ports[]", "devices[].open_ports[]"].contains(&path)
    {
        return Enum(
            [9100, 515, 631, 20007, 10009, 9101, 80]
                .iter()
                .map(|p| json!(p))
                .collect(),
        );
    }
    if tool == "till_network_scan"
        && [
            "parameters.per_host_timeout_ms",
            "parameters.concurrency",
            "parameters.deadline_ms",
            "parameters.result_cap",
            "parameters.port_allowlist_version",
        ]
        .contains(&path)
    {
        return Literal((*samples[0]).clone());
    }
    if is("till_network_identify", "probe") {
        return enumeration(&[
            "printer_web_brand",
            "cap_mat_ecr_head",
            "pax_a00",
            "datecs_status",
            "zvt_status_enquiry",
        ]);
    }
    if is("till_network_identify", "probe_status") {
        return enumeration(&["ok", "no_answer", "timeout", "unsupported_on_platform"]);
    }
    if is("till_network_identify", "device_kind_guess") {
        return enumeration(&["printer", "card_terminal", "cash_register", "unknown"]);
    }
    if tool == "till_network_identify" && ["brand", "model", "firmware", "serial"].contains(&path) {
        return nullable(wrapper(64));
    }
    if is("till_network_identify", "protocol_guess") {
        return nullable(Text(64));
    }
    if is("till_network_identify", "response_ms") {
        return nullable(Number);
    }
    if is("till_logs", "lines[].level") {
        return enumeration(&["debug", "info", "warn", "error"]);
    }
    if is("till_logs", "lines[].code") {
        return nullable(text());
    }
    if path.ends_with(".source")
        && samples
            .first()
            .is_some_and(|v| **v == json!("retained_projected_log_tail"))
    {
        return Literal(json!("retained_projected_log_tail"));
    }
    if path.ends_with(".max_files")
        || path.ends_with(".max_bytes_per_file")
        || path.ends_with(".max_lines")
    {
        return Literal((*samples[0]).clone());
    }
    if matches!(path, "database" | "databases[]") {
        return enumeration(&["main", "printers"]);
    }
    if is("till_sql_schema", "tables[].columns[].classification") {
        return enumeration(&["safe", "pii", "free_text", "secret"]);
    }
    if is("till_sql_query", "rows[][]") {
        return Union(vec![SignedNumber, Null, wrapper(1024)]);
    }
    if path.ends_with(".kind")
        && samples
            .first()
            .is_some_and(|v| **v == json!("untrusted_till_data"))
    {
        return Literal(json!("untrusted_till_data"));
    }
    if path.ends_with(".value") {
        return Text(1024);
    }
    if matches!(
        path,
        "elapsed_ms"
            | "build_ms"
            | "devices[].rtt_ms"
            | "printers[].paper_width_mm"
            | "printers[].effective_layout.paper_width_mm"
    ) {
        return Number;
    }
    infer(tool, path, samples)
}
fn infer(tool: &str, path: &str, samples: &[&Value]) -> Shape {
    let first = samples
        .iter()
        .find(|v| !v.is_null())
        .unwrap_or_else(|| panic!("missing explicit nullable/empty-array contract: {tool}/{path}"));
    match first {
        Value::Object(fields) => {
            let mut props = std::collections::BTreeMap::new();
            for key in fields.keys() {
                let child = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                let values = samples
                    .iter()
                    .filter_map(|v| v.get(key))
                    .collect::<Vec<_>>();
                props.insert(key.clone(), shape(tool, &child, &values));
            }
            let mut optional = vec![];
            if tool == "till_diagnostics_bundle" && path.is_empty() {
                props.insert("last_observation_at".into(), nullable(Iso));
                optional.push("last_observation_at".into());
            }
            Object(props, optional)
        }
        Value::Array(_) => {
            let values = samples
                .iter()
                .flat_map(|v| v.as_array().unwrap().iter())
                .collect::<Vec<_>>();
            let max = match (tool, path) {
                ("till_printers", "printers[].recent_jobs") => 20,
                ("till_sync_queue", "items") => 50,
                ("till_logs", "lines") => 500,
                ("till_error_codes", "codes") => 100,
                ("till_sql_query", "rows") => 200,
                ("till_network_info", "interfaces")
                | ("till_network_scan", "parameters.interfaces" | "parameters.subnets") => 2,
                ("till_network_scan", "devices") => 100,
                _ => usize::MAX,
            };
            Array(Box::new(shape(tool, &format!("{path}[]"), &values)), max)
        }
        Value::String(_) => text(),
        Value::Number(_) => Count,
        Value::Bool(_) => Bool,
        _ => panic!("undeclared shape {tool}/{path}"),
    }
}
fn validate(schema: &Shape, value: &Value, path: &str) -> Result<(), String> {
    let valid = match schema {
        Text(max) => value.as_str().is_some_and(|s| s.chars().count() <= *max),
        Iso => value
            .as_str()
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()),
        Number => value.as_f64().is_some_and(|n| n >= 0.0),
        SignedNumber => value.is_number(),
        Count => value.as_u64().is_some(),
        Bool => value.is_boolean(),
        Null => value.is_null(),
        Any => true,
        Literal(v) => v == value,
        Enum(v) => v.contains(value),
        Union(shapes) => shapes.iter().any(|s| validate(s, value, path).is_ok()),
        Object(props, optional) => {
            let map = value
                .as_object()
                .ok_or_else(|| format!("{path}: expected object"))?;
            for key in map.keys() {
                if !props.contains_key(key) {
                    return Err(format!("{path}.{key}: undeclared key"));
                }
            }
            for (key, schema) in props {
                if let Some(v) = map.get(key) {
                    validate(schema, v, &format!("{path}.{key}"))?;
                } else if !optional.contains(key) {
                    return Err(format!("{path}.{key}: missing key"));
                }
            }
            true
        }
        Array(item, max) => {
            let a = value
                .as_array()
                .ok_or_else(|| format!("{path}: expected array"))?;
            if a.len() > *max {
                return Err(format!("{path}: array cap exceeded"));
            }
            for (i, v) in a.iter().enumerate() {
                validate(item, v, &format!("{path}[{i}]"))?;
            }
            true
        }
        Dictionary(item) => {
            let a = value
                .as_object()
                .ok_or_else(|| format!("{path}: expected dictionary"))?;
            for (k, v) in a {
                validate(item, v, &format!("{path}.{k}"))?;
            }
            true
        }
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "{path}: invalid type, enum, nullability or bound: {value}"
        ))
    }
}
fn golden(tool: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../shared/pos/support/__fixtures__/tool-outputs/{tool}.desktop.json"
            )),
        )
        .unwrap(),
    )
    .unwrap()
}
fn conforms(tool: &str, value: &Value) {
    let serialized = value.to_string().to_lowercase();
    for private in crate::support::tests::collector_privacy_scan_tests::PRIVATE {
        assert!(
            !serialized.contains(&private.to_lowercase()),
            "{tool}: private fixture value escaped"
        );
    }
    let fixture = golden(tool);
    let schema = shape(tool, "", &[&fixture]);
    validate(&schema, &fixture, tool).unwrap();
    validate(&schema, value, tool).unwrap();
    let mut hostile = value.clone();
    hostile.as_object_mut().unwrap().insert(
        "undeclared_raw_passthrough".into(),
        json!({"staff":"your-private-value"}),
    );
    assert!(validate(&schema, &hostile, tool).is_err());
}

#[test]
fn all_desktop_tier_one_real_collectors_conform_to_closed_goldens() {
    use crate::support::{critical_op, replica};
    use std::time::{Duration, Instant};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    crate::support::tests::collector_privacy_scan_tests::seed(&db);
    let before = std::fs::read(db.db_path()).unwrap();
    let gate = critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for (name, value) in crate::support::tests::collector_privacy_scan_tests::outputs(&db, &permit)
    {
        let tool = name.split('/').next().unwrap();
        if ["till_network_identify", "till_network_info"].contains(&tool) {
            continue;
        } // injected handlers below
        conforms(tool, &value);
        seen.insert(tool.to_string());
    }
    let input = json!({"ip":"192.168.1.2","port":10009});
    let mut reply = b"\x02000000\x1c1.0\x1cyour-device-serial\x03".to_vec();
    reply.push(reply[1..].iter().fold(0, |a, b| a ^ b));
    for bytes in [vec![], reply] {
        let result = network::identify::identify_with(
            &input,
            &mut network::DiscoveryState::default(),
            &[("192.168.1.2".into(), 10009)],
            &permit,
            |_, _, _, _, _, _| {
                Ok(network::identify::ProbeReply {
                    reachable: !bytes.is_empty(),
                    response_ms: Some(2),
                    timed_out: false,
                    bytes,
                })
            },
        )
        .unwrap();
        conforms("till_network_identify", &collectors::meta(result).unwrap());
    }
    seen.insert("till_network_identify".into());
    let adapters = network::info::parse(
        json!([{"id":3,"name":"Ethernet","virtual":false,"up":true,"kind":"ethernet","ipv4":[{"address":"192.168.1.1","prefix":30}],"gateway":"192.168.1.2","dns":[]}]),
    );
    let info = network::info::collect_with(&permit, || Ok(adapters), || None).unwrap();
    conforms("till_network_info", &collectors::meta(info).unwrap());
    seen.insert("till_network_info".into());
    assert_eq!(
        seen,
        crate::support::tools::KINDS
            .iter()
            .map(|s| s.to_string())
            .collect()
    );
    let tools = super::Tools {
        live: db.db_path().into(),
        replicas: Default::default(),
        network: Default::default(),
    };
    for (kind, data) in [
        ("till_sql_refresh_replica", json!({"database":"main"})),
        ("till_sql_schema", json!({"database":"main"})),
        (
            "till_sql_query",
            json!({"database":"main","sql":"SELECT customer_name,staff_id,-10.5,NULL FROM orders"}),
        ),
    ] {
        let command=serde_json::from_value(json!({"command_id":"your-command","session_id":"your-session","sequence":1,"kind":kind,"tier":1,"payload":data,"payload_sha256":"your-hash","idempotency_key":"your-key","call_id":"your-call","created_at":"2026-11-01T00:00:00Z","expires_at":"2026-11-01T00:01:00Z","server_time":"2026-11-01T00:00:00Z","approval":null})).unwrap();
        let value = tools.run(&command, &permit).unwrap();
        conforms(kind, &value);
        if kind == "till_sql_schema" {
            assert!(value["tables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["emptied_as_secret"] == true && t["row_count"] == 0));
        }
        if kind == "till_sql_query" {
            assert!(value.to_string().len() <= 256 * 1024);
            assert_eq!(value["rows"][0][0]["value"], "[REDACTED]");
            assert_eq!(value["rows"][0][1]["value"], "[REDACTED]");
        }
    }
    let read = replica::read_connection(
        db.db_path(),
        &permit,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    assert!(read.is_readonly(rusqlite::DatabaseName::Main).unwrap());
    assert_eq!(before, std::fs::read(db.db_path()).unwrap());
}

#[test]
fn conformance_oracle_rejects_nested_passthrough_wrong_types_and_enums() {
    for (tool, path, invalid) in [
        (
            "till_printers",
            "/printers/0/last_probe/result",
            json!("healthy"),
        ),
        ("till_printers", "/printers/0/name", json!("raw prose")),
        ("till_shifts", "/open_shifts/0/staff", json!("your-staff")),
        ("till_modules", "/enabled_modules/0/version", json!(1)),
        ("till_network_identify", "/brand", json!("raw brand")),
        ("till_health", "/app_version", Value::Null),
    ] {
        let fixture = golden(tool);
        let schema = shape(tool, "", &[&fixture]);
        let mut invalid_value = fixture.clone();
        *invalid_value.pointer_mut(path).unwrap() = invalid;
        assert!(
            validate(&schema, &invalid_value, tool).is_err(),
            "{tool}/{path}"
        );
    }
    let fixture = golden("till_printers");
    let schema = shape("till_printers", "", &[&fixture]);
    for path in [
        "/printers/0",
        "/printers/0/name",
        "/printers/0/last_probe",
        "/printers/1/effective_layout",
        "/printers/1/recent_jobs/0",
    ] {
        let mut hostile = fixture.clone();
        hostile
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("raw_passthrough".into(), json!("your-prose"));
        assert!(validate(&schema, &hostile, path).is_err());
    }
}

#[test]
fn logs_queue_and_printer_caps_conform_with_nonempty_evidence() {
    use crate::support::{critical_op, replica};
    use std::time::{Duration, Instant};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    crate::support::tests::collector_privacy_scan_tests::seed(&db);
    {
        let c = db.state.conn.lock().unwrap();
        for i in 0..55 {
            c.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,status,module_type) VALUES(?1,'orders','your-order','INSERT','{}','your-test-org',?2,'orders')",rusqlite::params![format!("your-queue-{i}"),["pending","processing","failed","conflict"][i%4]]).unwrap();
            c.execute("INSERT INTO print_jobs(id,entity_type,entity_id,printer_profile_id,status,created_at,updated_at) VALUES(?1,'order_receipt','your-order','your-test-printer','pending','2026-11-01 09:00:00','2026-11-01 09:00:00')",[format!("your-job-{i}")]).unwrap();
        }
        c.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,created_at,updated_at) VALUES('your-no-history','Front printer','your-no-history','escpos','network','2026-11-01','2026-11-01')",[]).unwrap();
        c.execute("INSERT INTO parity_sync_set_aside(queue_id,table_name,record_id,reason_code,set_aside_by_staff_id,set_aside_at,organization_id) VALUES('your-queue-0','orders','your-order','your-reason','your-staff','2026-11-01T00:00:00Z','your-test-org')",[]).unwrap();
        c.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,connection_json,character_set,greek_render_mode,created_at,updated_at) VALUES('your-observed','Front printer','your-observed','escpos','network',?1,'PC737_GREEK','text','2026-11-01','2026-11-01')",[json!({"ip":"192.168.1.19","emulation":"auto"}).to_string()]).unwrap();
        crate::db::set_setting(&c, "local", "printer_last_known_brand:192.168.1.19", "Star")
            .unwrap();
        c.execute("INSERT INTO print_jobs(id,entity_type,entity_id,printer_profile_id,status,render_profile_snapshot_json,created_at,updated_at) VALUES('your-observed-job','order_receipt','your-order','your-observed','failed',?1,'2026-11-01 09:00:00','2026-11-01 09:00:00')",[json!({"emulation":"escpos"}).to_string()]).unwrap();
        c.execute("INSERT INTO print_job_attempts(id,print_job_id,attempt_number,transport,resolved_target,document_name,state,bytes_requested,started_at) VALUES('your-attempt','your-observed-job',1,'raw_tcp','your-target','your-document','transport_error',512,'2026-11-01T09:00:00Z')",[]).unwrap();
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    }
    let layout = crate::receipt_renderer::LayoutConfig {
        character_set: "PC737_GREEK".into(),
        greek_render_mode: Some("text".into()),
        escpos_code_page: Some(14),
        ..Default::default()
    };
    crate::print::retain_support_layout_fixture(&db.state, &json!({"id":"your-observed"}), &layout);
    let retained_before = crate::print::support_effective_layout(db.db_path(), "your-observed");
    let probe_before = crate::printers::support_last_probe("192.168.1.19");
    let logs = db.dir().join("support-log-fixture");
    let line="2026-11-01T00:00:00Z WARN the_small_pos_lib::sync: Parity sync failed: AUTH_LOCKED_OUT your-prose\n";
    std::fs::write(logs.join("pos.log"), line.repeat(600)).unwrap();
    for i in 1..4 {
        std::fs::write(logs.join(format!("pos.log.{i}")), line.repeat(1500)).unwrap();
    }
    let before = std::fs::read(db.db_path()).unwrap();
    let gate = critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let read = replica::read_connection(
        db.db_path(),
        &permit,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    let logs_value = collectors::logs::collect(&logs, &json!({"max_lines":500}), &permit).unwrap();
    assert_eq!(logs_value["lines"].as_array().unwrap().len(), 500);
    assert_eq!(logs_value["coverage"]["complete"], false);
    assert_eq!(logs_value["coverage"]["files_omitted"], true);
    assert!(
        logs_value["coverage"]["file_bytes_skipped"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(
        logs_value["coverage"]["oldest_at"],
        logs_value["lines"][499]["at"]
    );
    assert_eq!(
        logs_value["coverage"]["newest_at"],
        logs_value["lines"][0]["at"]
    );
    conforms("till_logs", &collectors::meta(logs_value).unwrap());
    conforms(
        "till_error_codes",
        &collectors::meta(
            collectors::error_codes::collect_from(&logs, &json!({}), &permit).unwrap(),
        )
        .unwrap(),
    );
    let queue = collectors::sync_queue::collect(&read, &permit).unwrap();
    assert_eq!(queue["items"].as_array().unwrap().len(), 50);
    assert_eq!(
        queue["truncation"],
        json!([{"field":"items","reason":"rows"}])
    );
    for status in ["pending", "processing", "failed", "conflict", "set_aside"] {
        assert!(queue["counts_by_status"][status].as_u64().unwrap() > 0);
    }
    conforms("till_sync_queue", &collectors::meta(queue).unwrap());
    let printers = collectors::printers::collect(&read).unwrap();
    for p in printers["printers"].as_array().unwrap() {
        assert!(p["recent_jobs"].as_array().unwrap().len() <= 20);
    }
    let no_history = printers["printers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["printer_id"] == "your-no-history")
        .unwrap();
    assert_eq!(no_history["recent_jobs_status"], "unavailable");
    let observed = printers["printers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["printer_id"] == "your-observed")
        .unwrap();
    assert_eq!(observed["effective_emulation"], "escpos");
    assert_eq!(observed["recent_jobs"][0]["bytes"], 512);
    assert_eq!(observed["recent_jobs"][0]["emulation_used"], "escpos");
    assert_eq!(observed["last_known_brand"], "star");
    conforms("till_printers", &collectors::meta(printers).unwrap());
    assert_eq!(
        retained_before,
        crate::print::support_effective_layout(db.db_path(), "your-observed")
    );
    assert_eq!(
        probe_before,
        crate::printers::support_last_probe("192.168.1.19")
    );
    assert_eq!(before, std::fs::read(db.db_path()).unwrap());
}

#[test]
fn injected_network_handlers_keep_policy_and_nonempty_output_contracts() {
    use crate::support::critical_op::{CriticalKind, CriticalOpGate, SupportPermit};
    use std::{net::Ipv4Addr, sync::Arc, time::Instant};
    struct Open;
    impl network::scan::Connector for Open {
        fn probe(
            &self,
            _: Ipv4Addr,
            _: u16,
            _: Instant,
            _: &SupportPermit,
        ) -> network::scan::Reply {
            network::scan::Reply {
                open: true,
                mat_ecr: false,
            }
        }
    }
    let gate = Arc::new(CriticalOpGate::new());
    let permit = gate.try_begin_support(false, None).unwrap();
    let adapters = network::info::parse(
        json!([{"id":3,"name":"Ethernet","virtual":false,"up":true,"kind":"ethernet","ipv4":[{"address":"192.168.1.1","prefix":30}],"gateway":"192.168.1.2","dns":[]}]),
    );
    let scan = network::scan::sweep(
        &json!({"port_groups":["printers"],"include_mdns":false}),
        &adapters,
        &mut network::DiscoveryState::default(),
        &permit,
        &Open,
    )
    .unwrap();
    assert!(!scan["devices"].as_array().unwrap().is_empty());
    assert_eq!(scan["stopped"], Value::Null);
    assert_eq!(scan["parameters"]["include_mdns"], false);
    conforms("till_network_scan", &collectors::meta(scan).unwrap());
    let input = json!({"ip":"192.168.1.2","port":80,"probe":"cap_mat_ecr_head"});
    assert_eq!(
        network::identify::identify_with(
            &input,
            &mut network::DiscoveryState::default(),
            &[],
            &permit,
            |_, _, _, _, _, _| panic!("refused before transport")
        ),
        Err("POLICY_REFUSED".into())
    );
    let mut limited = network::DiscoveryState::default();
    limited.probes = vec![Instant::now(); 10];
    assert_eq!(
        network::identify::identify_with(
            &input,
            &mut limited,
            &[("192.168.1.2".into(), 80)],
            &permit,
            |_, _, _, _, _, _| panic!("rate limited before transport")
        ),
        Err("RATE_LIMITED".into())
    );
    let _sale = gate.begin_critical(CriticalKind::Checkout);
    assert_eq!(
        network::identify::identify_with(
            &input,
            &mut network::DiscoveryState::default(),
            &[("192.168.1.2".into(), 80)],
            &permit,
            |_, _, _, _, _, _| panic!("cancelled before transport")
        ),
        Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
    );
}
