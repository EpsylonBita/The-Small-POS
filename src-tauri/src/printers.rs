//! Printer profile management and Windows printing for The Small POS.
//!
//! Provides CRUD operations for printer profiles stored in SQLite, enumerates
//! installed Windows printers via the `winspool` API, and dispatches print
//! jobs to the Windows print spooler.
//!
//! ESC/POS and cash-drawer commands are deferred to a future phase.

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};

// ---------------------------------------------------------------------------
// Windows printer enumeration (compile-time gated)
// ---------------------------------------------------------------------------

/// List the names of printers installed on this Windows system.
///
/// Uses the `winspool.drv` `EnumPrintersW` API (level 2).  Falls back to an
/// empty list if the call fails or if compiled on a non-Windows target.
#[cfg(target_os = "windows")]
pub fn list_system_printers() -> Vec<String> {
    use std::ptr;

    // Win32 constants
    const PRINTER_ENUM_LOCAL: u32 = 0x00000002;
    const PRINTER_ENUM_CONNECTIONS: u32 = 0x00000004;

    #[repr(C)]
    #[allow(non_snake_case, non_camel_case_types)]
    struct PRINTER_INFO_2W {
        pServerName: *mut u16,
        pPrinterName: *mut u16,
        pShareName: *mut u16,
        pPortName: *mut u16,
        pDriverName: *mut u16,
        pComment: *mut u16,
        pLocation: *mut u16,
        pDevMode: *mut u8,
        pSepFile: *mut u16,
        pPrintProcessor: *mut u16,
        pDatatype: *mut u16,
        pParameters: *mut u16,
        pSecurityDescriptor: *mut u8,
        Attributes: u32,
        Priority: u32,
        DefaultPriority: u32,
        StartTime: u32,
        UntilTime: u32,
        Status: u32,
        cJobs: u32,
        AveragePPM: u32,
    }

    #[link(name = "winspool")]
    extern "system" {
        fn EnumPrintersW(
            Flags: u32,
            Name: *mut u16,
            Level: u32,
            pPrinterEnum: *mut u8,
            cbBuf: u32,
            pcbNeeded: *mut u32,
            pcReturned: *mut u32,
        ) -> i32;
    }

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;

    // First call: determine buffer size
    unsafe {
        EnumPrintersW(
            flags,
            ptr::null_mut(),
            2,
            ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        );
    }

    if needed == 0 {
        warn!("EnumPrintersW returned 0 bytes needed — no printers found");
        return Vec::new();
    }

    let mut buffer: Vec<u8> = vec![0u8; needed as usize];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            ptr::null_mut(),
            2,
            buffer.as_mut_ptr(),
            needed,
            &mut needed,
            &mut returned,
        )
    };

    if ok == 0 {
        error!("EnumPrintersW failed on second call");
        return Vec::new();
    }

    let infos = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_2W, returned as usize)
    };

    let mut names = Vec::with_capacity(returned as usize);
    for info in infos {
        if info.pPrinterName.is_null() {
            continue;
        }
        let name = unsafe {
            let len = (0..)
                .take_while(|&i| *info.pPrinterName.add(i) != 0)
                .count();
            String::from_utf16_lossy(std::slice::from_raw_parts(info.pPrinterName, len))
        };
        names.push(name);
    }

    info!(count = names.len(), "Enumerated Windows printers");
    names
}

#[cfg(not(target_os = "windows"))]
pub fn list_system_printers() -> Vec<String> {
    warn!("list_system_printers called on non-Windows platform — returning empty");
    Vec::new()
}

// ---------------------------------------------------------------------------
// Print to Windows spooler
// ---------------------------------------------------------------------------

/// Send an HTML file to a Windows printer by spawning a headless print via
/// `rundll32 mshtml.dll,PrintHTML`.
///
/// This is the simplest approach that works without external deps.
/// Returns Ok(()) on successful dispatch or Err with a descriptive message.
#[cfg(target_os = "windows")]
pub fn print_to_windows(printer_name: &str, html_path: &str) -> Result<(), String> {
    use std::process::Command;

    // Validate the file exists
    if !std::path::Path::new(html_path).exists() {
        return Err(format!("Receipt file not found: {html_path}"));
    }

    // Use PowerShell to print HTML via the default browser's print capability
    // This approach sends to a specific printer reliably
    let ps_script = format!(
        r#"
        $printer = "{}"
        $file = "{}"
        Start-Process -FilePath $file -Verb PrintTo -ArgumentList $printer -WindowStyle Hidden -Wait
        "#,
        printer_name.replace('"', "`\""),
        html_path.replace('"', "`\"").replace('/', "\\"),
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("Failed to spawn print process: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Print command failed: {stderr}"));
    }

    info!(printer = %printer_name, file = %html_path, "Sent to Windows print spooler");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn print_to_windows(_printer_name: &str, _html_path: &str) -> Result<(), String> {
    Err("Windows printing not available on this platform".into())
}

// ---------------------------------------------------------------------------
// Printer profile CRUD
// ---------------------------------------------------------------------------

/// Create a new printer profile. Returns `{ success, profileId }`.
pub fn create_printer_profile(db: &DbState, profile: &Value) -> Result<Value, String> {
    let name = profile
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing profile name")?;
    let printer_name = profile
        .get("printerName")
        .or_else(|| profile.get("printer_name"))
        .and_then(|v| v.as_str())
        .ok_or("Missing printer_name")?;
    let driver_type = profile
        .get("driverType")
        .or_else(|| profile.get("driver_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("windows");
    let paper_width_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
        .unwrap_or(80) as i32;
    let copies_default = profile
        .get("copiesDefault")
        .or_else(|| profile.get("copies_default"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1) as i32;
    let cut_paper = profile
        .get("cutPaper")
        .or_else(|| profile.get("cut_paper"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let open_cash_drawer = profile
        .get("openCashDrawer")
        .or_else(|| profile.get("open_cash_drawer"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let drawer_mode = profile
        .get("drawerMode")
        .or_else(|| profile.get("drawer_mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    let drawer_host = profile
        .get("drawerHost")
        .or_else(|| profile.get("drawer_host"))
        .and_then(|v| v.as_str());
    let drawer_port = profile
        .get("drawerPort")
        .or_else(|| profile.get("drawer_port"))
        .and_then(|v| v.as_i64())
        .unwrap_or(9100) as i32;
    let drawer_pulse_ms = profile
        .get("drawerPulseMs")
        .or_else(|| profile.get("drawer_pulse_ms"))
        .and_then(|v| v.as_i64())
        .unwrap_or(200) as i32;

    // v15 extended columns
    let printer_type = profile
        .get("printerType")
        .or_else(|| profile.get("printer_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("system");
    let role = profile
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("receipt");
    let is_default = profile
        .get("isDefault")
        .or_else(|| profile.get("is_default"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let enabled = profile
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let character_set = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(|v| v.as_str())
        .unwrap_or("PC437_USA");
    let greek_render_mode = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(|v| v.as_str());
    let receipt_template = profile
        .get("receiptTemplate")
        .or_else(|| profile.get("receipt_template"))
        .and_then(|v| v.as_str());
    let fallback_printer_id = profile
        .get("fallbackPrinterId")
        .or_else(|| profile.get("fallback_printer_id"))
        .and_then(|v| v.as_str());
    let connection_json = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(|v| v.as_str());

    if driver_type != "windows" {
        return Err(format!("Unsupported driver_type: {driver_type}"));
    }
    if paper_width_mm != 58 && paper_width_mm != 80 {
        return Err(format!(
            "Invalid paper_width_mm: {paper_width_mm}. Must be 58 or 80"
        ));
    }
    if drawer_mode != "none" && drawer_mode != "escpos_tcp" {
        return Err(format!(
            "Invalid drawer_mode: {drawer_mode}. Must be 'none' or 'escpos_tcp'"
        ));
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO printer_profiles (id, name, driver_type, printer_name, paper_width_mm,
                                       copies_default, cut_paper, open_cash_drawer,
                                       drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                                       printer_type, role, is_default, enabled,
                                       character_set, greek_render_mode, receipt_template,
                                       fallback_printer_id, connection_json,
                                       created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22)",
        params![
            id,
            name,
            driver_type,
            printer_name,
            paper_width_mm,
            copies_default,
            cut_paper as i32,
            open_cash_drawer as i32,
            drawer_mode,
            drawer_host,
            drawer_port,
            drawer_pulse_ms,
            printer_type,
            role,
            is_default as i32,
            enabled as i32,
            character_set,
            greek_render_mode,
            receipt_template,
            fallback_printer_id,
            connection_json,
            now,
        ],
    )
    .map_err(|e| format!("create printer profile: {e}"))?;

    info!(id = %id, name = %name, printer = %printer_name, "Printer profile created");

    Ok(serde_json::json!({
        "success": true,
        "profileId": id,
    }))
}

/// Update an existing printer profile. Returns `{ success }`.
pub fn update_printer_profile(db: &DbState, profile: &Value) -> Result<Value, String> {
    let id = profile
        .get("id")
        .or_else(|| profile.get("profileId"))
        .and_then(|v| v.as_str())
        .ok_or("Missing profile id")?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    // Build dynamic SET clause from provided fields
    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(v) = profile.get("name").and_then(|v| v.as_str()) {
        sets.push("name = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("printerName")
        .or_else(|| profile.get("printer_name"))
        .and_then(|v| v.as_str())
    {
        sets.push("printer_name = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
    {
        let w = v as i32;
        if w != 58 && w != 80 {
            return Err(format!("Invalid paper_width_mm: {w}"));
        }
        sets.push("paper_width_mm = ?");
        vals.push(Box::new(w));
    }
    if let Some(v) = profile
        .get("copiesDefault")
        .or_else(|| profile.get("copies_default"))
        .and_then(|v| v.as_i64())
    {
        sets.push("copies_default = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("cutPaper")
        .or_else(|| profile.get("cut_paper"))
        .and_then(|v| v.as_bool())
    {
        sets.push("cut_paper = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("openCashDrawer")
        .or_else(|| profile.get("open_cash_drawer"))
        .and_then(|v| v.as_bool())
    {
        sets.push("open_cash_drawer = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("drawerMode")
        .or_else(|| profile.get("drawer_mode"))
        .and_then(|v| v.as_str())
    {
        if v != "none" && v != "escpos_tcp" {
            return Err(format!("Invalid drawer_mode: {v}"));
        }
        sets.push("drawer_mode = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("drawerHost")
        .or_else(|| profile.get("drawer_host"))
        .and_then(|v| v.as_str())
    {
        sets.push("drawer_host = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("drawerPort")
        .or_else(|| profile.get("drawer_port"))
        .and_then(|v| v.as_i64())
    {
        sets.push("drawer_port = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("drawerPulseMs")
        .or_else(|| profile.get("drawer_pulse_ms"))
        .and_then(|v| v.as_i64())
    {
        sets.push("drawer_pulse_ms = ?");
        vals.push(Box::new(v as i32));
    }

    // v15 extended columns
    if let Some(v) = profile
        .get("printerType")
        .or_else(|| profile.get("printer_type"))
        .and_then(|v| v.as_str())
    {
        sets.push("printer_type = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile.get("role").and_then(|v| v.as_str()) {
        sets.push("role = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("isDefault")
        .or_else(|| profile.get("is_default"))
        .and_then(|v| v.as_bool())
    {
        sets.push("is_default = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile.get("enabled").and_then(|v| v.as_bool()) {
        sets.push("enabled = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(|v| v.as_str())
    {
        sets.push("character_set = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(|v| v.as_str())
    {
        sets.push("greek_render_mode = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("receiptTemplate")
        .or_else(|| profile.get("receipt_template"))
        .and_then(|v| v.as_str())
    {
        sets.push("receipt_template = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("fallbackPrinterId")
        .or_else(|| profile.get("fallback_printer_id"))
        .and_then(|v| v.as_str())
    {
        sets.push("fallback_printer_id = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(|v| v.as_str())
    {
        sets.push("connection_json = ?");
        vals.push(Box::new(v.to_string()));
    }

    if sets.is_empty() {
        return Err("No fields to update".into());
    }

    sets.push("updated_at = ?");
    vals.push(Box::new(now));
    vals.push(Box::new(id.to_string()));

    let sql = format!(
        "UPDATE printer_profiles SET {} WHERE id = ?",
        sets.join(", ")
    );

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    let affected = conn
        .execute(&sql, params_refs.as_slice())
        .map_err(|e| format!("update printer profile: {e}"))?;

    if affected == 0 {
        return Err(format!("Printer profile {id} not found"));
    }

    info!(id = %id, "Printer profile updated");
    Ok(serde_json::json!({ "success": true }))
}

/// List all printer profiles.
pub fn list_printer_profiles(db: &DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, driver_type, printer_name, paper_width_mm,
                    copies_default, cut_paper, open_cash_drawer,
                    drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                    created_at, updated_at,
                    printer_type, role, is_default, enabled,
                    character_set, greek_render_mode, receipt_template,
                    fallback_printer_id, connection_json
             FROM printer_profiles ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "driverType": row.get::<_, String>(2)?,
                "printerName": row.get::<_, String>(3)?,
                "paperWidthMm": row.get::<_, i32>(4)?,
                "copiesDefault": row.get::<_, i32>(5)?,
                "cutPaper": row.get::<_, i32>(6)? != 0,
                "openCashDrawer": row.get::<_, i32>(7)? != 0,
                "drawerMode": row.get::<_, String>(8)?,
                "drawerHost": row.get::<_, Option<String>>(9)?,
                "drawerPort": row.get::<_, i32>(10)?,
                "drawerPulseMs": row.get::<_, i32>(11)?,
                "createdAt": row.get::<_, String>(12)?,
                "updatedAt": row.get::<_, String>(13)?,
                "printerType": row.get::<_, String>(14)?,
                "role": row.get::<_, String>(15)?,
                "isDefault": row.get::<_, i32>(16)? != 0,
                "enabled": row.get::<_, i32>(17)? != 0,
                "characterSet": row.get::<_, String>(18)?,
                "greekRenderMode": row.get::<_, Option<String>>(19)?,
                "receiptTemplate": row.get::<_, Option<String>>(20)?,
                "fallbackPrinterId": row.get::<_, Option<String>>(21)?,
                "connectionJson": row.get::<_, Option<String>>(22)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::json!(rows))
}

/// Get a single printer profile by ID.
pub fn get_printer_profile(db: &DbState, profile_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, name, driver_type, printer_name, paper_width_mm,
                copies_default, cut_paper, open_cash_drawer,
                drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                created_at, updated_at,
                printer_type, role, is_default, enabled,
                character_set, greek_render_mode, receipt_template,
                fallback_printer_id, connection_json
         FROM printer_profiles WHERE id = ?1",
        params![profile_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "driverType": row.get::<_, String>(2)?,
                "printerName": row.get::<_, String>(3)?,
                "paperWidthMm": row.get::<_, i32>(4)?,
                "copiesDefault": row.get::<_, i32>(5)?,
                "cutPaper": row.get::<_, i32>(6)? != 0,
                "openCashDrawer": row.get::<_, i32>(7)? != 0,
                "drawerMode": row.get::<_, String>(8)?,
                "drawerHost": row.get::<_, Option<String>>(9)?,
                "drawerPort": row.get::<_, i32>(10)?,
                "drawerPulseMs": row.get::<_, i32>(11)?,
                "createdAt": row.get::<_, String>(12)?,
                "updatedAt": row.get::<_, String>(13)?,
                "printerType": row.get::<_, String>(14)?,
                "role": row.get::<_, String>(15)?,
                "isDefault": row.get::<_, i32>(16)? != 0,
                "enabled": row.get::<_, i32>(17)? != 0,
                "characterSet": row.get::<_, String>(18)?,
                "greekRenderMode": row.get::<_, Option<String>>(19)?,
                "receiptTemplate": row.get::<_, Option<String>>(20)?,
                "fallbackPrinterId": row.get::<_, Option<String>>(21)?,
                "connectionJson": row.get::<_, Option<String>>(22)?,
            }))
        },
    )
    .map_err(|e| format!("Printer profile {profile_id} not found: {e}"))
}

/// Delete a printer profile. Also clears the default if it was the default.
pub fn delete_printer_profile(db: &DbState, profile_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let affected = conn
        .execute(
            "DELETE FROM printer_profiles WHERE id = ?1",
            params![profile_id],
        )
        .map_err(|e| format!("delete printer profile: {e}"))?;

    if affected == 0 {
        return Err(format!("Printer profile {profile_id} not found"));
    }

    // Clear default if this was the default profile
    let current_default = db::get_setting(&conn, "printer", "default_printer_profile_id");
    if current_default.as_deref() == Some(profile_id) {
        let _ = conn.execute(
            "DELETE FROM local_settings WHERE setting_category = 'printer' AND setting_key = 'default_printer_profile_id'",
            [],
        );
    }

    info!(id = %profile_id, "Printer profile deleted");
    Ok(serde_json::json!({ "success": true }))
}

/// Set the default printer profile ID in local_settings.
pub fn set_default_printer_profile(db: &DbState, profile_id: &str) -> Result<Value, String> {
    // Verify profile exists
    let _ = get_printer_profile(db, profile_id)?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "printer", "default_printer_profile_id", profile_id)?;

    info!(profile_id = %profile_id, "Default printer profile set");
    Ok(serde_json::json!({ "success": true }))
}

/// Get the default printer profile (full profile object or null).
pub fn get_default_printer_profile(db: &DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let profile_id = db::get_setting(&conn, "printer", "default_printer_profile_id");
    drop(conn);

    match profile_id {
        Some(id) => match get_printer_profile(db, &id) {
            Ok(profile) => Ok(profile),
            Err(_) => {
                warn!(id = %id, "Default printer profile not found, clearing setting");
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                let _ = conn.execute(
                    "DELETE FROM local_settings WHERE setting_category = 'printer' AND setting_key = 'default_printer_profile_id'",
                    [],
                );
                Ok(Value::Null)
            }
        },
        None => Ok(Value::Null),
    }
}

/// Resolve the printer profile for a print job.
///
/// Priority: job-specific `printer_profile_id` > default profile > None.
pub fn resolve_printer_profile(
    db: &DbState,
    job_profile_id: Option<&str>,
) -> Result<Option<Value>, String> {
    // Try job-specific profile first
    if let Some(id) = job_profile_id {
        if !id.is_empty() {
            return match get_printer_profile(db, id) {
                Ok(p) => Ok(Some(p)),
                Err(e) => Err(format!("Job printer profile not found: {e}")),
            };
        }
    }

    // Fall back to default
    let default_profile = get_default_printer_profile(db)?;
    if default_profile.is_null() {
        Ok(None)
    } else {
        Ok(Some(default_profile))
    }
}

/// Reprint a failed print job by resetting its status and retry counters.
pub fn reprint_job(db: &DbState, job_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let affected = conn
        .execute(
            "UPDATE print_jobs SET
                status = 'pending',
                retry_count = 0,
                next_retry_at = NULL,
                last_error = NULL,
                updated_at = ?1
             WHERE id = ?2 AND status = 'failed'",
            params![now, job_id],
        )
        .map_err(|e| format!("reprint job: {e}"))?;

    if affected == 0 {
        return Err(format!(
            "Print job {job_id} not found or not in failed state"
        ));
    }

    info!(job_id = %job_id, "Print job reset for reprint");
    Ok(serde_json::json!({
        "success": true,
        "jobId": job_id,
        "message": "Print job queued for reprint",
    }))
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn test_create_and_list_profiles() {
        let db = test_db();

        let profile = serde_json::json!({
            "name": "Main Receipt",
            "printerName": "POS-80 Printer",
            "paperWidthMm": 80,
            "copiesDefault": 1,
            "cutPaper": true,
        });

        let result = create_printer_profile(&db, &profile).unwrap();
        assert_eq!(result["success"], true);
        let profile_id = result["profileId"].as_str().unwrap().to_string();
        assert!(!profile_id.is_empty());

        // List profiles
        let list = list_printer_profiles(&db).unwrap();
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "Main Receipt");
        assert_eq!(arr[0]["printerName"], "POS-80 Printer");
        assert_eq!(arr[0]["paperWidthMm"], 80);
        assert_eq!(arr[0]["cutPaper"], true);
        assert_eq!(arr[0]["openCashDrawer"], false);
    }

    #[test]
    fn test_update_profile() {
        let db = test_db();

        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Test Printer",
                "printerName": "OldName",
            }),
        )
        .unwrap();
        let id = result["profileId"].as_str().unwrap();

        // Update name and paper width
        let update_result = update_printer_profile(
            &db,
            &serde_json::json!({
                "id": id,
                "name": "Updated Printer",
                "printerName": "NewName",
                "paperWidthMm": 58,
            }),
        )
        .unwrap();
        assert_eq!(update_result["success"], true);

        // Verify update
        let profile = get_printer_profile(&db, id).unwrap();
        assert_eq!(profile["name"], "Updated Printer");
        assert_eq!(profile["printerName"], "NewName");
        assert_eq!(profile["paperWidthMm"], 58);
    }

    #[test]
    fn test_delete_profile_clears_default() {
        let db = test_db();

        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "ToDelete",
                "printerName": "SomePrinter",
            }),
        )
        .unwrap();
        let id = result["profileId"].as_str().unwrap();

        // Set as default
        set_default_printer_profile(&db, id).unwrap();
        let def = get_default_printer_profile(&db).unwrap();
        assert_eq!(def["id"], id);

        // Delete
        delete_printer_profile(&db, id).unwrap();

        // Default should be cleared
        let def_after = get_default_printer_profile(&db).unwrap();
        assert!(def_after.is_null());
    }

    #[test]
    fn test_default_printer_profile() {
        let db = test_db();

        // Initially no default
        let def = get_default_printer_profile(&db).unwrap();
        assert!(def.is_null());

        // Create and set as default
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Default Printer",
                "printerName": "MyPrinter",
            }),
        )
        .unwrap();
        let id = result["profileId"].as_str().unwrap();

        set_default_printer_profile(&db, id).unwrap();

        let def = get_default_printer_profile(&db).unwrap();
        assert_eq!(def["id"], id);
        assert_eq!(def["name"], "Default Printer");
    }

    #[test]
    fn test_resolve_printer_profile() {
        let db = test_db();

        // No profiles — resolve returns None
        let resolved = resolve_printer_profile(&db, None).unwrap();
        assert!(resolved.is_none());

        // Create a profile and set as default
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Default",
                "printerName": "DefaultPrinter",
            }),
        )
        .unwrap();
        let default_id = result["profileId"].as_str().unwrap();
        set_default_printer_profile(&db, default_id).unwrap();

        // Create another profile
        let result2 = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Kitchen",
                "printerName": "KitchenPrinter",
            }),
        )
        .unwrap();
        let kitchen_id = result2["profileId"].as_str().unwrap();

        // Resolve with no job-specific ID -> default
        let resolved = resolve_printer_profile(&db, None).unwrap().unwrap();
        assert_eq!(resolved["printerName"], "DefaultPrinter");

        // Resolve with job-specific ID -> that specific profile
        let resolved = resolve_printer_profile(&db, Some(kitchen_id))
            .unwrap()
            .unwrap();
        assert_eq!(resolved["printerName"], "KitchenPrinter");

        // Resolve with invalid ID -> error
        let err = resolve_printer_profile(&db, Some("nonexistent"));
        assert!(err.is_err());
    }

    #[test]
    fn test_reprint_job() {
        let db = test_db();

        // Insert a failed print job directly
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, retry_count, max_retries, last_error, created_at, updated_at)
                 VALUES ('pj-fail', 'order_receipt', 'ord-1', 'failed', 3, 3, 'printer offline', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        // Reprint
        let result = reprint_job(&db, "pj-fail").unwrap();
        assert_eq!(result["success"], true);

        // Verify job is back to pending
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM print_jobs WHERE id = 'pj-fail'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");

        let retry: i32 = conn
            .query_row(
                "SELECT retry_count FROM print_jobs WHERE id = 'pj-fail'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retry, 0);
    }

    #[test]
    fn test_reprint_non_failed_job_errors() {
        let db = test_db();

        // Insert a pending print job
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
                 VALUES ('pj-pend', 'order_receipt', 'ord-2', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        // Reprint should fail — job is not in 'failed' state
        let err = reprint_job(&db, "pj-pend");
        assert!(err.is_err());
    }

    #[test]
    fn test_list_system_printers_returns_vec() {
        // Just verify it doesn't panic — actual printers depend on the system
        let printers = list_system_printers();
        // On CI/test environments there may be 0 printers, that's fine.
        // Just verify it returns a Vec without panicking.
        let _ = printers.len();
    }

    #[test]
    fn test_invalid_driver_type_rejected() {
        let db = test_db();
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Bad",
                "printerName": "Printer",
                "driverType": "escpos",
            }),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_paper_width_rejected() {
        let db = test_db();
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Bad",
                "printerName": "Printer",
                "paperWidthMm": 72,
            }),
        );
        assert!(result.is_err());
    }
}
