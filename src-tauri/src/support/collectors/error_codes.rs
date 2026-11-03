use super::super::critical_op::SupportPermit;
use super::*;
pub fn collect(input: &Value, permit: &SupportPermit) -> Result<Value, String> {
    collect_from(&crate::diagnostics::get_log_dir(), input, permit)
}
pub(crate) fn collect_from(
    root: &std::path::Path,
    input: &Value,
    permit: &SupportPermit,
) -> Result<Value, String> {
    let logs = super::logs::collect(
        root,
        &json!({"since":input["since"],"max_lines":500}),
        permit,
    )?;
    let mut groups = std::collections::BTreeMap::<String, Value>::new();
    for line in logs["lines"].as_array().ok_or("INTERNAL_ERROR")? {
        if let Some(code) = line["code"]
            .as_str()
            .filter(|c| crate::diagnostics::is_runtime_error_code(c))
        {
            let entry=groups.entry(code.into()).or_insert_with(||json!({"code":code,"count":0,"first_seen_at":line["at"],"last_seen_at":line["at"]}));
            entry["count"] = json!(entry["count"].as_u64().unwrap_or(0) + 1);
            entry["first_seen_at"] = line["at"].clone();
        }
    }
    let limit = input["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
    let omitted = groups.len().saturating_sub(limit);
    Ok(
        json!({"codes":groups.into_values().take(limit).collect::<Vec<_>>(),
        "coverage":{"source":"retained_projected_log_tail","max_lines":500,"since":input["since"],"tail":logs["coverage"],"complete":logs["coverage"]["complete"]==true && omitted==0,"code_groups_omitted":omitted},
        "truncation":logs["truncation"],"redaction_dropped":logs["redaction_dropped"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_counts_expose_tail_coverage_and_truncation() {
        let _gate = crate::support::critical_op::install_test_gate();
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = crate::tests::harness::TestDb::open();
        let root = db.dir().join("code-history-logs");
        std::fs::create_dir_all(&root).unwrap();
        let event = "2026-11-01T00:00:00Z WARN the_small_pos_lib::sync: Parity sync failed: AUTH_LOCKED_OUT\n";
        std::fs::write(root.as_path().join("pos.log"), event.repeat(600)).unwrap();
        let gate = crate::support::critical_op::CriticalOpGate::new();
        let permit = gate.try_begin_support(false, None).unwrap();
        let result = collect_from(root.as_path(), &json!({}), &permit).unwrap();
        assert_eq!(result["codes"][0]["count"], 500);
        assert_eq!(result["codes"][0]["code"], "AUTH_LOCKED_OUT");
        assert_eq!(result["coverage"]["max_lines"], 500);
        assert_eq!(result["coverage"]["complete"], false);
        assert!(!result["truncation"].as_array().unwrap().is_empty());
    }
}
