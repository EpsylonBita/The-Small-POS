//! Admin dashboard API client.
//!
//! Provides authenticated HTTP communication with the admin dashboard, used
//! for connectivity testing, menu sync, order sync, and module fetches.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use reqwest::{Client, Method, StatusCode};
use serde_json::Value;
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Default timeout for API requests (30 seconds).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

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

    let client = match Client::builder().timeout(CONNECTIVITY_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return ConnectivityResult {
                success: false,
                latency_ms: None,
                error: Some(format!("Failed to create HTTP client: {e}")),
            };
        }
    };

    let start = Instant::now();

    let resp = match client
        .get(&health_url)
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

    let client = Client::builder()
        .timeout(DEFAULT_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    // Include terminal_id header — required by verifyPosAuth on the admin side
    let mut terminal_id = crate::storage::get_credential("terminal_id").unwrap_or_default();
    if let Some(decoded_tid) = extract_terminal_id_from_connection_string(api_key) {
        let existing = terminal_id.trim();
        if existing.is_empty() || existing != decoded_tid {
            if !existing.is_empty() && existing != decoded_tid {
                warn!(
                    stored_terminal_id = existing,
                    decoded_terminal_id = %decoded_tid,
                    "terminal_id mismatch detected, preferring decoded terminal id from connection string"
                );
            }
            terminal_id = decoded_tid.clone();
            let _ = crate::storage::set_credential("terminal_id", &decoded_tid);
        }
    }

    let mut req = client
        .request(http_method, &full_url)
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

    let resp = req.send().await.map_err(|e| friendly_error(&base, &e))?;
    let status = resp.status();

    if !status.is_success() {
        // Preserve validation details for diagnostics and sync queue visibility.
        let body_text = resp.text().await.unwrap_or_default();
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
    let body_text = resp.text().await.unwrap_or_default();
    if body_text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body_text).map_err(|e| format!("Invalid JSON from admin dashboard: {e}"))
}
