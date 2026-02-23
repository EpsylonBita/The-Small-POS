use serde::Deserialize;

use crate::{db, payload_arg0_as_string, zreport};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZReportGeneratePayload {
    #[serde(default, alias = "shift_id")]
    shift_id: Option<String>,
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

fn parse_zreport_generate_payload(arg0: Option<serde_json::Value>) -> serde_json::Value {
    let payload = match arg0 {
        Some(serde_json::Value::String(shift_id)) => serde_json::json!({
            "shiftId": shift_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    // Run through typed deserialize to normalize accepted keys without
    // rejecting additional fields that zreport internals may rely on.
    let parsed: Option<ZReportGeneratePayload> = serde_json::from_value(payload.clone()).ok();
    if let Some(parsed) = parsed {
        let mut normalized = serde_json::Map::new();
        if let Some(shift_id) =
            parsed
                .shift_id
                .and_then(|s| if s.trim().is_empty() { None } else { Some(s) })
        {
            normalized.insert(
                "shiftId".to_string(),
                serde_json::Value::String(shift_id.trim().to_string()),
            );
        }
        if let Some(branch_id) =
            parsed
                .branch_id
                .and_then(|s| if s.trim().is_empty() { None } else { Some(s) })
        {
            normalized.insert(
                "branchId".to_string(),
                serde_json::Value::String(branch_id.trim().to_string()),
            );
        }
        if let Some(date) = parsed
            .date
            .and_then(|s| if s.trim().is_empty() { None } else { Some(s) })
        {
            normalized.insert(
                "date".to_string(),
                serde_json::Value::String(date.trim().to_string()),
            );
        }

        if let serde_json::Value::Object(obj) = payload {
            for (k, v) in obj {
                normalized.entry(k).or_insert(v);
            }
        }

        return serde_json::Value::Object(normalized);
    }

    payload
}

fn parse_zreport_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["zReportId", "z_report_id", "id"])
        .ok_or("Missing zReportId".into())
}

fn parse_zreport_list_payload(arg0: Option<serde_json::Value>) -> serde_json::Value {
    match arg0 {
        Some(serde_json::Value::String(shift_id)) => serde_json::json!({
            "shiftId": shift_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    }
}

#[tauri::command]
pub async fn zreport_generate(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_zreport_generate_payload(arg0);

    let has_shift_id = payload.get("shiftId").and_then(|v| v.as_str()).is_some()
        || payload.get("shift_id").and_then(|v| v.as_str()).is_some();
    let has_branch_date = payload.get("branchId").and_then(|v| v.as_str()).is_some()
        || payload.get("date").and_then(|v| v.as_str()).is_some();

    if has_shift_id && !has_branch_date {
        zreport::generate_z_report(&db, &payload)
    } else {
        zreport::generate_z_report_for_date(&db, &payload)
    }
}

#[tauri::command]
pub async fn zreport_get(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({
        "zReportId": parse_zreport_id_payload(arg0)?
    });
    zreport::get_z_report(&db, &payload)
}

#[tauri::command]
pub async fn zreport_list(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_zreport_list_payload(arg0);
    zreport::list_z_reports(&db, &payload)
}

#[tauri::command]
pub async fn zreport_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({
        "zReportId": parse_zreport_id_payload(arg0)?
    });
    zreport::print_z_report(&db, &payload)
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_zreport_generate_payload_supports_shift_string() {
        let payload = parse_zreport_generate_payload(Some(serde_json::json!("shift-1")));
        assert_eq!(
            payload.get("shiftId").and_then(|v| v.as_str()),
            Some("shift-1")
        );
    }

    #[test]
    fn parse_zreport_generate_payload_normalizes_branch_and_date() {
        let payload = parse_zreport_generate_payload(Some(serde_json::json!({
            "branch_id": "branch-1",
            "date": "2026-02-22"
        })));
        assert_eq!(
            payload.get("branchId").and_then(|v| v.as_str()),
            Some("branch-1")
        );
        assert_eq!(
            payload.get("date").and_then(|v| v.as_str()),
            Some("2026-02-22")
        );
    }

    #[test]
    fn parse_zreport_id_payload_supports_string_and_object() {
        let from_string = parse_zreport_id_payload(Some(serde_json::json!("zr-1")))
            .expect("string id payload should parse");
        let from_object = parse_zreport_id_payload(Some(serde_json::json!({
            "z_report_id": "zr-2"
        })))
        .expect("object id payload should parse");
        assert_eq!(from_string, "zr-1");
        assert_eq!(from_object, "zr-2");
    }

    #[test]
    fn parse_zreport_list_payload_supports_shift_string() {
        let payload = parse_zreport_list_payload(Some(serde_json::json!("shift-2")));
        assert_eq!(
            payload.get("shiftId").and_then(|v| v.as_str()),
            Some("shift-2")
        );
    }

    #[test]
    fn parse_zreport_id_payload_rejects_missing() {
        let err = parse_zreport_id_payload(Some(serde_json::json!({})))
            .expect_err("missing id should fail");
        assert!(err.contains("Missing zReportId"));
    }
}
