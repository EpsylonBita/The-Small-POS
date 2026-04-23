//! Admin dashboard API client.
//!
//! Provides authenticated HTTP communication with the admin dashboard, used
//! for connectivity testing, menu sync, order sync, and module fetches.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use reqwest::{Client, Method, StatusCode};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Default timeout for API requests (30 seconds).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Shared reqwest::Client — holds a connection pool, TLS session cache,
/// and DNS cache. Previously a fresh Client was built on every call to
/// `fetch_from_admin` and `test_connectivity`, which defeated keep-alive,
/// forced a TLS handshake per request, and could leak file descriptors
/// under load. `reqwest::Client` is cheap to clone (internally Arc-based),
/// but referencing the singleton directly avoids even that overhead. Each
/// caller sets its own timeout via `RequestBuilder::timeout()` rather
/// than the client-level default.
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn shared_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .build()
            .expect("build shared reqwest Client")
    })
}

/// Redact a sensitive string for log output: shows only the last 4 characters.
/// Returns `"****"` for strings shorter than 5 chars, `"...XXXX"` otherwise.
pub fn redact(s: &str) -> String {
    if s.len() <= 4 {
        "****".to_string()
    } else {
        format!("...{}", &s[s.len() - 4..])
    }
}

/// Timeout used specifically for the lightweight connectivity test.
const CONNECTIVITY_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/// Normalise the admin dashboard URL:
/// - strip trailing slashes
/// - strip a trailing `/api` segment
/// - ensure a scheme is present (https, or http for localhost)
pub fn normalize_admin_url(url: &str) -> String {
    let mut url = url.trim().to_string();

    // Ensure scheme
    if !url.starts_with("http://") && !url.starts_with("https://") {
        if url.starts_with("localhost") || url.starts_with("127.0.0.1") {
            url = format!("http://{url}");
        } else {
            url = format!("https://{url}");
        }
    }

    // Strip trailing slashes
    while url.ends_with('/') {
        url.pop();
    }

    // Strip trailing /api
    if url.ends_with("/api") {
        url.truncate(url.len() - 4);
    }

    // Strip trailing slashes again (in case "/api/" was present)
    while url.ends_with('/') {
        url.pop();
    }

    url
}

fn decode_connection_string_payload(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        return serde_json::from_str::<Value>(trimmed).ok();
    }

    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.starts_with('{') {
        return serde_json::from_str::<Value>(&compact).ok();
    }
    if compact.len() < 20 {
        return None;
    }

    let base64 = compact.replace('-', "+").replace('_', "/");
    let padded = format!(
        "{}{}",
        base64,
        "=".repeat((4usize.wrapping_sub(base64.len() % 4)) % 4)
    );
    let decoded = BASE64_STANDARD.decode(padded).ok()?;
    serde_json::from_slice::<Value>(&decoded).ok()
}

pub fn extract_api_key_from_connection_string(raw: &str) -> Option<String> {
    decode_connection_string_payload(raw)
        .and_then(|v| {
            v.get("key")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

pub fn extract_admin_url_from_connection_string(raw: &str) -> Option<String> {
    decode_connection_string_payload(raw)
        .and_then(|v| {
            v.get("url")
                .and_then(Value::as_str)
                .map(normalize_admin_url)
        })
        .filter(|s| !s.is_empty())
}

pub fn extract_terminal_id_from_connection_string(raw: &str) -> Option<String> {
    decode_connection_string_payload(raw)
        .and_then(|v| {
            v.get("tid")
                .or_else(|| v.get("terminalId"))
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

fn extract_terminal_id_from_body(body: Option<&Value>) -> Option<String> {
    let body = body?;
    let resolved = match body {
        Value::String(raw) => serde_json::from_str::<Value>(raw).ok()?,
        other => other.clone(),
    };

    resolved
        .get("terminal_id")
        .or_else(|| resolved.get("terminalId"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Convert a `reqwest::Error` into a user-friendly message.
fn friendly_error(url: &str, err: &reqwest::Error) -> String {
    if err.is_connect() {
        return format!("Cannot reach admin dashboard at {url}");
    }
    if err.is_timeout() {
        return format!("Connection to {url} timed out");
    }
    if err.is_builder() {
        return format!("Invalid admin dashboard URL: {url}");
    }
    format!("Network error communicating with {url}: {err}")
}

/// Convert an HTTP status code into a user-friendly message.
fn status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "API key is invalid or expired".to_string(),
        403 => "Terminal not authorized".to_string(),
        404 => "Admin dashboard endpoint not found".to_string(),
        s if s >= 500 => format!("Admin dashboard server error (HTTP {s})"),
        s => format!("Unexpected response from admin dashboard (HTTP {s})"),
    }
}

// ---------------------------------------------------------------------------
// Connectivity test
// ---------------------------------------------------------------------------

/// Result of a connectivity test.
#[derive(serde::Serialize)]
pub struct ConnectivityResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Test connectivity to the admin dashboard with a lightweight health-check.
pub async fn test_connectivity(admin_url: &str, api_key: &str) -> ConnectivityResult {
    let url = normalize_admin_url(admin_url);
    let resolved_api_key =
        extract_api_key_from_connection_string(api_key).unwrap_or_else(|| api_key.to_string());
    let health_url = format!("{url}/api/health");

    let client = shared_client();

    let start = Instant::now();

    let resp = match client
        .get(&health_url)
        .timeout(CONNECTIVITY_TIMEOUT)
        .header("X-POS-API-Key", resolved_api_key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return ConnectivityResult {
                success: false,
                latency_ms: None,
                error: Some(friendly_error(&url, &e)),
            };
        }
    };

    let latency = start.elapsed().as_millis() as u64;
    let status = resp.status();

    if status.is_success() {
        info!(latency_ms = latency, "connectivity test passed");
        ConnectivityResult {
            success: true,
            latency_ms: Some(latency),
            error: None,
        }
    } else {
        ConnectivityResult {
            success: false,
            latency_ms: Some(latency),
            error: Some(status_error(status)),
        }
    }
}

// ---------------------------------------------------------------------------
// Generic authenticated fetch
// ---------------------------------------------------------------------------

/// Perform an authenticated HTTP request to the admin dashboard.
///
/// `path` should include the leading slash, e.g. `/api/pos/menu/sync`.
/// `method` is an HTTP verb string: "GET", "POST", "PUT", "PATCH", "DELETE".
pub async fn fetch_from_admin(
    admin_url: &str,
    api_key: &str,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base = normalize_admin_url(admin_url);
    let resolved_api_key =
        extract_api_key_from_connection_string(api_key).unwrap_or_else(|| api_key.to_string());
    let full_url = format!("{base}{path}");

    let http_method: Method = method
        .to_uppercase()
        .parse()
        .map_err(|_| format!("Invalid HTTP method: {method}"))?;

    let client = shared_client();

    // Include terminal_id header — required by verifyPosAuth on the admin side
    let mut terminal_id = crate::storage::get_credential("terminal_id").unwrap_or_default();
    if terminal_id.trim().is_empty() {
        // If the keyring lacks a terminal_id, fall back to whatever the
        // caller put in the request body so the server still receives a
        // terminal header. We intentionally do NOT persist this value:
        // the body is caller-supplied and unverified at this point, so
        // trusting it for durable storage would let a bad payload seed
        // the keyring with an attacker-chosen identity. The
        // connection-string path below (which came through onboarding
        // and is cryptographically scoped) remains the only trusted
        // source that writes to the keyring.
        if let Some(body_terminal_id) = extract_terminal_id_from_body(body.as_ref()) {
            terminal_id = body_terminal_id;
        }
    }
    if let Some(decoded_tid) = extract_terminal_id_from_connection_string(api_key) {
        let existing = terminal_id.trim();
        if existing.is_empty() || existing != decoded_tid {
            if !existing.is_empty() && existing != decoded_tid {
                warn!(
                    stored_terminal_id = %redact(existing),
                    decoded_terminal_id = %redact(&decoded_tid),
                    "terminal_id mismatch detected, preferring decoded terminal id from connection string"
                );
            }
            terminal_id = decoded_tid.clone();
            let _ = crate::storage::set_credential("terminal_id", &decoded_tid);
        }
    }

    let mut req = client
        .request(http_method, &full_url)
        .timeout(DEFAULT_TIMEOUT)
        .header("X-POS-API-Key", resolved_api_key)
        .header("x-terminal-id", &terminal_id)
        .header("Content-Type", "application/json");

    if let Some(b) = body {
        // If the JavaScript frontend pre-serialized the body via JSON.stringify(),
        // it arrives as Value::String containing JSON. Parse it back to avoid
        // double-serialization by reqwest's .json() method.
        let resolved = if let Value::String(ref s) = b {
            serde_json::from_str::<Value>(s).unwrap_or(b)
        } else {
            b
        };
        req = req.json(&resolved);
    }

    let mut resp = req.send().await.map_err(|e| friendly_error(&base, &e))?;
    let status = resp.status();

    if !status.is_success() {
        // Preserve validation details for diagnostics and sync queue visibility,
        // but cap the response body at 64 KB so a hostile or misconfigured
        // server returning a huge error payload cannot OOM the terminal.
        const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
        let mut body_bytes: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(body_bytes.len());
                    if chunk.len() >= remaining {
                        body_bytes.extend_from_slice(&chunk[..remaining]);
                        break;
                    }
                    body_bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        let body_text = String::from_utf8_lossy(&body_bytes).into_owned();
        let detail = if let Ok(json) = serde_json::from_str::<Value>(&body_text) {
            let message = json
                .get("error")
                .or_else(|| json.get("message"))
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .unwrap_or_else(|| status_error(status));
            let details = json.get("details").or_else(|| json.get("errors")).cloned();
            if let Some(details) = details {
                format!("{message} (HTTP {}): {}", status.as_u16(), details)
            } else if !body_text.trim().is_empty() && body_text.trim() != message {
                format!("{message} (HTTP {}): {}", status.as_u16(), body_text.trim())
            } else {
                format!("{message} (HTTP {})", status.as_u16())
            }
        } else if !body_text.trim().is_empty() {
            format!(
                "{} (HTTP {}): {}",
                status_error(status),
                status.as_u16(),
                body_text.trim()
            )
        } else {
            format!("{} (HTTP {})", status_error(status), status.as_u16())
        };
        return Err(detail);
    }

    // Return the JSON body, or null for empty 204 responses.
    //
    // Wave 6: propagate body-read errors rather than swallowing them
    // with `unwrap_or_default()`. On HEAD a transport error mid-body
    // returned an empty string which was then parsed as a JSON null,
    // indistinguishable from a genuine 204. The caller had no way to
    // tell the two apart.
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read admin response body: {e}"))?;
    if body_text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body_text).map_err(|e| format!("Invalid JSON from admin dashboard: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_terminal_id_from_body_reads_object_payloads() {
        assert_eq!(
            extract_terminal_id_from_body(Some(&json!({ "terminal_id": "terminal-123" }))),
            Some("terminal-123".to_string())
        );
        assert_eq!(
            extract_terminal_id_from_body(Some(&json!({ "terminalId": "terminal-456" }))),
            Some("terminal-456".to_string())
        );
    }

    #[test]
    fn extract_terminal_id_from_body_reads_stringified_json_payloads() {
        assert_eq!(
            extract_terminal_id_from_body(Some(&Value::String(
                r#"{"terminal_id":"terminal-789"}"#.to_string()
            ))),
            Some("terminal-789".to_string())
        );
        assert_eq!(extract_terminal_id_from_body(Some(&Value::Null)), None);
    }
}
