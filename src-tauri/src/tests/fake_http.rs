//! Multi-request mock HTTP server for durability / exactly-once tests.
//!
//! # Relationship to the existing test helpers
//!
//! `sync.rs` already has two helpers — `spawn_single_json_response_server`
//! (one request, one assert) and `spawn_json_sequence_server` (scripted
//! per-request responses). Both are great for sync-path unit tests but
//! neither lets the caller ASK the server "how many requests did you
//! get, and what was in each one?" after the dispatch.
//!
//! `MockServer` fills that gap: it accepts any number of requests,
//! records them in a shared `Arc<Mutex<Vec<RecordedRequest>>>`, responds
//! to each with a fixed JSON body, and exposes the recorded list on
//! demand. That shape is exactly what the Wave 7 parity-gate tests need
//! for G8 (payment offline → restart → sync exactly-once), G13 (refund),
//! and G14 (z-report) — each of those tests enqueues N items, drives a
//! sync cycle, and must then assert "server saw exactly N requests, each
//! with a distinct entity-stable idempotency key."
//!
//! # Shutdown
//!
//! The listener is set non-blocking and the accept loop polls a shared
//! `AtomicBool` every 10 ms. Dropping the `MockServer` flips the flag
//! and joins the thread so tests don't leak sockets or threads.
//!
//! # Limitations
//!
//! - Body parsing is minimal: we split on `"\r\n\r\n"` and take whatever
//!   follows. Chunked transfer encoding is NOT decoded; for HTTP/1.1
//!   clients that emit `Content-Length` (reqwest does), the body is
//!   intact.
//! - Header parsing records lowercase keys only.
//! - The server responds the SAME body to every request. For per-request
//!   scripted responses use `sync.rs::spawn_json_sequence_server`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// A single recorded HTTP request. Fields are populated best-effort.
#[derive(Clone, Debug, Default)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl RecordedRequest {
    /// Convenience: parse the body as JSON and return `Some(value)` or
    /// `None` if the body is empty or not valid JSON.
    pub fn json_body(&self) -> Option<serde_json::Value> {
        if self.body.is_empty() {
            return None;
        }
        serde_json::from_str(&self.body).ok()
    }

    /// Convenience: look up a header by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

/// A non-blocking mock HTTP server that records every inbound request.
pub struct MockServer {
    /// The `http://127.0.0.1:<port>` URL the client should connect to.
    pub url: String,
    /// Shared recorder — caller can `.lock()` to inspect.
    recorder: Arc<Mutex<Vec<RecordedRequest>>>,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockServer {
    /// Spawn a new server that replies to every request with `response_body`
    /// (as a `200 OK` JSON). The caller keeps the returned handle alive
    /// for the duration of the test; dropping it stops the server.
    pub fn new(response_body: impl Into<String>) -> Self {
        let response_body = response_body.into();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        listener
            .set_nonblocking(true)
            .expect("set mock server non-blocking");
        let addr = listener.local_addr().expect("mock server address");

        let recorder = Arc::new(Mutex::new(Vec::<RecordedRequest>::new()));
        let recorder_for_thread = Arc::clone(&recorder);
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = Arc::clone(&shutdown);

        let thread = thread::spawn(move || {
            while !shutdown_for_thread.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut buf = vec![0u8; 64 * 1024];
                        let n = match stream.read(&mut buf) {
                            Ok(n) => n,
                            Err(_) => continue,
                        };
                        let raw = String::from_utf8_lossy(&buf[..n]).to_string();
                        let recorded = parse_request(&raw);

                        recorder_for_thread
                            .lock()
                            .expect("lock recorder")
                            .push(recorded);

                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            response_body.len(),
                            response_body
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        });

        Self {
            url: format!("http://{}", addr),
            recorder,
            shutdown,
            thread: Some(thread),
        }
    }

    /// Current count of recorded requests.
    #[allow(dead_code)] // G8/G13/G14 parity tests (W7 remaining deferral) will consume this.
    pub fn count(&self) -> usize {
        self.recorder.lock().expect("lock recorder").len()
    }

    /// Clone of every recorded request so far (oldest first).
    pub fn recorded(&self) -> Vec<RecordedRequest> {
        self.recorder.lock().expect("lock recorder").clone()
    }

    /// Extract idempotency keys from the first-level `items[].idempotency_key`
    /// of every recorded request's JSON body. Returns in request order.
    /// Requests whose body isn't JSON or doesn't contain that path are
    /// skipped silently.
    pub fn recorded_idempotency_keys(&self) -> Vec<String> {
        self.recorded()
            .into_iter()
            .filter_map(|req| {
                req.json_body()
                    .and_then(|v| v.pointer("/items/0/idempotency_key").cloned())
                    .and_then(|v| v.as_str().map(str::to_string))
            })
            .collect()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Best-effort parse of a raw HTTP request into a `RecordedRequest`.
fn parse_request(raw: &str) -> RecordedRequest {
    let mut recorded = RecordedRequest::default();
    let (headers_part, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let mut lines = headers_part.lines();
    if let Some(request_line) = lines.next() {
        let mut parts = request_line.split_whitespace();
        recorded.method = parts.next().unwrap_or("").to_string();
        recorded.path = parts.next().unwrap_or("").to_string();
    }
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            recorded
                .headers
                .insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    recorded.body = body.to_string();
    recorded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    fn send_raw(url: &str, method: &str, path: &str, body: &str) {
        // url is "http://127.0.0.1:PORT"
        let host = url.trim_start_matches("http://");
        let mut stream = TcpStream::connect(host).expect("connect mock");
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).expect("write mock req");
        let mut discard = [0u8; 1024];
        let _ = stream.read(&mut discard); // drain response
    }

    #[test]
    fn fake_http_records_method_path_and_body() {
        let server = MockServer::new(r#"{"success":true}"#);
        send_raw(
            &server.url,
            "POST",
            "/api/pos/payments",
            r#"{"hello":"world"}"#,
        );
        // Allow the accept loop to consume the request.
        thread::sleep(Duration::from_millis(150));

        let recorded = server.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "POST");
        assert_eq!(recorded[0].path, "/api/pos/payments");
        assert!(recorded[0].body.contains("\"hello\":\"world\""));
    }

    #[test]
    fn fake_http_recorded_idempotency_keys_extracts_first_item_key() {
        let server = MockServer::new(r#"{"success":true}"#);
        send_raw(
            &server.url,
            "POST",
            "/api/pos/financial/sync",
            r#"{"items":[{"idempotency_key":"key-a","entity_id":"p1"}]}"#,
        );
        send_raw(
            &server.url,
            "POST",
            "/api/pos/financial/sync",
            r#"{"items":[{"idempotency_key":"key-b","entity_id":"p2"}]}"#,
        );
        thread::sleep(Duration::from_millis(200));

        let keys = server.recorded_idempotency_keys();
        assert_eq!(keys, vec!["key-a".to_string(), "key-b".to_string()]);
    }

    #[test]
    fn fake_http_header_lookup_is_case_insensitive() {
        let server = MockServer::new(r#"{}"#);
        let host = server.url.trim_start_matches("http://");
        let mut stream = TcpStream::connect(host).expect("connect");
        let req = format!(
            "GET /test HTTP/1.1\r\nX-POS-API-Key: abc123\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut discard = [0u8; 1024];
        let _ = stream.read(&mut discard);
        thread::sleep(Duration::from_millis(150));

        let recorded = server.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].header("X-POS-API-Key"), Some("abc123"));
        assert_eq!(recorded[0].header("x-pos-api-key"), Some("abc123"));
    }

    #[test]
    fn fake_http_shuts_down_on_drop() {
        let url;
        {
            let server = MockServer::new(r#"{}"#);
            url = server.url.clone();
            send_raw(&server.url, "GET", "/", "");
            thread::sleep(Duration::from_millis(50));
        }
        // Server has been dropped — connecting should either fail or
        // accept and immediately close. Either outcome is acceptable
        // here; we just assert drop doesn't hang.
        let host = url.trim_start_matches("http://");
        let _ = TcpStream::connect(host);
    }
}
