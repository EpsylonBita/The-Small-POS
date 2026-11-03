use super::*;

/// Lock-free producer for catalogue references, using the resolver's exact
/// full-configuration fingerprint/revision rule. Disabled profiles are absent.
pub fn configured_printer_refs(
    conn: &Connection,
) -> Result<Vec<super::super::catalogue::contract::ConfiguredPrinterRef>, String> {
    let scope = super::super::identity::local(conn)?;
    let mut stmt = conn
        .prepare("SELECT id FROM printer_profiles WHERE enabled=1 ORDER BY id LIMIT 50")
        .map_err(replica::sql_error)?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(replica::sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(replica::sql_error)?;
    ids.into_iter()
        .map(|id| super::super::catalogue::configured_printer_ref(conn, &scope, &id))
        .collect()
}
pub fn collect(conn: &Connection) -> Result<Value, String> {
    let profiles=rows(conn,"SELECT id,name,printer_name,driver_type,printer_type,role,enabled,character_set,greek_render_mode,paper_width_mm,escpos_code_page,connection_json FROM printer_profiles ORDER BY id LIMIT 50")?;
    let mut printers = Vec::new();
    let references = configured_printer_refs(conn).unwrap_or_default();
    for p in profiles {
        let connection = p["connection_json"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(json!({}));
        let host = connection["ip"]
            .as_str()
            .or_else(|| connection["host"].as_str())
            .or_else(|| connection["hostname"].as_str());
        let named = [
            p["printer_name"].as_str(),
            p["name"].as_str(),
            connection["systemName"].as_str(),
        ]
        .into_iter()
        .flatten()
        .map(crate::printers::detect_printer_brand)
        .find(|b| *b != crate::printers::PrinterBrand::Unknown)
        .unwrap_or(crate::printers::PrinterBrand::Unknown);
        // Never run a new printer probe from a collector. No print-state or
        // last-known-brand cache is updated by remote observation.
        let probe = host
            .map(crate::printers::support_last_probe)
            .unwrap_or_else(|| json!({"status":"unavailable","at":null,"content":null}));
        let observed_brand = probe["content"]["brand"].as_str();
        let brand = observed_brand
            .unwrap_or_else(|| named.label())
            .to_ascii_lowercase();
        let unknown = brand == "unknown";
        let last = host
            .and_then(|host| setting(conn, "local", &format!("printer_last_known_brand:{host}")));
        let last = last
            .and_then(|s| crate::printers::PrinterBrand::from_label(&s))
            .map(|b| b.label().to_ascii_lowercase());
        let configured = match connection["emulation"].as_str() {
            Some("escpos") => "escpos",
            Some("star_line") => "star_line",
            _ => "auto",
        };
        let id = p["id"].as_str().ok_or("INTERNAL_ERROR")?;
        let layout = crate::print::support_effective_layout(
            std::path::Path::new(conn.path().unwrap_or("")),
            id,
        );
        let effective = layout["content"]["effective_emulation"].clone();
        let code_page = layout["content"]["code_page"].clone();
        let address = host
            .and_then(|h| h.parse::<std::net::Ipv4Addr>().ok())
            .zip(
                connection["port"]
                    .as_u64()
                    .unwrap_or(9100)
                    .try_into()
                    .ok()
                    .map(|p: u16| p),
            )
            .map(|(ip, port)| format!("{ip}:{port}"));
        let mut jobs = crate::print_history::support_history_observation(conn, id);
        if let Some(rows) = jobs["jobs"].as_array_mut() {
            rows.retain_mut(|row| {
                let Some(at) = timestamp(&row["at"]) else {
                    return false;
                };
                row["at"] = json!(at);
                true
            });
        }
        let depth:i64=conn.query_row("SELECT count(*) FROM print_jobs WHERE printer_profile_id=?1 AND status IN ('pending','printing')",[id],|r|r.get(0)).map_err(replica::sql_error)?;
        let error=conn.query_row("SELECT last_error,updated_at FROM print_jobs WHERE printer_profile_id=?1 AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).ok();
        let transport = match p["printer_type"].as_str().unwrap_or("system") {
            "wifi" | "network" => "network",
            "usb" => "usb",
            "serial" => "serial",
            "bluetooth" => "bluetooth",
            _ => "system",
        };
        printers.push(json!({"printer_id":id,"name":redaction::text(p["name"].as_str().unwrap_or("")),"role":p["role"],"enabled":p["enabled"]==1,"connection_type":transport,"address":address,"configured_driver":p["driver_type"],"configured_emulation":configured,"resolved_brand":brand,"brand_source":if unknown{"unknown_fallback"}else if observed_brand.is_some(){"web_probe"}else{"name"},"last_known_brand":last,"effective_emulation":effective,"code_page":code_page,"character_set":p["character_set"],"greek_render_mode":p["greek_render_mode"],"paper_width_mm":p["paper_width_mm"],"last_probe":{"result":probe["content"]["result"].as_str().unwrap_or("unavailable"),"detail":null,"at":timestamp(&probe["at"])},"layout_status":if layout["content"].is_null(){"unavailable"}else{"cached"},"layout_observed_at":timestamp(&layout["at"]),"effective_layout":layout["content"],"last_print_error":error.as_ref().map(|_|redaction::text(redaction::MARKER)),"last_print_error_at":error.and_then(|e|timestamp(&json!(e.1))),"queue_depth":depth,"recent_jobs":jobs["jobs"],"recent_jobs_status":jobs["status"]}));
        if let Some(reference) = references.iter().find(|reference| reference.id == id) {
            if let Some(printer) = printers.last_mut() {
                printer["configured_printer_ref"] =
                    serde_json::to_value(reference).map_err(|_| "INTERNAL_ERROR")?;
            }
        }
    }
    Ok(json!({"printers":printers}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_refs_match_resolver_and_never_take_business_lock_or_read_keyring() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        let writer = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "your-org"),
            ("branch_id", "your-branch"),
            ("terminal_id", "your-terminal"),
        ] {
            crate::db::set_setting(&writer, "terminal", key, value).unwrap();
        }
        writer.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','your-printer','your-printer','escpos','2026-11-02T12:00:00Z','2026-11-02T12:00:00Z')",[]).unwrap();
        crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
        let permit = crate::support::critical_op::global()
            .try_begin_support(false, None)
            .unwrap();
        let read = crate::support::replica::read_connection(
            db.db_path(),
            &permit,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
        let scope = crate::support::identity::local(&read).unwrap();
        let refs = configured_printer_refs(&read).unwrap();
        let wire = collect(&read).unwrap();
        assert_eq!(
            wire["printers"][0]["configured_printer_ref"],
            serde_json::to_value(&refs[0]).unwrap()
        );
        assert_eq!(refs.len(), 1);
        assert!(refs[0].configuration_revision < (1_u64 << 52));
        crate::support::catalogue::resolve_printer(&read, &scope, &refs[0]).unwrap();
        writer
            .execute("UPDATE printer_profiles SET driver_type='windows'", [])
            .unwrap();
        assert!(crate::support::catalogue::resolve_printer(&read, &scope, &refs[0]).is_err());
        assert_ne!(
            configured_printer_refs(&read).unwrap()[0].configuration_revision,
            refs[0].configuration_revision
        );
        writer
            .execute("UPDATE printer_profiles SET enabled=0", [])
            .unwrap();
        assert!(configured_printer_refs(&read).unwrap().is_empty());
    }
}
