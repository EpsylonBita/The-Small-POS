//! Lossy, bounded support projection of existing runtime logs. No raw message,
//! path, stack, identifier, or arbitrary field is included in the returned JSON.
//! Shared contract: shared/pos/health/runtime-log-events.ts and its fixtures.

// Database-lock lines (database_lock.rs, Tomikro 20/10/2026) keep their fixed
// code and their lock-site labels, from these fixed lists only. Equal to
// shared/pos/health/__fixtures__/runtime-log-db-lock.json (tests compare).
use crate::database_lock::{EVENT_CODES as DB_LOCK_EVENT_CODES, LOCK_LABELS as DB_LOCK_LABELS};
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub(super) const MAX_FILES: usize = 3;
// Until 19/10/2026 a file gave 256 KiB and the export 512 KiB.
const MAX_BYTES_PER_FILE: u64 = 4 * 1024 * 1024;
const MAX_BYTES_TOTAL: u64 = 8 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8192;
const MAX_EVENTS: usize = 50;
const HISTORY_HOURS: i64 = 48;
const MAX_HISTORY_ROWS: usize = 40;
/// A file is read newest chunk first, so the budget drops its oldest lines.
const READ_CHUNK_BYTES: u64 = 256 * 1024;
const HOUR_MS: i64 = 3_600_000;
const LEVELS: [&str; 3] = ["error", "warn", "info"];

pub(super) fn limits() -> Value {
    json!({"maxFiles": MAX_FILES, "maxBytesPerFile": MAX_BYTES_PER_FILE,
        "maxBytesTotal": MAX_BYTES_TOTAL, "maxLineBytes": MAX_LINE_BYTES,
        "maxEventsPerLevel": MAX_EVENTS, "historyHours": HISTORY_HOURS,
        "maxHistoryRows": MAX_HISTORY_ROWS})
}

fn hour_key(hour_ms: i64) -> String {
    Utc.timestamp_millis_opt(hour_ms)
        .single()
        .map(|hour| hour.format("%Y-%m-%dT%H:00:00Z").to_string())
        .unwrap_or_default()
}

fn time_json(time: &Option<(i64, String)>) -> Value {
    time.as_ref()
        .map_or(Value::Null, |(_, text)| Value::String(text.clone()))
}

struct HistoryRow {
    count: u64,
    first: (i64, String),
    last: (i64, String),
    hours: BTreeMap<i64, u64>,
}

struct FileCoverage {
    status: &'static str,
    stopped_by: Option<&'static str>,
    oldest: Option<(i64, String)>,
    newest: Option<(i64, String)>,
    bytes_read: u64,
    bytes_skipped: u64,
}

/// Collects one runtime_logs.json: counts and status in `snapshot`, the
/// newest events per level, and the per-hour history of failure codes.
struct Collector {
    snapshot: Value,
    events: [Vec<(i64, Value)>; 3],
    oldest: Option<(i64, String)>,
    newest: Option<(i64, String)>,
    window_start: i64,
    window_end: i64,
    rows: BTreeMap<(String, String), HistoryRow>,
    lines_counted: u64,
    lines_before_window: u64,
    lines_after_window: u64,
    files: Vec<FileCoverage>,
    file_open: bool,
    read_error: bool,
}

impl Collector {
    fn new(captured_at: DateTime<Utc>) -> Self {
        // Whole UTC hours: the hour of capture and the 47 before it.
        let window_end = (captured_at.timestamp_millis().div_euclid(HOUR_MS) + 1) * HOUR_MS;
        Self {
            snapshot: json!({
                "format": "thesmall-pos-runtime-events-v1", "status": "ok",
                "capturedAt": captured_at.to_rfc3339(), "limits": limits(),
                "counts": {"filesFound": 0, "filesRead": 0, "filesOmitted": 0,
                    "filesUnreadable": 0, "bytesRead": 0, "linesScanned": 0,
                    "linesMalformed": 0, "linesOversized": 0, "linesPartial": 0,
                    "linesExcludedRepair": 0, "eventsOmitted": 0},
                "truncated": false
            }),
            events: [Vec::new(), Vec::new(), Vec::new()],
            oldest: None,
            newest: None,
            window_start: window_end - HISTORY_HOURS * HOUR_MS,
            window_end,
            rows: BTreeMap::new(),
            lines_counted: 0,
            lines_before_window: 0,
            lines_after_window: 0,
            files: Vec::new(),
            file_open: false,
            read_error: false,
        }
    }

    fn increment(&mut self, key: &str, amount: u64) {
        let count = self.snapshot["counts"][key].as_u64().unwrap_or(0);
        self.snapshot["counts"][key] = json!(count.saturating_add(amount));
    }

    fn count(&self, key: &str) -> u64 {
        self.snapshot["counts"][key].as_u64().unwrap_or(0)
    }

    fn truncate(&mut self) {
        self.snapshot["truncated"] = json!(true);
    }

    fn not_collected(mut self, status: &str, reason: &str) -> Value {
        self.snapshot["status"] = json!(status);
        self.snapshot["reasonCode"] = json!(reason);
        self.finish()
    }

    /// Lines added from now on belong to the next older file.
    fn begin_file(&mut self) {
        self.files.push(FileCoverage {
            status: "complete",
            stopped_by: None,
            oldest: None,
            newest: None,
            bytes_read: 0,
            bytes_skipped: 0,
        });
        self.file_open = true;
    }

    fn end_file(
        &mut self,
        status: &'static str,
        stopped_by: Option<&'static str>,
        bytes_read: u64,
        bytes_skipped: u64,
    ) {
        if let Some(file) = self.files.last_mut().filter(|_| self.file_open) {
            file.status = status;
            file.stopped_by = stopped_by;
            file.bytes_read = bytes_read;
            file.bytes_skipped = bytes_skipped;
        }
        self.file_open = false;
    }

    fn partial_line(&mut self) {
        self.increment("linesPartial", 1);
        self.truncate();
    }

    fn oversized_line(&mut self) {
        self.increment("linesScanned", 1);
        self.increment("linesOversized", 1);
        self.truncate();
    }

    fn add_bytes(&mut self, line: &[u8]) {
        match std::str::from_utf8(line) {
            Ok(line) => self.add_line(line.trim_end_matches('\r')),
            Err(_) => {
                self.increment("linesScanned", 1);
                self.increment("linesMalformed", 1);
            }
        }
    }

    fn add_line(&mut self, line: &str) {
        self.increment("linesScanned", 1);
        let event = match project_line(line) {
            Ok(event) => event,
            Err("excludedRepair") => {
                self.increment("linesExcludedRepair", 1);
                return;
            }
            Err("oversized") => {
                self.increment("linesOversized", 1);
                self.truncate();
                return;
            }
            Err(_) => {
                self.increment("linesMalformed", 1);
                return;
            }
        };
        let timestamp = event["timestamp"].as_str().unwrap_or_default().to_owned();
        let Ok(time) = DateTime::parse_from_rfc3339(&timestamp).map(|time| time.timestamp_millis())
        else {
            self.increment("linesMalformed", 1);
            return;
        };
        let level = event["level"].as_str().unwrap_or_default().to_owned();
        let component = event["component"].as_str().unwrap_or_default().to_owned();
        let code = event["errorCode"]
            .as_str()
            .or_else(|| event["eventCode"].as_str())
            .unwrap_or_default()
            .to_owned();
        let has_error_code = event.get("errorCode").is_some();

        // After every event of the same time, as a stable sort of the
        // appended row would; the oldest row goes past the cap.
        let index = LEVELS.iter().position(|name| *name == level).unwrap_or(0);
        let rows = &mut self.events[index];
        rows.insert(rows.partition_point(|(at, _)| *at <= time), (time, event));
        if rows.len() > MAX_EVENTS {
            rows.remove(0);
            self.increment("eventsOmitted", 1);
            self.truncate();
        }
        for (slot, older) in [(&mut self.oldest, true), (&mut self.newest, false)] {
            if slot
                .as_ref()
                .map_or(true, |(at, _)| if older { time < *at } else { time > *at })
            {
                *slot = Some((time, timestamp.clone()));
            }
        }
        if let Some(file) = self.files.last_mut().filter(|_| self.file_open) {
            for (slot, older) in [(&mut file.oldest, true), (&mut file.newest, false)] {
                if slot
                    .as_ref()
                    .map_or(true, |(at, _)| if older { time < *at } else { time > *at })
                {
                    *slot = Some((time, timestamp.clone()));
                }
            }
        }

        // Every warn/error line, and every line with an error code.
        if !has_error_code && level == "info" {
            return;
        }
        if time < self.window_start {
            self.lines_before_window += 1;
            return;
        }
        if time >= self.window_end {
            self.lines_after_window += 1;
            return;
        }
        self.lines_counted += 1;
        let row = self
            .rows
            .entry((component, code))
            .or_insert_with(|| HistoryRow {
                count: 0,
                first: (time, timestamp.clone()),
                last: (time, timestamp.clone()),
                hours: BTreeMap::new(),
            });
        row.count += 1;
        if time < row.first.0 {
            row.first = (time, timestamp.clone());
        }
        if time > row.last.0 {
            row.last = (time, timestamp);
        }
        *row.hours
            .entry(time.div_euclid(HOUR_MS) * HOUR_MS)
            .or_insert(0) += 1;
    }

    fn finish(mut self) -> Value {
        // Rows of a listed or checkout code first, then the most recent.
        let mut rows: Vec<((String, String), HistoryRow)> =
            std::mem::take(&mut self.rows).into_iter().collect();
        rows.sort_by(|(a_key, a), (b_key, b)| {
            is_specific_code(&b_key.1)
                .cmp(&is_specific_code(&a_key.1))
                .then(b.last.0.cmp(&a.last.0))
                .then(b.count.cmp(&a.count))
                .then(a_key.0.cmp(&b_key.0))
                .then(a_key.1.cmp(&b_key.1))
        });
        let dropped = rows.split_off(MAX_HISTORY_ROWS.min(rows.len()));
        if !dropped.is_empty() {
            self.truncate();
        }
        // Newest file first: the covered range ends at the first gap.
        let mut covered: Option<(i64, String)> = None;
        for file in &self.files {
            if file.status == "unreadable" {
                break;
            }
            if let Some((time, at)) = &file.oldest {
                if covered.as_ref().map_or(true, |(current, _)| time < current) {
                    covered = Some((*time, at.clone()));
                }
            }
            if file.status != "complete" {
                break;
            }
        }
        let complete = covered
            .as_ref()
            .is_some_and(|(time, _)| *time <= self.window_start)
            && self.count("filesUnreadable") == 0;
        let files: Vec<Value> = self
            .files
            .iter()
            .map(|file| {
                let mut entry = json!({"status": file.status,
                    "oldestAt": time_json(&file.oldest), "newestAt": time_json(&file.newest),
                    "bytesRead": file.bytes_read, "bytesSkipped": file.bytes_skipped});
                if let Some(stopped_by) = file.stopped_by {
                    entry["stoppedBy"] = json!(stopped_by);
                }
                entry
            })
            .collect();
        self.snapshot["coverage"] = json!({"oldestEventAt": time_json(&self.oldest),
            "newestEventAt": time_json(&self.newest), "files": files});
        let events: Map<String, Value> = LEVELS
            .iter()
            .zip(std::mem::take(&mut self.events))
            .map(|(level, rows)| {
                let rows = rows.into_iter().map(|(_, event)| event).collect();
                (level.to_string(), Value::Array(rows))
            })
            .collect();
        self.snapshot["events"] = Value::Object(events);
        let history_rows: Vec<Value> = rows
            .into_iter()
            .map(|((component, code), row)| {
                let hours: Map<String, Value> = row
                    .hours
                    .into_iter()
                    .map(|(hour, count)| (hour_key(hour), json!(count)))
                    .collect();
                json!({"component": component, "code": code, "count": row.count,
                    "firstAt": row.first.1, "lastAt": row.last.1, "hours": hours})
            })
            .collect();
        self.snapshot["history"] = json!({
            "windowHours": HISTORY_HOURS,
            "windowStart": hour_key(self.window_start),
            "windowEnd": hour_key(self.window_end),
            "coveredFrom": time_json(&covered),
            "complete": complete,
            "linesCounted": self.lines_counted,
            "linesBeforeWindow": self.lines_before_window,
            "linesAfterWindow": self.lines_after_window,
            "rowsOmitted": dropped.len(),
            "linesInOmittedRows": dropped.iter().map(|(_, row)| row.count).sum::<u64>(),
            "rows": history_rows,
        });
        self.snapshot
    }
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
    collect_at(root, enabled, Utc::now())
}

fn collect_at(root: &Path, enabled: bool, captured_at: DateTime<Utc>) -> Value {
    let mut collector = Collector::new(captured_at);
    if !enabled {
        return collector.not_collected("not_collected", "disabled");
    }
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return collector.not_collected("not_collected", "logs_missing");
        }
        Err(_) => {
            collector.increment("filesUnreadable", 1);
            return collector.not_collected("unavailable", "logs_unreadable");
        }
        Ok(_) => {}
    }
    let entries = if trusted_directory(root) {
        fs::read_dir(root).ok()
    } else {
        None
    };
    let Some(entries) = entries else {
        collector.increment("filesUnreadable", 1);
        return collector.not_collected("unavailable", "logs_unreadable");
    };
    let mut files = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            collector.increment("filesUnreadable", 1);
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| trusted_name(name)) else {
            continue;
        };
        collector.increment("filesFound", 1);
        let metadata = fs::symlink_metadata(entry.path());
        match metadata {
            Ok(metadata) if metadata.is_file() && !is_link(&metadata) => files.push((
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                name.to_owned(),
                entry.path(),
            )),
            _ => collector.increment("filesUnreadable", 1),
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut remaining = MAX_BYTES_TOTAL;
    for (index, (_, _, path)) in files.iter().enumerate() {
        if index >= MAX_FILES || remaining == 0 {
            collector.increment("filesOmitted", 1);
            collector.truncate();
            continue;
        }
        collector.begin_file();
        let opened = open_trusted_file(path, root)
            .and_then(|file| file.metadata().ok().map(|metadata| (file, metadata.len())));
        let Some((mut file, size)) = opened else {
            collector.increment("filesUnreadable", 1);
            collector.end_file("unreadable", None, 0, 0);
            continue;
        };
        let allowance = size.min(remaining).min(MAX_BYTES_PER_FILE);
        // Reserve before attempting I/O, even if a read returns only a prefix
        // then fails. Failed reads cannot buy more aggregate budget.
        remaining -= allowance;
        let (bytes_read, read_error) =
            read_newest_first(&mut collector, &mut file, size, allowance);
        collector.increment("bytesRead", bytes_read);
        let skipped = size.saturating_sub(bytes_read);
        if bytes_read == 0 && size > 0 {
            collector.increment("filesUnreadable", 1);
            collector.end_file("unreadable", None, 0, size);
            continue;
        }
        collector.increment("filesRead", 1);
        let stopped_by = if read_error {
            collector.read_error = true;
            Some("read_error")
        } else if skipped > 0 {
            Some("budget")
        } else {
            None
        };
        if stopped_by.is_some() {
            collector.truncate();
        }
        let status = if stopped_by.is_some() {
            "partial"
        } else {
            "complete"
        };
        collector.end_file(status, stopped_by, bytes_read, skipped);
    }
    let unreadable = collector.count("filesUnreadable");
    let read = collector.count("filesRead");
    if unreadable > 0 || collector.read_error {
        collector.snapshot["status"] = json!(if read > 0 { "partial" } else { "unavailable" });
        collector.snapshot["reasonCode"] = json!("logs_unreadable");
    } else if files.is_empty() {
        collector.snapshot["status"] = json!("not_collected");
        collector.snapshot["reasonCode"] = json!("logs_missing");
    } else if collector.snapshot["truncated"] == true {
        collector.snapshot["status"] = json!("partial");
    }
    let mut snapshot = collector.finish();
    // Dropped history rows truncate the snapshot only at finish.
    if snapshot["truncated"] == true && snapshot["status"] == "ok" {
        snapshot["status"] = json!("partial");
    }
    snapshot
}

/// Reads the newest `allowance` bytes of a file, newest chunk first, and
/// passes its complete lines to the collector. Returns the bytes read and
/// whether a read failed or came back short (a file cut or rotated meanwhile).
fn read_newest_first(
    collector: &mut Collector,
    file: &mut File,
    size: u64,
    allowance: u64,
) -> (u64, bool) {
    let start = size - allowance;
    let mut position = size;
    let mut bytes_read = 0;
    let mut lines = LineJoiner::default();
    let mut buffer = Vec::new();
    while position > start {
        let chunk_start = position.saturating_sub(READ_CHUNK_BYTES).max(start);
        let wanted = position - chunk_start;
        buffer.clear();
        let result = file
            .seek(SeekFrom::Start(chunk_start))
            .and_then(|_| file.by_ref().take(wanted).read_to_end(&mut buffer));
        bytes_read += buffer.len() as u64;
        if !matches!(result, Ok(read) if read as u64 == wanted) {
            // What came back is not adjacent to the lines already read.
            lines.abandon(collector);
            if !buffer.is_empty() {
                let mut isolated = LineJoiner::default();
                isolated.chunk(collector, &buffer);
                isolated.finish(collector, chunk_start == 0);
            }
            return (bytes_read, true);
        }
        lines.chunk(collector, &buffer);
        position = chunk_start;
    }
    lines.finish(collector, start == 0);
    (bytes_read, false)
}

/// Joins lines across chunks read from the end of a file towards its start.
struct LineJoiner {
    /// The start of the oldest line seen so far, which began in an older chunk.
    carry: Vec<u8>,
    carry_oversized: bool,
    /// No newline seen yet: `carry` is the file's unterminated last line.
    at_end: bool,
}

impl Default for LineJoiner {
    fn default() -> Self {
        Self {
            carry: Vec::new(),
            carry_oversized: false,
            at_end: true,
        }
    }
}

impl LineJoiner {
    fn prepend(&mut self, bytes: &[u8]) {
        if self.carry_oversized {
            return;
        }
        // One byte over the limit leaves room for a trailing '\r'.
        if self.carry.len() + bytes.len() > MAX_LINE_BYTES + 1 {
            self.carry = Vec::new();
            self.carry_oversized = true;
            return;
        }
        self.carry.splice(0..0, bytes.iter().copied());
    }

    fn chunk(&mut self, collector: &mut Collector, chunk: &[u8]) {
        let Some(first) = chunk.iter().position(|byte| *byte == b'\n') else {
            self.prepend(chunk);
            return;
        };
        let last = chunk
            .iter()
            .rposition(|byte| *byte == b'\n')
            .unwrap_or(first);
        if first < last {
            for line in chunk[first + 1..last].split(|byte| *byte == b'\n') {
                collector.add_bytes(line);
            }
        }
        let tail = &chunk[last + 1..];
        if self.at_end {
            // A last line still being written.
            if !tail.is_empty() || !self.carry.is_empty() || self.carry_oversized {
                collector.partial_line();
            }
            self.at_end = false;
        } else if self.carry_oversized || tail.len() + self.carry.len() > MAX_LINE_BYTES + 1 {
            collector.oversized_line();
        } else {
            let mut line = tail.to_vec();
            line.extend_from_slice(&self.carry);
            collector.add_bytes(&line);
        }
        self.carry = Vec::new();
        self.carry_oversized = false;
        self.prepend(&chunk[..first]);
    }

    /// The carried fragment's start was never read.
    fn abandon(&mut self, collector: &mut Collector) {
        if !self.at_end || !self.carry.is_empty() || self.carry_oversized {
            collector.partial_line();
        }
        *self = Self::default();
    }

    fn finish(self, collector: &mut Collector, at_file_start: bool) {
        if self.at_end {
            if !at_file_start || !self.carry.is_empty() || self.carry_oversized {
                collector.partial_line();
            }
        } else if !at_file_start {
            // Conservative: the read may have started inside a line.
            collector.partial_line();
        } else if self.carry_oversized {
            collector.oversized_line();
        } else {
            collector.add_bytes(&self.carry);
        }
    }
}

fn component(target: &str) -> &'static str {
    let target = target.to_ascii_lowercase();
    for (patterns, component) in [
        (&["checkout"][..], "checkout"),
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

// A checkout code is `checkout_<operation>_<class>` from these fixed lists.
// Keep both aligned with shared/pos/health/runtime-log-events.
// `edit`: an order edit refused or adopted from the server (Tomikro 25-26/10/2026).
const CHECKOUT_OPERATIONS: &[&str] = &["save", "read", "delete", "create", "edit"];
const CHECKOUT_FAILURE_CLASSES: &[&str] = &[
    "scope_transition",
    "reset_pending",
    "maintenance_pending",
    "scope_changed",
    "version_changed",
    "target_cancelled",
    "invalid",
    "storage_busy",
    "storage_full",
    "storage_readonly",
    "storage_io",
    "unclassified",
    "storage_unavailable",
    "in_progress",
    "fiscal_not_approved",
    "card_confirmation_refused",
    "payment_not_saved",
    "shift_required",
    "currency_unavailable",
    "refused",
    "adopted",
];

fn is_checkout_event_code(value: &str) -> bool {
    value
        .strip_prefix("checkout_")
        .and_then(|rest| {
            CHECKOUT_OPERATIONS
                .iter()
                .find_map(|operation| rest.strip_prefix(operation)?.strip_prefix('_'))
        })
        .is_some_and(|class| CHECKOUT_FAILURE_CLASSES.contains(&class))
}

/// Native refusal, sync, auth and fiscal codes the POS apps emit as
/// constants, sorted. Equal to RUNTIME_ERROR_CODES in
/// shared/pos/health/runtime-log-events.ts and to
/// shared/pos/health/__fixtures__/runtime-log-error-codes.json (tests compare).
pub(crate) const RUNTIME_ERROR_CODES: &[&str] = &[
    "BOX_DECISION_EXPIRED",
    "BOX_DECISION_MANUAL_CHECK",
    "CANCELLATION_PAYMENT_CHANGED",
    "CANCELLATION_REQUEST_CONFLICT",
    "CANONICAL_RECEIPT_IDENTITY_CHANGED",
    "CARD_CONFIRMATION_REFUSED",
    "CASHIER_REQUIRED",
    "CHECKOUT_DRAFT_SCOPE_CHANGED",
    "CHECKOUT_IN_PROGRESS",
    "CHECKOUT_STORAGE_UNVERIFIED",
    "EDIT_CANONICAL_ORIGINAL_CHANGED",
    "EDIT_CANONICAL_PREFLIGHT_REQUIRED",
    "EDIT_CANONICAL_PRODUCT_CHANGED",
    "EDIT_CANONICAL_QUOTE_CHANGED",
    "EDIT_CANONICAL_QUOTE_REQUIRED",
    "EDIT_CANONICAL_SNAPSHOT_INVALID",
    "EDIT_DUPLICATE_CANONICAL_ITEM",
    "EDIT_ORDER_REFRESHED",
    "EDIT_ORIGINAL_ITEMS_UNAVAILABLE",
    "EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED",
    "EDIT_ORIGINAL_PROVIDER_REFUND_REQUIRED",
    "EDIT_PREVIOUS_SETTLEMENT_SYNC_REQUIRED",
    "EDIT_RECONCILIATION_DECISION_REQUIRED",
    "EDIT_RECONCILIATION_NOT_PROVEN",
    "EDIT_RECONCILIATION_REASON_REQUIRED",
    "EDIT_REFUSAL_UNCLASSIFIED",
    "EDIT_SETTLEMENT_ACK_CANONICAL_SNAPSHOT_REQUIRED",
    "EDIT_SETTLEMENT_ADJUSTMENT_ID_REQUIRED",
    "EDIT_SETTLEMENT_CHILD_OUTBOX_REQUIRED",
    "EDIT_SETTLEMENT_CLOSED",
    "EDIT_SETTLEMENT_EXACT_ACTION_REQUIRED",
    "EDIT_SETTLEMENT_ID_REQUIRED",
    "EDIT_SETTLEMENT_METHOD_UNAVAILABLE",
    "EDIT_SETTLEMENT_NOT_APPLIED",
    "EDIT_SETTLEMENT_ORDER_NOT_EDITABLE",
    "EDIT_SETTLEMENT_SCOPE_MISMATCH",
    "EDIT_SETTLEMENT_VERSION_CHANGED",
    "EDIT_SETTLEMENT_VERSION_REQUIRED",
    "EDIT_TOO_MANY_LINES",
    "FISCAL_ATTEMPT_NOT_DURABLE",
    "FISCAL_CHECKOUT_NOT_APPROVED",
    "FISCAL_CLOSE_BLOCKED",
    "FISCAL_PAYLOAD_CHANGED",
    "FISCAL_PAYLOAD_INVALID",
    "FISCAL_SUBMISSION_CONFLICT",
    "FOLIO_CHARGE_RECONCILIATION_REQUIRED",
    "FOLIO_SETTLEMENT_IMMUTABLE",
    "HOSTED_SESSION_EXPIRED",
    "HTTP_ERROR",
    "LEGACY_EDIT_REVIEW_REQUIRED",
    "MISSING_FISCAL_DATA",
    "ORDER_CURRENCY_UNAVAILABLE",
    "ORDER_EDIT_SETTLEMENT_PENDING",
    "ORDER_EDIT_SETTLEMENT_REQUIRED",
    "ORDER_HAS_PAYMENTS",
    "ORDER_HAS_PAYMENT_RECORDS",
    "ORDER_HEADER_CORRECTION",
    "ORDER_HEADER_SYNC_REQUIRED",
    "ORDER_PAYMENT_NOT_RECORDED",
    "ORDER_VERSION_CONFLICT",
    "ORIGINAL_CURRENCY_UNAVAILABLE",
    "PAID_EDIT_ACKNOWLEDGEMENT_REQUIRED",
    "PAID_EDIT_DRAWER_UNAVAILABLE",
    "PAID_EDIT_EXACT_ACTION_REQUIRED",
    "PAID_EDIT_ITEMS_INVALID",
    "PAID_EDIT_JOURNAL_SCOPE_CHANGED",
    "PAID_EDIT_JOURNAL_UNREADABLE",
    "PAID_EDIT_LEDGER_CHANGED",
    "PAID_EDIT_LEDGER_INVALID",
    "PAID_EDIT_LOCAL_CHECK_FAILED",
    "PAID_EDIT_METHOD_UNAVAILABLE",
    "PAID_EDIT_MIRROR_CONFLICT",
    "PAID_EDIT_MIRROR_PROOF_REQUIRED",
    "PAID_EDIT_NON_APPLICATION_UNPROVEN",
    "PAID_EDIT_ORIGINAL_ATTEMPT_REQUIRED",
    "PAID_EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED",
    "PAID_EDIT_REASON_REQUIRED",
    "PAID_EDIT_RECONCILIATION_REQUIRED",
    "PAID_EDIT_REJECTED",
    "PAID_EDIT_SCOPED_WORKFLOW_REQUIRED",
    "PAID_EDIT_SHIFT_CHANGED",
    "PAID_EDIT_SNAPSHOT_CHANGED",
    "PAID_EDIT_SUPERSEDE_CONFLICT",
    "PAID_EDIT_SYNC_REQUIRED",
    "PAID_EDIT_TOO_MANY_LINES",
    "PAID_EDIT_USE_CANCELLATION",
    "PARITY_CREDENTIALS_UNAVAILABLE",
    "PARITY_CREDENTIAL_READ_FAILED",
    "PARITY_CREDENTIAL_TUPLE_CONFLICT",
    "PARITY_STATUS_UNAVAILABLE",
    "PARITY_SYNC_FAILED",
    "PARITY_SYNC_PARTIAL",
    "PAYMENT_CURRENCY_MISMATCH",
    "PAYMENT_MIRROR_PENDING",
    "PAYMENT_NOT_SAVED",
    "PAYMENT_SYNC_REQUIRED",
    "PERMISSION_DENIED",
    "POS_ORDER_EDIT_SNAPSHOT_UNAVAILABLE",
    "POS_ORDER_SETTLEMENT_UNAVAILABLE",
    "POS_TERMINAL_AUTH_REQUIRED",
    "REAUTH_REQUIRED",
    "RECOVERY_ORIGINAL_REQUEST_REQUIRED",
    "REMOTE_AUTH_PAUSED",
    "REMOTE_HANDOVER_RETRY",
    "REPAIR_ACCESS_DECISION_STALE",
    "REPAIR_ACCESS_REVOKED",
    "REPAIR_ACTOR_EXPIRED",
    "REPAIR_LIFECYCLE_UNAVAILABLE",
    "REPAIR_MODULE_REQUIRED",
    "REPAIR_NATIVE_STATE_UNAVAILABLE",
    "REPAIR_OFFLINE_LEASE_EXHAUSTED",
    "REPAIR_RESERVED_OWNER_QUARANTINED",
    "REPAIR_RESET_PENDING",
    "REPAIR_SCOPE_EPOCH_MISMATCH",
    "REPAIR_SCOPE_TRANSITION_BUSY",
    "REPAIR_SCOPE_TRANSITION_PENDING",
    "REPAIR_SCOPE_TRANSITION_UNAVAILABLE",
    "REPAIR_SETTLEMENT_ROUTE_REQUIRED",
    "REPAIR_STAGING_MAINTENANCE_FAILED",
    "REPAIR_SYNC_REJECTED",
    "REPAIR_SYNC_TRANSIENT",
    "RESET_IN_PROGRESS",
    "ROOM_CHARGE_UNAVAILABLE",
    "SERVER_CONFLICT",
    "SERVICE_LOGIN_REQUIRED",
    "SHIFT_CURRENCY_MISMATCH",
    "SHIFT_CURRENCY_UNAVAILABLE",
    "STAFF_CASH_RETURN_REQUIRED",
    "STAFF_SESSION_EXPIRED",
    "SYNC_CANCELLED",
    "SYNC_CLOSEOUT_BLOCKED",
    "SYNC_QUEUE_FULL",
    "SYNC_QUEUE_ID_COLLISION",
    "TABLE_CANCELLATION_PENDING",
    "TABLE_CANCEL_SYNC_REQUIRED",
    "TABLE_EDIT_SCOPED_SETTLEMENT_REQUIRED",
    "TABLE_ORDER_CANONICAL_CANCEL_REQUIRED",
    "TABLE_ORDER_HISTORY_DELETE_REFUSED",
    "TERMINAL_AUTH_INVALID",
    "TERMINAL_AUTH_RESET",
    "TERMINAL_BINDING_UNAVAILABLE",
    "TERMINAL_CREDENTIAL_READ_FAILED",
    "TERMINAL_INACTIVE",
    "TERMINAL_NOT_CONFIGURED",
    "TERMINAL_REBIND_CREDENTIALS_UNAVAILABLE",
    "TERMINAL_REBIND_PENDING",
    "TERMINAL_REBIND_SETTINGS_UNAVAILABLE",
    "TERMINAL_SCOPE_UNAVAILABLE",
    "TERMINAL_TRANSITION_PENDING",
    "TWINT_PRIOR_CHECKOUT_RECONCILIATION_REQUIRED",
    "TWINT_RECEIPT_ORDER_CONTEXT_CHANGED",
    "UNSETTLED_PAYMENT_BLOCKER",
    "VERSION_MISMATCH",
    "Z_REPORT_OFFLINE",
    "Z_REPORT_UNIT_SHIFTS_OPEN",
    "Z_REPORT_WINDOW_CONFLICT",
];

/// `^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$`, as RUNTIME_ERROR_CODE_SHAPE.
fn has_error_code_shape(token: &str) -> bool {
    let upper = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    };
    token.starts_with(|ch: char| ch.is_ascii_uppercase())
        && token.contains('_')
        && token.split('_').all(upper)
}

/// The first listed code that is a whole `[A-Za-z0-9_]` token of the message.
/// The returned string is the list's own constant; no part of the line is kept.
fn runtime_error_code(message: &str) -> Option<&'static str> {
    message
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .filter(|token| has_error_code_shape(token))
        .find_map(|token| {
            RUNTIME_ERROR_CODES
                .binary_search(&token)
                .ok()
                .map(|index| RUNTIME_ERROR_CODES[index])
        })
}

fn is_specific_code(code: &str) -> bool {
    RUNTIME_ERROR_CODES.binary_search(&code).is_ok()
        || is_checkout_event_code(code)
        || DB_LOCK_EVENT_CODES.contains(&code)
}

fn listed(value: &str, list: &[&'static str]) -> Option<&'static str> {
    list.iter().copied().find(|listed| *listed == value)
}

fn checkout_event_code(message: &str) -> String {
    // Only a fixed structured field is retained, never prose or arbitrary errors.
    structured_field(message, "event_code")
        .filter(|value| is_checkout_event_code(value))
        .unwrap_or("checkout_persistence_event")
        .to_string()
}

fn structured_field<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    let mut found = None;
    for (start, _) in message.match_indices(key) {
        let prefix = &message[..start];
        let tail = &message[start + key.len()..];
        let json_field = prefix
            .strip_suffix('"')
            .is_some_and(|prefix| prefix.is_empty() || prefix.trim_end().ends_with(['{', ',']));
        let remaining = if json_field {
            tail.strip_prefix('"')
                .and_then(|tail| tail.trim_start().strip_prefix(':'))
        } else if prefix.is_empty() || prefix.chars().next_back().is_some_and(char::is_whitespace) {
            tail.strip_prefix('=')
        } else {
            None
        };
        let Some(remaining) = remaining else {
            continue;
        };
        let remaining = if json_field {
            remaining.trim_start()
        } else {
            remaining
        };
        let Some(rest) = remaining.strip_prefix('"') else {
            continue;
        };
        let Some((value, suffix)) = rest.split_once('"') else {
            continue;
        };
        if value.contains(['\\', '\r', '\n']) {
            continue;
        }
        let terminated = suffix.is_empty()
            || suffix
                .chars()
                .next()
                .is_some_and(|ch| ch.is_whitespace() || ch == ',' || ch == '}');
        if !terminated {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(value);
    }
    found
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
    let error_code = runtime_error_code(message);
    if component == "checkout" {
        let mut event = json!({"timestamp": timestamp, "level": level,
            "component": component, "eventCode": checkout_event_code(message)});
        if let Some(code) = error_code {
            event["errorCode"] = json!(code);
        }
        if let Some(phase @ ("editing" | "checkout_pending" | "invalid")) =
            structured_field(message, "draft_phase")
        {
            event["draftPhase"] = json!(phase);
        }
        // An order-edit refusal names its first differing field from the
        // fixed list (`none` included); never a value.
        if let Some(field) = structured_field(message, "edit_field").and_then(|field| {
            listed(field, crate::edit_settlement_recovery::EDIT_REFUSAL_FIELDS)
                .or_else(|| (field == "none").then_some("none"))
        }) {
            event["editField"] = json!(field);
        }
        return Ok(event);
    }
    let message_lower = message.to_ascii_lowercase();
    let db_lock_code = if component == "database" {
        structured_field(message, "event_code").and_then(|code| listed(code, DB_LOCK_EVENT_CODES))
    } else {
        None
    };
    let code = if let Some(code) = db_lock_code {
        code
    } else if matches!(component, "printing" | "network")
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
    if let Some(code) = error_code {
        event["errorCode"] = json!(code);
    }
    if db_lock_code.is_some() {
        for (key, field) in [("lockLabel", "lock_label"), ("holderLabel", "holder_label")] {
            if let Some(label) =
                structured_field(message, field).and_then(|label| listed(label, DB_LOCK_LABELS))
            {
                event[key] = json!(label);
            }
        }
    }
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
        let filler = (MAX_BYTES_PER_FILE + 24 * 1024) as usize;
        for day in 1..=4 {
            let mut bytes = vec![b'x'; filler];
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
        // Per file: the line the budget cut into, and the unfinished last line.
        assert_eq!(snapshot["counts"]["linesPartial"], 4);
        assert_eq!(snapshot["counts"]["linesOversized"], 0);
        assert_eq!(snapshot["counts"]["linesMalformed"], 2);
        assert_eq!(snapshot["events"]["error"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["truncated"], true);
        let files = snapshot["coverage"]["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        for file in files {
            assert_eq!(file["status"], "partial");
            assert_eq!(file["stoppedBy"], "budget");
            assert_eq!(file["bytesRead"], MAX_BYTES_PER_FILE);
            assert_eq!(
                file["bytesSkipped"].as_u64().unwrap() + MAX_BYTES_PER_FILE,
                fs::metadata(root.join("pos.2026-10-01")).unwrap().len()
            );
        }
        // The newest file's oldest line read is already older than the window.
        assert_eq!(snapshot["history"]["coveredFrom"], "2026-10-02T22:15:23Z");
        assert_eq!(snapshot["history"]["complete"], true);
        assert_eq!(snapshot["history"]["linesBeforeWindow"], 2);
        fs::remove_dir_all(root).unwrap();
    }

    fn capture_time() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-19T17:05:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// Nothing of a line but its listed code may reach the bundle.
    fn assert_private(snapshot: &Value) {
        let encoded = snapshot.to_string().to_ascii_lowercase();
        for marker in [
            "canary",
            "maria",
            "private",
            "6912345678",
            "terminal_id",
            "customer",
            "phone",
            "token",
            "message",
            "the_small_pos_lib",
            "c:\\\\users",
        ] {
            assert!(!encoded.contains(marker), "{marker} leaked");
        }
    }

    #[test]
    fn runtime_logs_error_codes_are_the_shared_list() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../shared/pos/health/__fixtures__/runtime-log-error-codes.json"
        ))
        .unwrap();
        let shared: Vec<&str> = fixture["codes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|code| code.as_str().unwrap())
            .collect();
        assert_eq!(RUNTIME_ERROR_CODES, shared.as_slice());
        // Sorted and unique: the lookup is a binary search.
        assert!(RUNTIME_ERROR_CODES.windows(2).all(|pair| pair[0] < pair[1]));
        for code in RUNTIME_ERROR_CODES {
            assert!(has_error_code_shape(code), "{code}");
            let desktop = project_line(&format!(
                "2026-10-19T14:42:07.118254Z WARN the_small_pos_lib::sync: Parity sync failed: {code} for Maria PII_CANARY terminal_id=ID_CANARY"
            ))
            .unwrap();
            let mobile = project_line(&format!(
                "2026-10-19T14:42:07.118Z [ERROR] [SyncService] sync failed {{\"code\":\"{code}\",\"customer\":\"Maria PII_CANARY\",\"phone\":\"6912345678\"}}"
            ))
            .unwrap();
            assert_eq!(
                desktop,
                json!({"timestamp": "2026-10-19T14:42:07.118254Z", "level": "warn",
                    "component": "sync", "eventCode": "sync_error", "errorCode": code})
            );
            assert_eq!(
                mobile,
                json!({"timestamp": "2026-10-19T14:42:07.118Z", "level": "error",
                    "component": "sync", "eventCode": "sync_error", "errorCode": code})
            );
        }
        for anchor in [
            "REPAIR_SCOPE_TRANSITION_PENDING",
            "TERMINAL_REBIND_PENDING",
            "REPAIR_MODULE_REQUIRED",
        ] {
            assert!(RUNTIME_ERROR_CODES.contains(&anchor));
        }
        for text in [
            "XTERMINAL_REBIND_PENDING",
            "TERMINAL_REBIND_PENDING_V2",
            "terminal_rebind_pending",
            "TERMINAL REBIND PENDING",
            "PII_NAME_CANARY",
        ] {
            assert_eq!(runtime_error_code(text), None, "{text}");
        }
        assert_eq!(
            runtime_error_code("\"TERMINAL_REBIND_PENDING\": x"),
            Some("TERMINAL_REBIND_PENDING")
        );
    }

    /// The production lines project, through the support-bundle projector,
    /// to their fixed code, labels and duration, and to nothing else.
    #[test]
    fn runtime_logs_keep_database_lock_lines_as_the_desktop_writes_them() {
        use crate::database_lock::{
            log_slow_wait, log_watchdog_event, SlowWait, WatchdogEvent, UNTRACED,
        };
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        #[derive(Clone, Default)]
        struct Captured(Arc<Mutex<Vec<u8>>>);
        struct Writer(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for Captured {
            type Writer = Writer;
            fn make_writer(&'writer self) -> Writer {
                Writer(Arc::clone(&self.0))
            }
        }
        let captured = Captured::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_target(true)
            .with_writer(captured.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            log_slow_wait(SlowWait {
                label: "checkout_draft_put",
                holder_label: "parity_queue_process",
                waited: Duration::from_millis(1_234),
            });
            log_watchdog_event(WatchdogEvent::HeldLong {
                holder_label: UNTRACED,
                held: Duration::from_millis(3_001),
            });
            log_watchdog_event(WatchdogEvent::Released {
                holder_label: "z_report_generate",
                held: Duration::from_millis(612_000),
            });
        });
        let text = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        let events: Vec<Value> = text
            .lines()
            .map(|line| {
                let mut event =
                    project_line(line).unwrap_or_else(|reason| panic!("{reason}: {line}"));
                event.as_object_mut().unwrap().remove("timestamp");
                event
            })
            .collect();
        assert_eq!(
            events,
            vec![
                json!({"level": "warn", "component": "database",
                    "eventCode": "db_lock_wait_slow", "lockLabel": "checkout_draft_put",
                    "holderLabel": "parity_queue_process", "durationMs": 1234}),
                json!({"level": "warn", "component": "database",
                    "eventCode": "db_lock_held_long", "holderLabel": "untraced",
                    "durationMs": 3001}),
                json!({"level": "warn", "component": "database",
                    "eventCode": "db_lock_released", "holderLabel": "z_report_generate",
                    "durationMs": 612000}),
            ],
            "{text}"
        );
    }

    #[test]
    fn runtime_logs_shared_history_cases() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../shared/pos/health/__fixtures__/runtime-log-history.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let captured_at = DateTime::parse_from_rfc3339(case["capturedAt"].as_str().unwrap())
                .unwrap()
                .with_timezone(&Utc);
            let mut collector = Collector::new(captured_at);
            for file in case["files"].as_array().unwrap() {
                collector.begin_file();
                for line in file["lines"].as_array().unwrap() {
                    collector.add_line(line.as_str().unwrap());
                }
                let status = match file["status"].as_str().unwrap() {
                    "complete" => "complete",
                    "partial" => "partial",
                    _ => "unreadable",
                };
                if status == "unreadable" {
                    collector.increment("filesUnreadable", 1);
                }
                let stopped_by = match file["stoppedBy"].as_str() {
                    Some("budget") => Some("budget"),
                    Some("deadline") => Some("deadline"),
                    Some(_) => Some("read_error"),
                    None => None,
                };
                collector.end_file(status, stopped_by, 0, 0);
            }
            let snapshot = collector.finish();
            assert_eq!(
                snapshot["history"], case["expected"]["history"],
                "{}",
                case["name"]
            );
            let files: Vec<Value> = snapshot["coverage"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| json!({"oldestAt": file["oldestAt"], "newestAt": file["newestAt"]}))
                .collect();
            assert_eq!(
                Value::Array(files),
                case["expected"]["files"],
                "{}",
                case["name"]
            );
            assert_private(&snapshot);
        }
    }

    #[test]
    fn runtime_logs_keep_an_early_refusal_that_later_warnings_pushed_out() {
        // Tomikro 19/10: the till logged its refusal, then enough warnings for
        // the newest 50 to cover minutes. The history still has the refusal.
        let root = root();
        let mut log = String::from("2026-10-19T14:42:07.118254Z WARN the_small_pos_lib::sync: Parity sync failed: TERMINAL_REBIND_PENDING terminal_id=ID_CANARY\n");
        for index in 0..600 {
            log.push_str(&format!(
                "2026-10-19T{:02}:{:02}:{:02}Z WARN the_small_pos_lib::sync: Parity sync failed: customer Maria PII_CANARY\n",
                15 + index / 300,
                index % 300 / 5,
                index % 5 * 10
            ));
        }
        fs::write(root.join("pos.2026-10-19"), log).unwrap();
        let snapshot = collect_at(&root, true, capture_time());
        assert_eq!(snapshot["status"], "partial");
        let warnings = snapshot["events"]["warn"].as_array().unwrap();
        assert_eq!(warnings.len(), MAX_EVENTS);
        assert!(warnings
            .iter()
            .all(|event| event.get("errorCode").is_none()));
        assert_eq!(
            snapshot["history"]["rows"][0],
            json!({"component": "sync", "code": "TERMINAL_REBIND_PENDING", "count": 1,
                "firstAt": "2026-10-19T14:42:07.118254Z", "lastAt": "2026-10-19T14:42:07.118254Z",
                "hours": {"2026-10-19T14:00:00Z": 1}})
        );
        assert_eq!(snapshot["history"]["rows"][1]["code"], "sync_error");
        assert_eq!(
            snapshot["history"]["rows"][1]["hours"],
            json!({"2026-10-19T15:00:00Z": 300, "2026-10-19T16:00:00Z": 300})
        );
        assert_eq!(snapshot["coverage"]["files"][0]["status"], "complete");
        assert_private(&snapshot);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_logs_join_lines_across_read_chunks() {
        // Lines of two- and three-byte characters cross many chunk edges; each
        // is read exactly once and none is cut.
        let root = root();
        let mut log = String::new();
        let mut lines = 0u64;
        while (log.len() as u64) < 3 * READ_CHUNK_BYTES + 777 {
            log.push_str(&format!(
                "2026-10-19T16:{:02}:{:02}Z WARN the_small_pos_lib::sync: Parity sync failed: REPAIR_SCOPE_TRANSITION_PENDING αβγ—€ {lines}\r\n",
                lines / 60 % 60,
                lines % 60
            ));
            lines += 1;
        }
        fs::write(root.join("pos.2026-10-19"), &log).unwrap();
        let snapshot = collect_at(&root, true, capture_time());
        assert_eq!(snapshot["coverage"]["files"][0]["status"], "complete");
        assert_eq!(
            snapshot["counts"]["eventsOmitted"],
            lines - MAX_EVENTS as u64
        );
        assert_eq!(snapshot["counts"]["linesScanned"], lines);
        assert_eq!(snapshot["counts"]["linesPartial"], 0);
        assert_eq!(snapshot["counts"]["linesMalformed"], 0);
        assert_eq!(snapshot["counts"]["bytesRead"], log.len() as u64);
        assert_eq!(snapshot["history"]["linesCounted"], lines);
        assert_eq!(snapshot["history"]["rows"][0]["count"], lines);
        assert_eq!(snapshot["history"]["coveredFrom"], "2026-10-19T16:00:00Z");
        assert_eq!(snapshot["history"]["complete"], false);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_logs_a_budget_cut_keeps_the_newest_lines_and_says_so() {
        let root = root();
        let mut log = String::from(
            "2026-10-18T08:00:00Z WARN the_small_pos_lib::sync: Parity sync failed: SYNC_QUEUE_FULL\n",
        );
        log.push_str(&"x".repeat(MAX_BYTES_PER_FILE as usize));
        log.push('\n');
        log.push_str(
            "2026-10-19T16:42:00Z WARN the_small_pos_lib::sync: Parity sync failed: TERMINAL_REBIND_PENDING\n",
        );
        fs::write(root.join("pos.2026-10-19"), &log).unwrap();
        let snapshot = collect_at(&root, true, capture_time());
        assert_eq!(snapshot["status"], "partial");
        let file = &snapshot["coverage"]["files"][0];
        assert_eq!(file["status"], "partial");
        assert_eq!(file["stoppedBy"], "budget");
        assert_eq!(file["bytesSkipped"], log.len() as u64 - MAX_BYTES_PER_FILE);
        let rows = snapshot["history"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["code"], "TERMINAL_REBIND_PENDING");
        assert_eq!(snapshot["history"]["coveredFrom"], "2026-10-19T16:42:00Z");
        assert_eq!(snapshot["history"]["complete"], false);
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
