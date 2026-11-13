//! Reasoned evidence reads. This policy never grants access to secret columns.
use super::{contracts::Command, critical_op::SupportPermit, redaction::MARKER, replica};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, Instant},
};

pub const PERSONAL_TOOLS: &[&str] = &[
    "till_logs",
    "till_sync_queue",
    "till_sql_query",
    "till_diagnostics_bundle",
    "till_shifts",
];
pub const DETAILS: &[&str] = &[
    "SQLITE_PATCH_REQUIRED",
    "BUSINESS_DATABASE_MISSING",
    "BUSINESS_DATABASE_OPEN_FAILED",
    "TABLE_MISSING",
    "COLUMN_MISSING",
    "REPLICA_BUILD_FAILED",
    "INSUFFICIENT_FREE_DISK",
    "HEALTH_OBSERVATION_MISSING",
    "SCREEN_CAPTURE_UNAVAILABLE",
    "SCREEN_CAPTURE_FAILED",
    "SCREEN_CONTAINS_SECRETS",
    "PREEMPTED_BY_SALE",
    "PREEMPTED_BY_PAYMENT",
    "PREEMPTED_BY_SHIFT_CLOSE",
    "PREEMPTED_BY_Z",
    "SCREENSHOT_ALREADY_CONSUMED",
];
/// Internal errors carry two closed codes, never an exception or path.
pub fn error(detail: &str) -> String {
    format!("INTERNAL_ERROR|{detail}")
}
pub fn split_error(code: &str) -> (&str, Option<&str>) {
    match code.split_once('|') {
        Some((outer, detail)) if DETAILS.contains(&detail) => (outer, Some(detail)),
        _ => (code, None),
    }
}
/// Older diagnostics owners return strings. Project only recognized native
/// SQLite causes; never put their message or path into a wire detail.
pub fn detail_of(error: &str) -> Option<&'static str> {
    if let Some((_, detail)) = error.split_once('|') {
        if let Some(code) = DETAILS.iter().copied().find(|code| *code == detail) {
            return Some(code);
        }
    }
    let lower = error.to_ascii_lowercase();
    if lower.contains("no such table:") {
        Some("TABLE_MISSING")
    } else if lower.contains("no such column:") || lower.contains("has no column named") {
        Some("COLUMN_MISSING")
    } else if lower.contains("database or disk is full") || error == "INSUFFICIENT_DISK" {
        Some("INSUFFICIENT_FREE_DISK")
    } else if lower.contains("unable to open database file")
        || lower.contains("file is not a database")
        || lower.contains("database disk image is malformed")
    {
        Some("BUSINESS_DATABASE_OPEN_FAILED")
    } else {
        None
    }
}
pub fn preemption(kind: super::critical_op::CriticalKind) -> Option<&'static str> {
    use super::critical_op::CriticalKind;
    match kind {
        CriticalKind::Checkout => Some("PREEMPTED_BY_SALE"),
        CriticalKind::Card | CriticalKind::Fiscal => Some("PREEMPTED_BY_PAYMENT"),
        CriticalKind::ShiftClose => Some("PREEMPTED_BY_SHIFT_CLOSE"),
        CriticalKind::ZClose => Some("PREEMPTED_BY_Z"),
        _ => None,
    }
}
pub fn sql_error(error: &rusqlite::Error) -> Option<&'static str> {
    if let rusqlite::Error::SqlInputError { msg, .. } = error {
        if msg.starts_with("no such table:") {
            return Some("TABLE_MISSING");
        }
        if msg.starts_with("no such column:") || msg.contains("has no column named") {
            return Some("COLUMN_MISSING");
        }
    }
    match error {
        rusqlite::Error::SqliteFailure(_, Some(message))
            if message.starts_with("no such table:") =>
        {
            Some("TABLE_MISSING")
        }
        rusqlite::Error::SqliteFailure(_, Some(message))
            if message.starts_with("no such column:")
                || message.contains("has no column named") =>
        {
            Some("COLUMN_MISSING")
        }
        _ if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull) => {
            Some("INSUFFICIENT_FREE_DISK")
        }
        _ => None,
    }
}
pub fn reason(input: &Value) -> Result<Option<String>, String> {
    let Some(value) = input.get("reason") else {
        return Ok(None);
    };
    let text = value.as_str().ok_or("INVALID_INPUT")?.trim();
    if !(10..=200).contains(&text.chars().count()) || secrets(text) != text {
        return Err("INVALID_INPUT".into());
    }
    Ok(Some(text.into()))
}
pub fn personal(input: &Value) -> Result<bool, String> {
    let open = match input.get("include_personal_data") {
        None => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err("INVALID_INPUT".into()),
    };
    if open && reason(input)?.is_none() {
        return Err("INVALID_INPUT".into());
    }
    reason(input)?;
    Ok(open)
}
pub fn secret_key(key: &str) -> bool {
    let mut normalized = String::new();
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            normalized.push('_');
        }
        normalized.extend(c.to_lowercase());
    }
    let compact = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if [
        "password",
        "passwd",
        "passcode",
        "secret",
        "credential",
        "token",
        "authorization",
        "cookie",
        "cvv",
        "cvc",
        "pinhash",
        "pincode",
        "apikey",
        "privatekey",
        "publickey",
        "supportkey",
        "supportcode",
        "pairingcode",
        "cardnumber",
        "cardpan",
        "carddata",
    ]
    .iter()
    .any(|word| compact.contains(word))
        || ["pin", "pins", "key", "keys", "auth", "pan"].contains(&compact.as_str())
    {
        return true;
    }
    let words = normalized
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect::<Vec<_>>();
    [
        "password",
        "passwd",
        "passcode",
        "secret",
        "credential",
        "token",
        "authorization",
        "cookie",
        "cvv",
        "cvc",
        "pinhash",
        "pincode",
    ]
    .iter()
    .any(|s| normalized.contains(s))
        || words
            .iter()
            .any(|s| ["pin", "pins", "key", "keys", "auth"].contains(s))
        || [
            "apikey",
            "privatekey",
            "publickey",
            "supportcode",
            "pairingcode",
            "cardnumber",
            "cardpan",
            "carddata",
        ]
        .iter()
        .any(|s| normalized.replace('_', "").contains(s))
}
fn support_key_ranges(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let boundary = |byte: u8| !(byte.is_ascii_alphanumeric() || b"_[]-".contains(&byte));
    let mut ranges = Vec::new();
    for start in 0..bytes.len() {
        if start > 0 && !boundary(bytes[start - 1]) {
            continue;
        }
        let mut at = start;
        let mut valid = true;
        for digit in 0..8 {
            if digit == 4 && bytes.get(at).is_some_and(|c| *c == b'-' || *c == b' ') {
                at += 1;
            }
            if bytes.get(at).is_none_or(|c| !alphabet.contains(c)) {
                valid = false;
                break;
            }
            at += 1;
        }
        if valid && bytes.get(at).is_none_or(|c| boundary(*c)) {
            ranges.push((start, at));
        }
    }
    ranges
}
fn scrub_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let mut ranges = support_key_ranges(line);
    for (start, c) in lower.char_indices() {
        if !c.is_ascii_alphanumeric()
            || start > 0
                && (lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                    || lower.as_bytes()[start - 1] == b'_')
        {
            continue;
        }
        let end = lower[start..]
            .char_indices()
            .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '_')
            .map(|(n, _)| start + n)
            .unwrap_or(lower.len());
        let word = &lower[start..end];
        let tail =
            lower[end..].trim_start_matches(|c: char| c.is_whitespace() || c == '"' || c == '\'');
        let offset = line.len() - tail.len();
        let auth = ["bearer", "basic"].contains(&word) && !tail.is_empty();
        let assignment = secret_key(word)
            && (tail.starts_with(':') || tail.starts_with('=') || tail.starts_with("is "));
        if !auth && !assignment {
            continue;
        }
        let value_start = if auth {
            offset
        } else {
            offset + if tail.starts_with("is ") { 3 } else { 1 }
        };
        let value = line[value_start..].trim_start();
        let value_start = line.len() - value.len();
        let value_end = if auth {
            value
                .find(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\''))
                .map(|n| value_start + n)
                .unwrap_or(line.len())
        } else if let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') {
            let mut escaped = false;
            let mut close = None;
            for (n, c) in value.char_indices().skip(1) {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == quote {
                    close = Some(value_start + n + c.len_utf8());
                    break;
                }
            }
            close.unwrap_or(line.len())
        } else {
            value
                .find([',', ';', '}'])
                .map(|n| value_start + n)
                .unwrap_or(line.len())
        };
        ranges.push((start, value_end));
    }
    for scheme in ["https://", "http://"] {
        for (start, _) in lower.match_indices(scheme) {
            let rest = &line[start + scheme.len()..];
            let authority = rest
                .split(|c: char| c == '/' || c.is_whitespace())
                .next()
                .unwrap_or("");
            if authority
                .split_once('@')
                .is_some_and(|(userinfo, _)| userinfo.contains(':'))
            {
                let end = line[start..]
                    .find(char::is_whitespace)
                    .map(|n| start + n)
                    .unwrap_or(line.len());
                ranges.push((start, end));
            }
        }
    }
    let mut token_start = None;
    for (at, c) in line
        .char_indices()
        .chain(std::iter::once((line.len(), ' ')))
    {
        let separator = !c.is_ascii()
            || c.is_whitespace()
            || matches!(
                c,
                '"' | '\'' | ',' | ';' | '{' | '}' | '[' | ']' | '(' | ')'
            );
        if !separator {
            token_start.get_or_insert(at);
            continue;
        }
        if let Some(start) = token_start.take() {
            let word = &line[start..at];
            let encoded = word.starts_with("tss_")
                || word.starts_with("sk_live_")
                || word.starts_with("sk_test_")
                || word.starts_with("pk_live_")
                || word.starts_with("pk_test_")
                || word.starts_with("eyJ") && word.matches('.').count() == 2
                || word.len() >= 40
                    && word
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_+/=-".contains(&c))
                    && word.bytes().any(|c| c.is_ascii_digit())
                || word.contains("://")
                    && word
                        .split("://")
                        .nth(1)
                        .and_then(|s| s.split('/').next())
                        .is_some_and(|s| s.contains('@'));
            if encoded {
                ranges.push((start, at));
            }
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    let mut output = String::new();
    let mut cursor = 0;
    for (start, end) in merged {
        output.push_str(&line[cursor..start]);
        output.push_str(MARKER);
        cursor = end;
    }
    output.push_str(&line[cursor..]);
    output
}
/// Unconditional secret scrub, before bounds. Keep surrounding operational prose.
pub fn secrets(text: &str) -> String {
    if uuid::Uuid::parse_str(text).is_ok()
        || text.contains('_')
            && text.bytes().any(|c| c.is_ascii_uppercase())
            && text
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    {
        return text.into();
    }
    let text = super::redaction::scrub_pan(text);
    let mut pem = false;
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("-----begin ") {
                pem = true;
            }
            if pem {
                if lower.contains("-----end ") {
                    pem = false;
                }
                MARKER.into()
            } else {
                scrub_line(line)
            }
        })
        .collect::<Vec<String>>()
        .join("\n")
}
fn mask_known(text: &str, known: &[String]) -> String {
    let mut folded = String::new();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for (at, c) in text.char_indices() {
        for lower in c.to_lowercase() {
            // Simple case folding treats both Greek sigma forms alike.
            let lower = if lower == '\u{03c2}' {
                '\u{03c3}'
            } else {
                lower
            };
            folded.push(lower);
            for _ in 0..lower.len_utf8() {
                starts.push(at);
                ends.push(at + c.len_utf8());
            }
        }
    }
    let mut ranges = Vec::new();
    for person in known {
        let needle: String = person
            .chars()
            .flat_map(char::to_lowercase)
            .map(|c| if c == '\u{03c2}' { '\u{03c3}' } else { c })
            .collect();
        if needle.is_empty() {
            continue;
        }
        for (at, matched) in folded.match_indices(&needle) {
            ranges.push((starts[at], ends[at + matched.len() - 1]));
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    let mut output = String::new();
    let mut cursor = 0;
    for (start, end) in merged {
        output.push_str(&text[cursor..start]);
        output.push_str(MARKER);
        cursor = end;
    }
    output.push_str(&text[cursor..]);
    output
}
#[derive(Clone, Default)]
pub struct Policy {
    pub personal: bool,
    pub(super) known: Vec<String>,
}
impl Policy {
    pub fn load(conn: &Connection, personal: bool, permit: &SupportPermit) -> Result<Self, String> {
        let mut values = BTreeSet::new();
        if !personal {
            let start = Instant::now();
            let tables = super::collectors::rows(
                conn,
                "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )?;
            for table in tables {
                let Some(name) = table["name"].as_str() else {
                    continue;
                };
                let cols = super::collectors::rows(
                    conn,
                    &format!("PRAGMA table_info({})", replica::quote(name)),
                )?;
                for col in cols {
                    let Some(column) = col["name"].as_str() else {
                        continue;
                    };
                    // This index holds identities solely for substitution, never credentials.
                    if replica::classification(name, column) != "pii"
                        && !(name == "orders" && column == "delivery_notes")
                    {
                        continue;
                    }
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT DISTINCT {} FROM {}",
                            replica::quote(column),
                            replica::quote(name)
                        ))
                        .map_err(replica::sql_error)?;
                    let mut rows = stmt.query([]).map_err(replica::sql_error)?;
                    while let Some(row) = rows.next().map_err(replica::sql_error)? {
                        if permit.is_cancelled() {
                            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
                        }
                        if start.elapsed() > Duration::from_secs(5) || values.len() >= 100_000 {
                            return Err(error("HEALTH_OBSERVATION_MISSING"));
                        }
                        if let Ok(value) = row.get::<_, String>(0) {
                            if !value.trim().is_empty() && value.len() <= 8192 {
                                values.insert(value);
                            }
                        }
                    }
                }
            }
        }
        let mut known: Vec<_> = values.into_iter().collect();
        known.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Ok(Self { personal, known })
    }
    pub fn string(&self, text: &str) -> String {
        if text == MARKER {
            return MARKER.into();
        }
        if text.len() <= 256 * 1024
            && (text.trim_start().starts_with('{') || text.trim_start().starts_with('['))
        {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                return self
                    .record_rows(value, 50)
                    .to_string()
                    .chars()
                    .take(1024)
                    .collect();
            }
        }
        let mut clean = secrets(text);
        if !self.personal {
            clean = mask_known(&clean, &self.known);
            clean =
                crate::diagnostics::scrub_and_bound_text(&clean, clean.chars().count().max(1024));
        }
        clean.chars().take(1024).collect()
    }
    pub fn text(&self, text: &str) -> Value {
        json!({"kind":"untrusted_till_data","value":self.string(text)})
    }
    pub fn record(&self, value: Value) -> Value {
        self.record_rows(value, 500)
    }
    pub fn record_rows(&self, value: Value, rows: usize) -> Value {
        self.walk(value, "", 0, rows)
    }
    fn walk(&self, value: Value, parent: &str, depth: usize, max_rows: usize) -> Value {
        if depth > 32 {
            return json!(MARKER);
        }
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .take(10000)
                    .map(|(key, value)| {
                        let lower = key.to_ascii_lowercase();
                        let compact = key
                            .chars()
                            .filter(|c| c.is_ascii_alphanumeric())
                            .collect::<String>()
                            .to_ascii_lowercase();
                        let personal = [
                            "staffid",
                            "cashierid",
                            "driverid",
                            "waiterid",
                            "employeeid",
                            "operatorid",
                            "managerid",
                        ]
                        .contains(&compact.as_str())
                            || compact.contains("email")
                            || compact.contains("phone")
                            || compact.contains("address")
                                && value
                                    .as_str()
                                    .is_none_or(|s| s.parse::<std::net::Ipv4Addr>().is_err())
                            || compact == "deliverynotes"
                            || compact.strip_suffix("name").is_some_and(|prefix| {
                                [
                                    "customer",
                                    "staff",
                                    "driver",
                                    "cashier",
                                    "waiter",
                                    "guest",
                                    "contact",
                                    "first",
                                    "last",
                                    "full",
                                    "given",
                                    "family",
                                    "middle",
                                    "user",
                                    "employee",
                                    "recipient",
                                    "cardholder",
                                    "holder",
                                    "member",
                                    "person",
                                    "manager",
                                    "operator",
                                    "owner",
                                    "createdby",
                                    "updatedby",
                                    "checkedinby",
                                ]
                                .contains(&prefix)
                            })
                            || ["name", "fullname", "displayname"].contains(&compact.as_str())
                                && [
                                    "customer",
                                    "staff",
                                    "driver",
                                    "guest",
                                    "contact",
                                    "employee",
                                    "recipient",
                                    "member",
                                    "person",
                                    "operator",
                                ]
                                .iter()
                                .any(|p| parent.to_ascii_lowercase().contains(p));
                        let clean = if compact == "credentials"
                            && value
                                .as_object()
                                .is_some_and(|m| m.values().all(Value::is_boolean))
                        {
                            value
                        } else if secret_key(&key) && !value.is_boolean() && !value.is_null() {
                            json!(MARKER)
                        } else if !self.personal
                            && personal
                            && !value.is_null()
                            && !value.is_boolean()
                        {
                            json!(MARKER)
                        } else if lower.ends_with("sha256")
                            && value.as_str().is_some_and(|s| {
                                s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
                            })
                        {
                            value
                        } else {
                            self.walk(
                                value,
                                if key == "value" { parent } else { &key },
                                depth + 1,
                                max_rows,
                            )
                        };
                        let safe_key = if key.chars().any(char::is_control)
                            || key.contains('=')
                            || super::redaction::scrub_pan(&key) != key
                            || key.starts_with("tss_")
                            || key.starts_with("sk_live_")
                            || key.starts_with("sk_test_")
                        {
                            MARKER.into()
                        } else {
                            key
                        };
                        (safe_key, clean)
                    })
                    .collect(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .take(max_rows)
                    .map(|v| self.walk(v, parent, depth + 1, max_rows))
                    .collect(),
            ),
            Value::String(text) => {
                // A person's name can equal "pending" or "about". Substitute
                // identities in evidence prose, preserving validated wire enums.
                let protocol = parent == "staff" && text == "redacted"
                    || parent == "kind" && text == "untrusted_till_data"
                    || parent == "app_version" && text == env!("CARGO_PKG_VERSION")
                    || parent == "failure_detail_code" && DETAILS.contains(&text.as_str())
                    || [
                        "observation_time",
                        "replica_taken_at",
                        "opened_at",
                        "closed_at",
                        "generated_at",
                        "at",
                    ]
                    .contains(&parent)
                        && chrono::DateTime::parse_from_rfc3339(&text).is_ok()
                    || (parent == "status"
                        || parent.ends_with("_status")
                        || parent == "health_state")
                        && [
                            "pending",
                            "processing",
                            "failed",
                            "conflict",
                            "set_aside",
                            "open",
                            "closed",
                            "active",
                            "ok",
                            "partial",
                            "not_collected",
                            "unavailable",
                            "healthy",
                            "issues",
                            "stale",
                        ]
                        .contains(&text.as_str())
                    || parent == "level"
                        && ["debug", "info", "warn", "error"].contains(&text.as_str())
                    || parent == "operation"
                        && ["insert", "update", "delete"].contains(&text.as_str())
                    || parent == "reason"
                        && ["rows", "bytes", "cell", "lines", "results", "deadline"]
                            .contains(&text.as_str())
                    || parent == "section"
                        && super::contracts::shared().payload_schemas["till_diagnostics_bundle"]
                            ["properties"]["section"]["enum"]
                            .as_array()
                            .is_some_and(|v| v.contains(&json!(text)));
                json!(if protocol {
                    secrets(&text)
                } else {
                    self.string(&text)
                })
            }
            Value::Number(n) => {
                let value = n.to_string();
                if super::redaction::scrub_pan(&value) != value {
                    json!(MARKER)
                } else {
                    json!(n)
                }
            }
            other => other,
        }
    }
}
pub fn mark_unavailable(value: &mut Value) {
    fn unavailable(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(k, v)| {
                (k == "status" || k.ends_with("_status") || k == "health_state")
                    && v == "unavailable"
                    || unavailable(v)
            }),
            Value::Array(list) => list.iter().any(unavailable),
            _ => false,
        }
    }
    if value.get("failure_detail_code").is_none() && unavailable(value) {
        value["failure_detail_code"] = json!("HEALTH_OBSERVATION_MISSING");
    }
}
fn presented_slot() -> &'static std::sync::Mutex<Option<String>> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<String>>> = std::sync::OnceLock::new();
    SLOT.get_or_init(Default::default)
}
pub fn presented(id: &str) {
    if let Ok(mut slot) = presented_slot().lock() {
        *slot = Some(id.into());
    }
}
pub fn wait_presented(id: &str, permit: &SupportPermit) -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if presented_slot()
            .lock()
            .is_ok_and(|s| s.as_deref() == Some(id))
        {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err("TILL_PAUSED".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub fn journal(path: &Path, c: &Command, details: Value) -> Result<(), String> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| "INTERNAL_ERROR")?;
    conn.busy_timeout(Duration::from_millis(100))
        .map_err(|_| "INTERNAL_ERROR")?;
    let tx = super::db::transaction(&conn).map_err(|_| "INTERNAL_ERROR")?;
    let (actor, encoded): (String, Option<String>) = tx
        .query_row(
            "SELECT actor_label,scope_json FROM support_evidence_sessions WHERE session_id=?1",
            [&c.session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| error("HEALTH_OBSERVATION_MISSING"))?;
    let scope: Value = if let Some(encoded) = encoded {
        serde_json::from_str(&encoded).map_err(|_| "INTERNAL_ERROR")?
    } else {
        // Adoption can occur while payment owns the gate. Resolve only the
        // non-secret identity mirrors once the gate permits, then cache them.
        // Warm cache/log-only evidence never needs a business connection.
        let permit = super::critical_op::global()
            .try_begin_support(false, None)
            .map_err(|_| "PREEMPTED_BY_CRITICAL_OPERATION")?;
        let conn = replica::read_connection(
            &path.with_file_name("pos.db"),
            &permit,
            Instant::now() + Duration::from_secs(1),
        )?;
        let scope = super::identity::local(&conn)?;
        let value = json!({"organization_id":scope.organization_id,"branch_id":scope.branch_id,"terminal_id":scope.terminal_id});
        tx.execute("UPDATE support_evidence_sessions SET scope_json=?1 WHERE session_id=?2 AND scope_json IS NULL",params![value.to_string(),c.session_id]).map_err(|_|"INTERNAL_ERROR")?;
        value
    };
    let at = chrono::Utc::now().to_rfc3339();
    let seq = super::audit_local::append(
        &tx,
        &super::audit_local::AuditEntry {
            terminal_seq: 0,
            session_id: Some(c.session_id.clone()),
            command_id: Some(c.command_id.clone()),
            phase: "started".into(),
            status: None,
            outcome: None,
            input_sha256: Some(super::contracts::payload_hash(&details)),
            result_sha256: None,
            created_at: at.clone(),
        },
    )
    .map_err(|_| "INTERNAL_ERROR")?;
    tx.execute("INSERT INTO support_evidence_events(terminal_seq,session_id,command_id,command_sequence,organization_id,branch_id,terminal_id,actor_label,details_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![seq,c.session_id,c.command_id,c.sequence,scope["organization_id"].as_str().ok_or("INTERNAL_ERROR")?,scope["branch_id"].as_str().ok_or("INTERNAL_ERROR")?,scope["terminal_id"].as_str().ok_or("INTERNAL_ERROR")?,actor,details.to_string(),at]).map_err(|_| "INTERNAL_ERROR")?;
    tx.commit().map_err(|_| "INTERNAL_ERROR".into())
}
