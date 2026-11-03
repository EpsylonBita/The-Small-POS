use super::super::critical_op::SupportPermit;
use super::*;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};
// Reuse the shipped finite event projection, including its sealed-record
// exclusions. This includes no raw diagnostic prose or credential store.
use crate::diagnostics::runtime_logs as projection;
pub fn collect(root: &Path, input: &Value, permit: &SupportPermit) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut lines = Vec::new();
    let mut dropped = 0;
    let mut paths = std::fs::read_dir(root)
        .map_err(|_| "INTERNAL_ERROR")?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("pos.log"))
        .map(|e| e.path())
        .collect::<Vec<_>>();
    paths.sort();
    paths.reverse();
    let file_limit = paths.len() > 3;
    let mut file_bytes_skipped = 0u64;
    let mut deadline_reached = false;
    let rank = |s: &str| match s {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        "error" => 3,
        _ => 4,
    };
    for path in paths.into_iter().take(3) {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let mut file = File::open(path).map_err(|_| "INTERNAL_ERROR")?;
        let size = file.metadata().map_err(|_| "INTERNAL_ERROR")?.len();
        let start = size.saturating_sub(128 * 1024);
        file_bytes_skipped += start;
        file.seek(SeekFrom::Start(start))
            .map_err(|_| "INTERNAL_ERROR")?;
        let mut buffer = Vec::new();
        file.take(128 * 1024)
            .read_to_end(&mut buffer)
            .map_err(|_| "INTERNAL_ERROR")?;
        let text = String::from_utf8_lossy(&buffer);
        for (index, line) in text.lines().enumerate() {
            if (start > 0 && index == 0) || line.len() > 8192 {
                dropped += 1;
                continue;
            }
            if permit.is_cancelled() {
                return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
            }
            if Instant::now() >= deadline {
                deadline_reached = true;
                break;
            }
            let event = match projection::project_line(line) {
                Ok(v) => v,
                Err(_) => {
                    dropped += 1;
                    continue;
                }
            };
            let at = event["timestamp"].as_str().unwrap_or("");
            let time = chrono::DateTime::parse_from_rfc3339(at).ok();
            let since = input["since"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
            let until = input["until"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
            if time.is_none()
                || since.zip(time).is_some_and(|(a, t)| t < a)
                || until.zip(time).is_some_and(|(a, t)| t > a)
                || rank(event["level"].as_str().unwrap_or(""))
                    < rank(input["min_level"].as_str().unwrap_or("debug"))
                || input["component"]
                    .as_str()
                    .is_some_and(|c| event["component"] != c)
            {
                continue;
            }
            lines.push(json!({"at":at,"level":event["level"],"component":event["component"],"code":event.get("errorCode").or_else(||event.get("eventCode")),"message":redaction::text(event["eventCode"].as_str().unwrap_or("Runtime event"))}));
        }
    }
    lines.sort_by(|a, b| b["at"].as_str().cmp(&a["at"].as_str()));
    let max = input["max_lines"].as_u64().unwrap_or(200).clamp(1, 500) as usize;
    let matching_lines = lines.len();
    let truncated = lines.len() > max;
    lines.truncate(max);
    let mut bytes = 0;
    lines.retain(|line| {
        bytes += line.to_string().len();
        bytes <= 128 * 1024
    });
    Ok(
        json!({"lines":lines,"truncation":if truncated||bytes>128*1024||file_limit||file_bytes_skipped>0||deadline_reached{json!([{"field":"lines","reason":"lines"}])}else{json!([])},"redaction_dropped":dropped,"coverage":{"source":"retained_projected_log_tail","max_files":3,"max_bytes_per_file":128*1024,"files_omitted":file_limit,"file_bytes_skipped":file_bytes_skipped,"deadline_reached":deadline_reached,"matching_lines_before_cap":matching_lines,"returned_lines":lines.len(),"oldest_at":lines.last().map(|l|&l["at"]),"newest_at":lines.first().map(|l|&l["at"]),"complete":!file_limit && file_bytes_skipped==0 && !deadline_reached && !truncated && bytes<=128*1024 && dropped==0}}),
    )
}
