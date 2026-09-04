//! Raw-body admin transport tests (`admin_fetch_raw`).
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — decision **D11**,
//! task 8.2. Requirement R17.4.
//!
//! `admin_fetch_raw` exists for exactly one reason: a captured invoice page is
//! bytes, and `admin_fetch` carries JSON. Everything else about the two calls
//! must be the same call — same `/api/pos` allowlist, same keyring credentials,
//! same terminal identity, same error mapping — because the whole point of
//! R17.4 is that captured documents leave the terminal only over the client's
//! existing authenticated, terminal-scoped channel.
//!
//! These tests pin that "everything else is the same" claim behaviourally
//! rather than by inspection: where a property is shared, the raw call is
//! asserted against the JSON call's actual output, not against a restatement
//! of it.
//!
//! The mock servers here are local `TcpListener`s, so a test that asserts
//! "nothing left the terminal" can prove it by counting connections rather
//! than trusting an error string.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::api::{self, AdminFetchError};
use crate::tests::fake_http::{MockServer, RecordedRequest};
use crate::tests::fake_keyring;

const API_KEY: &str = "pos-api-key-for-tests";
const TERMINAL_ID: &str = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CAPTURE_PATH: &str =
    "/api/pos/suppliers/import/attachments?captureId=capture-a&pageIndex=0&kind=page";
const OCTET_STREAM: &str = "application/octet-stream";

/// A page's worth of bytes. ASCII on purpose: the mock server records bodies
/// as lossy UTF-8, and this test cares about "the body arrived verbatim", not
/// about exercising the UTF-8 replacement path.
const PAGE_BYTES: &[u8] = b"PNG-ish page bytes for capture-a page 0";

/// Seed the keyring the way a provisioned terminal is set up: API key,
/// terminal identity, and the dashboard URL pointing at a local mock.
fn install_terminal(admin_url: &str) -> fake_keyring::Guard {
    fake_keyring::install_seeded([
        ("pos_api_key", API_KEY),
        ("terminal_id", TERMINAL_ID),
        ("admin_dashboard_url", admin_url),
    ])
}

/// The capture metadata that rides outside the body (D11).
fn capture_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("x-capture-content-type", "image/png"),
        (
            "x-capture-content-hash",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
    ]
}

// ---------------------------------------------------------------------------
// A mock that answers with a chosen status, so error mapping can be compared
// ---------------------------------------------------------------------------

struct StatusServer {
    url: String,
    hits: Arc<AtomicUsize>,
    thread: Option<JoinHandle<()>>,
}

impl StatusServer {
    /// Answer the next two requests with `status_line` and `body`, then stop.
    /// Two, because the parity test sends the same failing request through both
    /// transports.
    fn new(status_line: &str, body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind status server");
        let addr = listener.local_addr().expect("status server address");
        let response = format!(
            "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_thread = Arc::clone(&hits);

        let thread = thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buf = vec![0u8; 16 * 1024];
                let _ = stream.read(&mut buf);
                hits_for_thread.fetch_add(1, Ordering::SeqCst);
                let _ = stream.write_all(response.as_bytes());
            }
        });

        Self {
            url: format!("http://{addr}"),
            hits,
            thread: Some(thread),
        }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for StatusServer {
    fn drop(&mut self) {
        // The accept loop exits after two requests; a test that sends fewer
        // leaves it parked on accept, so connect once to unblock it.
        if self.hits() < 2 {
            let host = self.url.trim_start_matches("http://").to_string();
            let _ = std::net::TcpStream::connect(host);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn only_request(server: &MockServer) -> RecordedRequest {
    let recorded = server.recorded();
    assert_eq!(recorded.len(), 1, "expected exactly one request");
    recorded.into_iter().next().expect("one request")
}

// ---------------------------------------------------------------------------
// Allowlist enforcement — the reason this helper lives beside `admin_fetch`
// ---------------------------------------------------------------------------

/// R17.4: a raw upload can reach no path a JSON call could not, and a refused
/// path never opens a socket. Proven by connection count, not by error text.
#[tokio::test]
async fn raw_upload_enforces_the_same_pos_path_allowlist_as_admin_fetch() {
    let server = MockServer::new(r#"{"success":true}"#);
    let _keyring = install_terminal(&server.url);

    let blocked = [
        // Outside the POS surface entirely.
        "/api/admin/organizations",
        "/api/internal/debug",
        // Not an API path at all.
        "/dashboard",
        // Absolute URLs would redirect the bytes to a third party (R17.4).
        "https://evil.example.com/api/pos/suppliers/import/attachments",
        // Traversal, raw and percent-encoded.
        "/api/pos/../admin/organizations",
        "/api/pos/%2e%2e/admin/organizations",
        // Empty.
        "",
    ];

    for path in blocked {
        let error = crate::admin_fetch_raw(
            None,
            path,
            "POST",
            OCTET_STREAM,
            &capture_headers(),
            PAGE_BYTES.to_vec(),
        )
        .await
        .expect_err("path outside the allowlist must be refused");

        // A refusal before any request is made carries no HTTP status.
        assert_eq!(error.status(), None, "path {path} must fail before sending");
    }

    assert_eq!(
        server.count(),
        0,
        "not one byte may leave the terminal for a path outside the allowlist",
    );

    // The control: the real capture path is accepted by the same validator and
    // does reach the server.
    crate::admin_fetch_raw(
        None,
        CAPTURE_PATH,
        "POST",
        OCTET_STREAM,
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .expect("the attachments route is inside the POS allowlist");

    assert_eq!(server.count(), 1);
}

// ---------------------------------------------------------------------------
// Header passthrough
// ---------------------------------------------------------------------------

/// D11: the page rides as a raw body with its metadata in headers and query
/// params. Everything the server needs must arrive, and the body must arrive
/// byte-for-byte — the route re-computes the SHA-256 and rejects a mismatch.
#[tokio::test]
async fn raw_upload_passes_capture_headers_and_the_body_through_verbatim() {
    let server = MockServer::new(r#"{"success":true,"captureId":"capture-a"}"#);
    let _keyring = install_terminal(&server.url);

    let response = crate::admin_fetch_raw(
        None,
        CAPTURE_PATH,
        "POST",
        OCTET_STREAM,
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .expect("raw upload succeeds");

    assert_eq!(
        response.get("captureId").and_then(|v| v.as_str()),
        Some("capture-a"),
    );

    let request = only_request(&server);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, CAPTURE_PATH);

    // The caller's Content-Type, not a JSON one.
    assert_eq!(request.header("content-type"), Some(OCTET_STREAM));

    // The capture metadata the route reads outside the body.
    assert_eq!(request.header("x-capture-content-type"), Some("image/png"));
    assert_eq!(
        request.header("x-capture-content-hash"),
        Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
    );

    // The terminal-scoped authentication every POS call carries (R17.4).
    assert_eq!(request.header("x-pos-api-key"), Some(API_KEY));
    assert_eq!(request.header("x-terminal-id"), Some(TERMINAL_ID));
    assert_eq!(
        request.header("x-pos-client-version"),
        Some(env!("CARGO_PKG_VERSION")),
    );

    assert_eq!(request.body.as_bytes(), PAGE_BYTES);
    assert_eq!(
        request.header("content-length"),
        Some(PAGE_BYTES.len().to_string().as_str()),
    );
}

/// A caller header must never be able to restate terminal identity, the API
/// key, or the request's own framing — a silent override would let a bug
/// upload a page under someone else's terminal.
#[tokio::test]
async fn raw_upload_refuses_headers_the_transport_owns() {
    let server = MockServer::new(r#"{"success":true}"#);
    let _keyring = install_terminal(&server.url);

    for reserved in [
        ("x-terminal-id", "11111111-1111-1111-1111-111111111111"),
        ("X-POS-API-Key", "stolen-key"),
        ("Content-Type", "application/json"),
        ("content-length", "0"),
        ("Host", "evil.example.com"),
        ("x-pos-client-version", "0.0.0"),
    ] {
        let error = crate::admin_fetch_raw(
            None,
            CAPTURE_PATH,
            "POST",
            OCTET_STREAM,
            &[reserved],
            PAGE_BYTES.to_vec(),
        )
        .await
        .expect_err("a reserved header must be refused, not silently dropped");

        assert!(
            error.to_string().contains("cannot be overridden"),
            "unexpected error for {}: {error}",
            reserved.0,
        );
    }

    // Header names and values are validated too, so nothing can smuggle a
    // second request line into the stream.
    for hostile in [
        ("x-capture\r\nX-Injected", "value"),
        ("x-ok", "bad\r\nvalue"),
    ] {
        assert!(
            crate::admin_fetch_raw(
                None,
                CAPTURE_PATH,
                "POST",
                OCTET_STREAM,
                &[hostile],
                PAGE_BYTES.to_vec(),
            )
            .await
            .is_err(),
            "{hostile:?} must be refused",
        );
    }

    // An empty Content-Type is a caller bug, not a default.
    assert!(crate::admin_fetch_raw(
        None,
        CAPTURE_PATH,
        "POST",
        "   ",
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .is_err());

    assert_eq!(
        server.count(),
        0,
        "a refused header must stop the request before it is sent",
    );
}

// ---------------------------------------------------------------------------
// Error-mapping parity with `admin_fetch`
// ---------------------------------------------------------------------------

/// The capture worker parks on `MODULE_REQUIRED` by reading the typed code off
/// the error, exactly as every other POS call does. That only holds if the raw
/// transport maps errors through the same code — so this asserts the raw
/// error *equals* the JSON error for the same response, rather than restating
/// what the mapping should produce.
#[tokio::test]
async fn raw_upload_maps_errors_identically_to_admin_fetch() {
    let body = r#"{"error":"The suppliers feature is not active","code":"MODULE_REQUIRED"}"#;
    let server = StatusServer::new("HTTP/1.1 403 Forbidden", body);
    let _keyring = install_terminal(&server.url);

    let json_error = api::fetch_from_admin_detailed(
        &server.url,
        API_KEY,
        "/api/pos/suppliers/import/attachments",
        "POST",
        Some(serde_json::json!({})),
    )
    .await
    .expect_err("403 must be an error");

    let raw_error = api::fetch_raw_from_admin_detailed(
        &server.url,
        API_KEY,
        "/api/pos/suppliers/import/attachments",
        "POST",
        OCTET_STREAM,
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .expect_err("403 must be an error");

    assert_eq!(raw_error.status(), json_error.status());
    assert_eq!(raw_error.status(), Some(403));
    assert_eq!(raw_error.code(), json_error.code());
    assert_eq!(raw_error.code(), Some("MODULE_REQUIRED"));
    assert_eq!(raw_error.to_string(), json_error.to_string());
    assert_eq!(server.hits(), 2, "both transports reached the server");
}

/// The transport-security refusals are shared too: a non-local plain-HTTP
/// dashboard URL is rejected before a page can be uploaded over the clear.
#[tokio::test]
async fn raw_upload_refuses_a_non_local_plain_http_dashboard() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);

    let json_error = api::fetch_from_admin_detailed(
        "http://admin.example.com",
        API_KEY,
        "/api/pos/suppliers/import/attachments",
        "POST",
        None,
    )
    .await
    .expect_err("plain HTTP must be refused");

    let raw_error = api::fetch_raw_from_admin_detailed(
        "http://admin.example.com",
        API_KEY,
        "/api/pos/suppliers/import/attachments",
        "POST",
        OCTET_STREAM,
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .expect_err("plain HTTP must be refused");

    assert_eq!(raw_error.to_string(), json_error.to_string());
    assert!(raw_error.to_string().contains("plain HTTP"));
    assert_eq!(raw_error.status(), None);
}

/// R17.4 again, from the identity side: without a terminal identity there is no
/// terminal-scoped channel, so there is no upload.
#[tokio::test]
async fn raw_upload_requires_a_terminal_identity() {
    let server = MockServer::new(r#"{"success":true}"#);
    let _keyring = fake_keyring::install_seeded([
        ("pos_api_key", API_KEY),
        ("admin_dashboard_url", server.url.as_str()),
    ]);

    let error = crate::admin_fetch_raw(
        None,
        CAPTURE_PATH,
        "POST",
        OCTET_STREAM,
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .expect_err("an unidentified terminal must not upload");

    assert!(
        error.to_string().contains("TERMINAL_MANAGED_TUPLE_MISSING"),
        "unexpected error: {error}",
    );
    assert_eq!(server.count(), 0);
}

/// The credential half is shared as well: no keyring API key, no upload — and
/// the failure is the same one `admin_fetch` produces.
#[tokio::test]
async fn raw_upload_requires_the_keyring_api_key() {
    let server = MockServer::new(r#"{"success":true}"#);
    let _keyring = fake_keyring::install_seeded([
        ("terminal_id", TERMINAL_ID),
        ("admin_dashboard_url", server.url.as_str()),
    ]);

    let raw_error = crate::admin_fetch_raw(
        None,
        CAPTURE_PATH,
        "POST",
        OCTET_STREAM,
        &capture_headers(),
        PAGE_BYTES.to_vec(),
    )
    .await
    .expect_err("no API key means no upload");

    let json_error: AdminFetchError = crate::admin_fetch_detailed(None, CAPTURE_PATH, "POST", None)
        .await
        .expect_err("no API key means no call");

    assert_eq!(raw_error.to_string(), json_error.to_string());
    assert!(raw_error.to_string().contains("missing API key"));
    assert_eq!(server.count(), 0);
}
