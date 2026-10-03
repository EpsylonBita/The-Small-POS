//! Lossy, bounded support projection of existing runtime logs. No raw message,
//! path, stack, identifier, or arbitrary field is included in the returned JSON.

use chrono::{DateTime, FixedOffset};
use serde_json::{json, Value};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub(super) const MAX_FILES: usize = 3;
const MAX_BYTES_PER_FILE: u64 = 256 * 1024;
const MAX_BYTES_TOTAL: u64 = 512 * 1024;
const MAX_LINE_BYTES: usize = 8192;
const MAX_EVENTS: usize = 50;

pub(super) fn limits() -> Value {
    json!({"maxFiles": MAX_FILES, "maxBytesPerFile": MAX_BYTES_PER_FILE,
        "maxBytesTotal": MAX_BYTES_TOTAL, "maxLineBytes": MAX_LINE_BYTES,
        "maxEventsPerLevel": MAX_EVENTS})
}

fn empty() -> Value {
    json!({
        "format": "thesmall-pos-runtime-events-v1", "status": "ok",
        "capturedAt": chrono::Utc::now().to_rfc3339(), "limits": limits(),
        "coverage": {"oldestEventAt": null, "newestEventAt": null},
        "counts": {"filesFound": 0, "filesRead": 0, "filesOmitted": 0,
            "filesUnreadable": 0, "bytesRead": 0, "linesScanned": 0,
            "linesMalformed": 0, "linesOversized": 0, "linesPartial": 0,
            "linesExcludedRepair": 0, "eventsOmitted": 0},
        "truncated": false, "events": {"error": [], "warn": [], "info": []}
    })
}

fn increment(snapshot: &mut Value, key: &str, amount: u64) {
    let count = snapshot["counts"][key].as_u64().unwrap_or(0);
    snapshot["counts"][key] = json!(count.saturating_add(amount));
}

pub(super) fn has_events(snapshot: &Value) -> bool {
    ["error", "warn", "info"].iter().any(|level| {
        snapshot["events"][level]
            .as_array()
            .is_some_and(|events| !events.is_empty())
    })
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and other reparse points, not only symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn trusted_directory(directory: &Path) -> bool {
    directory.ancestors().all(|ancestor| {
        fs::symlink_metadata(ancestor)
            .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata))
    })
}

fn trusted_name(name: &str) -> bool {
    if name == "pos.log" {
        return true;
    }
    let Some(date) = name.strip_prefix("pos.") else {
        return false;
    };
    let date = date.strip_suffix(".log").unwrap_or(date);
    date.len() == 10 && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}

fn open_trusted_file(path: &Path, root: &Path) -> Option<File> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || is_link(&metadata) || !trusted_directory(root) {
        return None;
    }
    let canonical_root = fs::canonicalize(root).ok()?;
    let canonical_path = fs::canonicalize(path).ok()?;
    if canonical_path.parent()? != canonical_root {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000); // O_NOFOLLOW
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100); // O_NOFOLLOW
    }
    let file = options.open(path).ok()?;
    let opened_metadata = file.metadata().ok()?;
    if !opened_metadata.is_file() || is_link(&opened_metadata) || !trusted_directory(root) {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let mut buffer = vec![0u16; 32768];
        let size = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if size == 0 || size as usize >= buffer.len() {
            return None;
        }
        let actual = std::path::PathBuf::from(String::from_utf16(&buffer[..size as usize]).ok()?);
        if dunce::simplified(&actual) != dunce::simplified(&canonical_path) {
            return None;
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let actual = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()?;
        if actual != canonical_path {
            return None;
        }
    }
    if fs::canonicalize(path).ok()? != canonical_path {
        return None;
    }
    Some(file)
}

/// Only the known log directory is passed by production. The explicit root
/// also keeps regression tests isolated from the running POS's actual logs.
pub(super) fn collect(root: &Path, enabled: bool) -> Value {
    let mut snapshot = empty();
    if !enabled {
        snapshot["status"] = json!("not_collected");
        snapshot["reasonCode"] = json!("disabled");
        return snapshot;
    }
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            snapshot["status"] = json!("not_collected");
            snapshot["reasonCode"] = json!("logs_missing");
            return snapshot;
        }
        Err(_) => {
            snapshot["status"] = json!("unavailable");
            snapshot["reasonCode"] = json!("logs_unreadable");
            increment(&mut snapshot, "filesUnreadable", 1);
            return snapshot;
        }
        Ok(_) => {}
    }
    let entries = if trusted_directory(root) {
        fs::read_dir(root).ok()
    } else {
        None
    };
    let Some(entries) = entries else {
        snapshot["status"] = json!("unavailable");
        snapshot["reasonCode"] = json!("logs_unreadable");
        increment(&mut snapshot, "filesUnreadable", 1);
        return snapshot;
    };
    let mut files = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            increment(&mut snapshot, "filesUnreadable", 1);
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| trusted_name(name)) else {
            continue;
        };
        increment(&mut snapshot, "filesFound", 1);
        let metadata = fs::symlink_metadata(entry.path());
        match metadata {
            Ok(metadata) if metadata.is_file() && !is_link(&metadata) => files.push((
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                name.to_owned(),
                entry.path(),
            )),
            _ => increment(&mut snapshot, "filesUnreadable", 1),
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut remaining = MAX_BYTES_TOTAL;
    for (index, (_, _, path)) in files.iter().enumerate() {
        if index >= MAX_FILES || remaining == 0 {
            increment(&mut snapshot, "filesOmitted", 1);
            snapshot["truncated"] = json!(true);
            continue;
        }
        let Some(mut file) = open_trusted_file(path, root) else {
            increment(&mut snapshot, "filesUnreadable", 1);
            continue;
        };
        let allowance = match file.metadata() {
            Ok(metadata) => metadata.len().min(remaining).min(MAX_BYTES_PER_FILE),
            Err(_) => {
                increment(&mut snapshot, "filesUnreadable", 1);
                continue;
            }
        };
        // Reserve before attempting I/O, even if a read returns only a prefix
        // then fails. Failed reads cannot buy more aggregate budget.
        remaining -= allowance;
        let result = read_tail(&mut file, allowance);
        match result {
            Ok((bytes, start_partial, truncated)) => {
                increment(&mut snapshot, "filesRead", 1);
                increment(&mut snapshot, "bytesRead", bytes.len() as u64);
                if truncated {
                    snapshot["truncated"] = json!(true);
                }
                add_tail(&mut snapshot, &bytes, start_partial);
            }
            Err(bytes_read) => {
                increment(&mut snapshot, "bytesRead", bytes_read);
                increment(&mut snapshot, "filesUnreadable", 1);
            }
        }
    }
    let unreadable = snapshot["counts"]["filesUnreadable"].as_u64().unwrap_or(0);
    let read = snapshot["counts"]["filesRead"].as_u64().unwrap_or(0);
    if unreadable > 0 {
        snapshot["status"] = json!(if read > 0 { "partial" } else { "unavailable" });
        snapshot["reasonCode"] = json!("logs_unreadable");
    } else if files.is_empty() {
        snapshot["status"] = json!("not_collected");
        snapshot["reasonCode"] = json!("logs_missing");
    } else if snapshot["truncated"] == true {
        snapshot["status"] = json!("partial");
    }
    snapshot
}

fn read_tail(file: &mut File, budget: u64) -> Result<(Vec<u8>, bool, bool), u64> {
    let size = file.metadata().map_err(|_| 0u64)?.len();
    let start = size.saturating_sub(budget);
    // Conservative discard costs no extra preceding-byte probe outside budget.
    let start_partial = start > 0;
    file.seek(SeekFrom::Start(start)).map_err(|_| 0u64)?;
    let mut bytes = Vec::with_capacity((size - start) as usize);
    if file.take(size - start).read_to_end(&mut bytes).is_err() {
        return Err(bytes.len() as u64);
    }
    // A truncated/rotated source during the read must not look complete.
    if bytes.len() as u64 != size - start {
        return Err(bytes.len() as u64);
    }
    Ok((bytes, start_partial, start > 0))
}

fn add_tail(snapshot: &mut Value, bytes: &[u8], start_partial: bool) {
    let mut begin = 0;
    if start_partial {
        increment(snapshot, "linesPartial", 1);
        snapshot["truncated"] = json!(true);
        let Some(end) = bytes.iter().position(|byte| *byte == b'\n') else {
            return;
        };
        begin = end + 1;
    }
    let Some(last) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        if begin < bytes.len() {
            increment(snapshot, "linesPartial", 1);
            snapshot["truncated"] = json!(true);
        }
        return;
    };
    if last + 1 < bytes.len() {
        increment(snapshot, "linesPartial", 1);
        snapshot["truncated"] = json!(true);
    }
    if begin > last {
        return;
    }
    for line in bytes[begin..last].split(|byte| *byte == b'\n') {
        increment(snapshot, "linesScanned", 1);
        match std::str::from_utf8(line) {
            Ok(line) => add_line(snapshot, line.trim_end_matches('\r')),
            Err(_) => increment(snapshot, "linesMalformed", 1),
        }
    }
}

fn component(target: &str) -> &'static str {
    let target = target.to_ascii_lowercase();
    for (patterns, component) in [
        (&["print", "printer"][..], "printing"),
        (&["sync", "realtime"][..], "sync"),
        (&["database", "sqlite", "migration"][..], "database"),
        (&["network", "http", "tcp", "socket"][..], "network"),
        (&["auth", "credential", "securestorage"][..], "auth"),
        (&["recovery", "repair"][..], "recovery"),
        (&["updat"][..], "updater"),
        (&["diagnostic", "app", "lifecycle"][..], "app"),
    ] {
        if patterns.iter().any(|pattern| target.contains(pattern)) {
            return component;
        }
    }
    "unknown"
}

fn contains_any(text: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| text.contains(pattern))
}

fn word(text: &str, candidate: &str) -> bool {
    text.match_indices(candidate).any(|(start, _)| {
        let end = start + candidate.len();
        !text[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            && !text[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn numeric_field(text: &str, aliases: &[&str], maximum: u64, minimum: u64) -> Option<u64> {
    for alias in aliases {
        for (index, _) in text.match_indices(alias) {
            if text[..index]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                continue;
            }
            let rest = &text[index + alias.len()..];
            let value_text = if *alias == "os error " {
                rest
            } else {
                let rest = rest.trim_start_matches(['\'', '"']).trim_start();
                let Some(rest) = rest.strip_prefix(':').or_else(|| rest.strip_prefix('=')) else {
                    continue;
                };
                rest.trim_start()
            };
            let count = value_text.bytes().take_while(u8::is_ascii_digit).count();
            if count == 0
                || value_text[count..]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_ascii_whitespace() && !matches!(c, ',' | '}' | ')'))
            {
                continue;
            }
            let value = value_text[..count].parse::<u64>().ok();
            if let Some(value) = value.filter(|value| (minimum..=maximum).contains(value)) {
                return Some(value);
            }
        }
    }
    None
}

pub(super) fn project_line(line: &str) -> Result<Value, &'static str> {
    if line.len() > MAX_LINE_BYTES {
        return Err("oversized");
    }
    let lowercase = line.to_ascii_lowercase();
    if contains_any(
        &lowercase,
        &[
            "sealed",
            "ciphertext",
            "envelope",
            "nonce",
            "repair_payload",
            "repairpayload",
            "repair-payload",
        ],
    ) || ["payload", "body", "header", "headers"]
        .iter()
        .any(|candidate| word(&lowercase, candidate))
    {
        return Err("excludedRepair");
    }
    if line.contains('\0') {
        return Err("malformed");
    }
    let (timestamp, rest) = line.split_once(char::is_whitespace).ok_or("malformed")?;
    let timestamp = timestamp.trim_matches(['[', ']']);
    let (level, message) = rest
        .trim_start()
        .split_once(char::is_whitespace)
        .ok_or("malformed")?;
    let (level, message) = (level.trim_matches(['[', ']']), message.trim_start());
    if !matches!(level, "ERROR" | "WARN" | "INFO")
        || message.is_empty()
        || !timestamp.contains('T')
        || DateTime::parse_from_rfc3339(timestamp).is_err()
    {
        return Err("malformed");
    }
    let level = level.to_ascii_lowercase();
    let native_target = message.find(": ").and_then(|end| {
        let candidate = &message[..end];
        candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':'))
            .then_some(candidate)
    });
    let mobile_target = message.strip_prefix('[').and_then(|rest| {
        rest.split_once(']')
            .map(|(prefix, _)| prefix)
            .filter(|prefix| {
                prefix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
    });
    let target = native_target.or(mobile_target).unwrap_or_else(|| {
        if message.starts_with("Print job failed") {
            "printing"
        } else {
            ""
        }
    });
    let component = component(target);
    let message_lower = message.to_ascii_lowercase();
    let code = if matches!(component, "printing" | "network")
        && contains_any(&message_lower, &["timeout", "timed out", "os error 10060"])
    {
        "transport_timeout"
    } else if matches!(component, "printing" | "network")
        && contains_any(&message_lower, &["fail", "error"])
    {
        "transport_error"
    } else if component == "sync" && contains_any(&message_lower, &["fail", "error"]) {
        "sync_error"
    } else if component == "database" && contains_any(&message_lower, &["fail", "error"]) {
        "database_error"
    } else if component == "auth"
        && contains_any(&message_lower, &["fail", "error", "invalid", "unauthoriz"])
    {
        "auth_error"
    } else if component == "recovery" {
        "recovery_event"
    } else if component == "updater" && contains_any(&message_lower, &["fail", "error"]) {
        "updater_error"
    } else {
        match level.as_str() {
            "error" => "runtime_error",
            "warn" => "runtime_warning",
            _ => "runtime_info",
        }
    };
    let mut event =
        json!({"timestamp": timestamp, "level": level, "component": component, "eventCode": code});
    if component != "unknown"
        && !contains_any(
            &message_lower,
            &[
                "customer",
                "note",
                "address",
                "authorization",
                "token",
                "password",
                "credential",
                "secret",
                "email",
                "phone",
            ],
        )
    {
        for (key, aliases, maximum, minimum) in [
            (
                "osErrorCode",
                &["os error ", "osErrorCode", "os_error_code"][..],
                65535,
                0,
            ),
            ("httpStatus", &["httpStatus", "http_status"][..], 599, 100),
            (
                "bytesRequested",
                &["bytesRequested", "bytes_requested"][..],
                268435456,
                0,
            ),
            (
                "bytesWritten",
                &["bytesWritten", "bytes_written"][..],
                268435456,
                0,
            ),
            (
                "durationMs",
                &["durationMs", "duration_ms"][..],
                604800000,
                0,
            ),
            ("retryCount", &["retryCount", "retry_count"][..], 1000, 0),
        ] {
            if let Some(value) = numeric_field(message, aliases, maximum, minimum) {
                event[key] = json!(value);
            }
        }
    }
    Ok(event)
}

fn event_time(event: &Value) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339(event["timestamp"].as_str().unwrap()).unwrap()
}

fn add_line(snapshot: &mut Value, line: &str) {
    let event = match project_line(line) {
        Ok(event) => event,
        Err("excludedRepair") => {
            increment(snapshot, "linesExcludedRepair", 1);
            return;
        }
        Err("oversized") => {
            increment(snapshot, "linesOversized", 1);
            snapshot["truncated"] = json!(true);
            return;
        }
        Err(_) => {
            increment(snapshot, "linesMalformed", 1);
            return;
        }
    };
    let time = event_time(&event);
    for (key, before) in [("oldestEventAt", true), ("newestEventAt", false)] {
        let current = snapshot["coverage"][key]
            .as_str()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok());
        if current.map_or(true, |current| {
            if before {
                time < current
            } else {
                time > current
            }
        }) {
            snapshot["coverage"][key] = event["timestamp"].clone();
        }
    }
    let level = event["level"].as_str().unwrap().to_owned();
    let events = snapshot["events"][&level].as_array_mut().unwrap();
    events.push(event);
    events.sort_by_key(event_time);
    if events.len() > MAX_EVENTS {
        events.remove(0);
        increment(snapshot, "eventsOmitted", 1);
        snapshot["truncated"] = json!(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("diagnostics_logs_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn runtime_logs_shared_projection_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../shared/pos/health/__fixtures__/runtime-log-events.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let actual = match project_line(vector["line"].as_str().unwrap()) {
                Ok(event) => json!({"event": event}),
                Err(reason) => json!({"omitted": reason}),
            };
            assert_eq!(actual, vector["expected"], "{}", vector["name"]);
        }
        let prefix = "2026-10-02T22:15:23Z WARN printers: ";
        let boundary = format!("{prefix}{}", "x".repeat(MAX_LINE_BYTES - prefix.len()));
        assert!(project_line(&boundary).is_ok());
        assert_eq!(project_line(&format!("{boundary}α")), Err("oversized"));
        assert_eq!(
            project_line("2026-02-30T22:15:23Z ERROR printers: failed"),
            Err("malformed")
        );
        assert_eq!(
            project_line("2026-10-02T22:15:23Z ERROR printers: private\0record"),
            Err("malformed")
        );
    }

    #[test]
    fn runtime_logs_are_isolated_lossy_and_truthful() {
        let root = root();
        fs::write(root.join("pos.2026-10-02"), concat!(
            "2026-10-02T22:15:23Z ERROR the_small_pos_lib::printers: TCP write failed (os error 10060) bytes_requested=115081 bytes_written=32768\n",
            "2026-10-02T22:15:24Z WARN the_small_pos_lib::sync: customer=PRIVATE-NAME notes=PRIVATE-NOTE token=PRIVATE-SECRET retry_count=9\n",
            "2026-10-02T22:15:25Z WARN the_small_pos_lib::repairs: ciphertext=PRIVATE-CIPHER organization_id=PRIVATE-ORG payload=PRIVATE-PAYLOAD\n",
            "PRIVATE-STACK /private/customer-file\n"
        )).unwrap();
        fs::write(root.join("arbitrary.log"), "PRIVATE-ARBITRARY").unwrap();
        let snapshot = collect(&root, true);
        assert_eq!(snapshot["status"], "ok");
        assert!(has_events(&snapshot));
        assert_eq!(snapshot["events"]["error"][0]["bytesRequested"], 115081);
        assert_eq!(snapshot["events"]["error"][0]["bytesWritten"], 32768);
        assert_eq!(snapshot["events"]["error"][0]["osErrorCode"], 10060);
        assert!(snapshot["events"]["warn"][0].get("retryCount").is_none());
        assert_eq!(snapshot["counts"]["linesExcludedRepair"], 1);
        assert_eq!(snapshot["counts"]["linesMalformed"], 1);
        let encoded = snapshot.to_string();
        for marker in [
            "PRIVATE",
            "customer-file",
            "ciphertext",
            "payload",
            "the_small_pos_lib",
            "message",
            "stack",
        ] {
            assert!(!encoded.contains(marker));
        }
        assert_eq!(collect(&root, false)["reasonCode"], "disabled");
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(collect(&root, true)["reasonCode"], "logs_missing");
    }

    #[test]
    fn runtime_logs_tail_limits_and_partial_records_are_explicit() {
        let root = root();
        for day in 1..=4 {
            let mut bytes = vec![b'x'; 280 * 1024];
            bytes.extend_from_slice(b"\n2026-10-02T22:15:23Z ERROR printers: TCP timed out\n");
            bytes.extend_from_slice(&[0xff, b'\n']);
            bytes.extend_from_slice(b"2026-10-02T22:15:24Z WARN sync: unfinished");
            fs::write(root.join(format!("pos.2026-10-0{day}")), bytes).unwrap();
        }
        let snapshot = collect(&root, true);
        assert_eq!(snapshot["status"], "partial");
        assert_eq!(snapshot["counts"]["filesFound"], 4);
        assert_eq!(snapshot["counts"]["filesRead"], 2);
        assert_eq!(snapshot["counts"]["filesOmitted"], 2);
        assert_eq!(snapshot["counts"]["bytesRead"], MAX_BYTES_TOTAL);
        assert_eq!(snapshot["counts"]["linesPartial"], 4);
        assert_eq!(snapshot["counts"]["linesMalformed"], 2);
        assert_eq!(snapshot["events"]["error"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["truncated"], true);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_logs_failures_and_per_level_history_remain_visible() {
        let root = root();
        fs::create_dir(root.join("pos.2026-10-01")).unwrap();
        assert_eq!(collect(&root, true)["status"], "unavailable");
        let lines: String = (0..60)
            .map(|second| {
                format!(
                    "2026-10-02T22:{:02}:{:02}Z ERROR printers: failed duration_ms=5000\n",
                    second / 60,
                    second % 60
                )
            })
            .collect();
        fs::write(root.join("pos.2026-10-02"), lines).unwrap();
        let snapshot = collect(&root, true);
        assert_eq!(snapshot["status"], "partial");
        assert_eq!(snapshot["reasonCode"], "logs_unreadable");
        assert_eq!(snapshot["counts"]["eventsOmitted"], 10);
        assert_eq!(snapshot["events"]["error"].as_array().unwrap().len(), 50);
        assert_eq!(
            snapshot["events"]["error"][0]["timestamp"],
            "2026-10-02T22:00:10Z"
        );
        assert_eq!(
            snapshot["coverage"]["oldestEventAt"],
            "2026-10-02T22:00:00Z"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
