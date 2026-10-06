//! Authenticated LAN transport to the canonical HTTPS API. No offline write ACKs.
use ring::{
    aead, digest, hmac,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub const PORT: u16 = 8765;
const MAX_FRAME: usize = 1_100_000;
const MAX_PLAIN: usize = 256 * 1024;
const KEY_PREFIX: &str = "cafe_lan_pair_v1:";
/// A timestamped waiter frame must reach the main within this window, either
/// direction (clock skew included).
const FRAME_WINDOW_MS: u64 = 10 * 60 * 1000;
/// Nonces outlive the freshness window, so a timestamped frame can never be
/// replayed; older history is pruned instead of exhausting the pair.
const NONCE_RETENTION_SECS: i64 = 60 * 60;
/// Mutation receipts expire after a week; the oldest settled ones give way
/// when a child's count or stored size reaches its cap.
const RECEIPT_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;
const MAX_RECEIPTS_PER_CHILD: i64 = 5_000;
const MAX_RECEIPT_BYTES_PER_CHILD: i64 = 64 * 1024 * 1024;
/// A dispatch claim younger than this is in flight: never pruned or taken over.
const DISPATCH_CLAIM_SECS: i64 = 120;
/// Canonical refusals that stay the same for the same request bytes. Any other
/// 4xx (408, 409, 423, 425, 429, or a reply asking to retry the same identity)
/// may change on the next attempt and is never retained.
const DETERMINISTIC_REFUSALS: [u16; 6] = [400, 405, 410, 413, 415, 422];

#[derive(Default)]
pub struct LanTransportState {
    running: Mutex<Option<Running>>,
    transitions: tokio::sync::Mutex<()>,
    reset_fenced: std::sync::atomic::AtomicBool,
}
struct Running {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
const ENABLED_SETTING: &str = "cafe_lan_receiver_enabled";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Scope {
    organization_id: String,
    branch_id: String,
    parent_terminal_id: String,
    source_terminal_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Frame {
    version: u8,
    #[serde(flatten)]
    scope: Scope,
    request_id: String,
    nonce: String,
    ciphertext: String,
    mac: String,
}

#[derive(Deserialize)]
struct Request {
    method: String,
    path: String,
    body: Option<String>,
    idempotency_key: Option<String>,
    api_key: String,
    staff_session_id: Option<String>,
    payment_capabilities: Option<String>,
    /// Waiter clock (epoch milliseconds) when the frame was sealed. Absent
    /// from waiters older than Android 1.0.20; never part of the identity.
    sent_at: Option<i64>,
}
impl Drop for Request {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.api_key.zeroize();
        if let Some(body) = self.body.as_mut() {
            body.zeroize();
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Pair {
    #[serde(flatten)]
    scope: Scope,
    secret_hex: String,
}
impl Drop for Pair {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.secret_hex.zeroize();
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(text: &str, length: usize) -> Result<Vec<u8>, String> {
    if text.len() != length * 2
        || !text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("LAN_INVALID_HEX".into());
    }
    (0..length)
        .map(|i| {
            u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| "LAN_INVALID_HEX".into())
        })
        .collect()
}
fn random_hex(length: usize) -> Result<String, String> {
    let mut bytes = Zeroizing::new(vec![0; length]);
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "LAN_RANDOM_UNAVAILABLE")?;
    Ok(hex(&bytes))
}
fn aad(frame: &Frame, direction: &str) -> String {
    json!([
        "cafe-lan-v1",
        direction,
        frame.scope.organization_id,
        frame.scope.branch_id,
        frame.scope.parent_terminal_id,
        frame.scope.source_terminal_id,
        frame.request_id,
        frame.nonce
    ])
    .to_string()
}
fn receipt_aad(frame: &Frame, hash: &str) -> String {
    json!([
        "cafe-lan-receipt-v1",
        frame.scope.organization_id,
        frame.scope.branch_id,
        frame.scope.parent_terminal_id,
        frame.scope.source_terminal_id,
        frame.request_id,
        hash
    ])
    .to_string()
}
fn encrypt(secret: &[u8], aad: &str, plain: &[u8]) -> Result<String, String> {
    if plain.len() > MAX_PLAIN {
        return Err("LAN_RESPONSE_TOO_LARGE".into());
    }
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, secret).map_err(|_| "LAN_INVALID_KEY")?,
    );
    let mut nonce = [0; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "LAN_RANDOM_UNAVAILABLE")?;
    let mut buffer = Zeroizing::new(plain.to_vec());
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(aad.as_bytes()),
        &mut *buffer,
    )
    .map_err(|_| "LAN_ENCRYPTION_FAILED")?;
    Ok(format!("v1:{}:{}", hex(&nonce), hex(&buffer)))
}
fn decrypt(secret: &[u8], aad: &str, ciphertext: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let parts: Vec<_> = ciphertext.split(':').collect();
    if parts.len() != 3
        || parts[0] != "v1"
        || parts[2].len() > 2 * (MAX_PLAIN + 16)
        || parts[2].len() < 32
    {
        return Err("LAN_INVALID_CIPHERTEXT".into());
    }
    let nonce = unhex(parts[1], 12)?;
    let mut buffer = Zeroizing::new(unhex(parts[2], parts[2].len() / 2)?);
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, secret).map_err(|_| "LAN_INVALID_KEY")?,
    );
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| "LAN_INVALID_NONCE")?;
    let length = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad.as_bytes()),
            &mut buffer,
        )
        .map_err(|_| "LAN_AUTHENTICATION_FAILED")?
        .len();
    buffer.truncate(length);
    Ok(buffer)
}
fn mac_key(secret: &[u8]) -> hmac::Key {
    let derived = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, secret),
        b"cafe-lan-v1:mac",
    );
    hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref())
}
fn verify(frame: &Frame, secret: &[u8]) -> Result<(), String> {
    if frame.version != 1
        || frame.request_id.len() > 64
        || !(uuid::Uuid::parse_str(&frame.request_id).is_ok()
            || unhex(&frame.request_id, 32).is_ok())
    {
        return Err("LAN_INVALID_FRAME".into());
    }
    unhex(&frame.nonce, 16)?;
    pair_key(&frame.scope.source_terminal_id)?;
    pair_key(&frame.scope.parent_terminal_id)?;
    for id in [&frame.scope.organization_id, &frame.scope.branch_id] {
        uuid::Uuid::parse_str(id).map_err(|_| "LAN_INVALID_SCOPE")?;
    }
    let signed = format!("{}\n{}", aad(frame, "request"), frame.ciphertext);
    hmac::verify(&mac_key(secret), signed.as_bytes(), &unhex(&frame.mac, 32)?)
        .map_err(|_| "LAN_AUTHENTICATION_FAILED".into())
}
fn response_frame(frame: &Frame, secret: &[u8], response: &Value) -> Result<Frame, String> {
    let mut result = frame.clone();
    result.ciphertext = encrypt(
        secret,
        &aad(frame, "response"),
        response.to_string().as_bytes(),
    )?;
    result.mac = hex(hmac::sign(
        &mac_key(secret),
        format!("{}\n{}", aad(frame, "response"), result.ciphertext).as_bytes(),
    )
    .as_ref());
    Ok(result)
}

fn journal_error<E>(_: E) -> String {
    "LAN_JOURNAL_UNAVAILABLE".into()
}
fn schema(conn: &Connection) -> Result<(), String> {
    let current: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='cafe_lan_receipt_usage_delete')",
            [],
            |r| r.get(0),
        )
        .map_err(journal_error)?;
    if current {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(journal_error)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS cafe_lan_receipts_v1 (
        child_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        path TEXT NOT NULL, response_ciphertext TEXT, state TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(child_id,request_id));
        CREATE TABLE IF NOT EXISTS cafe_lan_nonces_v1 (
        child_id TEXT NOT NULL, nonce TEXT NOT NULL, PRIMARY KEY(child_id,nonce));",
    )
    .map_err(journal_error)?;
    // Desktop 1.4.124 bounds the journal. Nonces carry the time they were seen;
    // existing history counts from now, so it still expires after one window.
    let timestamped: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cafe_lan_nonces_v1') WHERE name='seen_at')",
            [],
            |r| r.get(0),
        )
        .map_err(journal_error)?;
    if !timestamped {
        tx.execute_batch(
            "ALTER TABLE cafe_lan_nonces_v1 ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0",
        )
        .map_err(journal_error)?;
        tx.execute(
            "UPDATE cafe_lan_nonces_v1 SET seen_at=?1",
            [chrono::Utc::now().timestamp()],
        )
        .map_err(journal_error)?;
    }
    // Reads never needed a receipt; drop those an older build kept for every
    // order poll and table read (these families are read-only on the LAN).
    // Receipt count and stored size are then kept by triggers, so making room
    // never re-scans the stored replies under the database lock.
    tx.execute_batch(
        "DELETE FROM cafe_lan_receipts_v1 WHERE path IN ('pos/orders/sync','pos/tables');
        CREATE INDEX IF NOT EXISTS cafe_lan_receipts_v1_age ON cafe_lan_receipts_v1(child_id,updated_at);
        CREATE INDEX IF NOT EXISTS cafe_lan_nonces_v1_age ON cafe_lan_nonces_v1(child_id,seen_at);
        CREATE TABLE IF NOT EXISTS cafe_lan_usage_v1 (child_id TEXT PRIMARY KEY,
        receipts INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
        DELETE FROM cafe_lan_usage_v1;
        INSERT INTO cafe_lan_usage_v1(child_id,receipts,bytes)
        SELECT child_id,count(*),coalesce(sum(length(response_ciphertext)),0)
        FROM cafe_lan_receipts_v1 GROUP BY child_id;
        CREATE TRIGGER IF NOT EXISTS cafe_lan_receipt_usage_insert AFTER INSERT ON cafe_lan_receipts_v1 BEGIN
        INSERT OR IGNORE INTO cafe_lan_usage_v1(child_id) VALUES (NEW.child_id);
        UPDATE cafe_lan_usage_v1 SET receipts=receipts+1,
        bytes=bytes+length(coalesce(NEW.response_ciphertext,'')) WHERE child_id=NEW.child_id;
        END;
        CREATE TRIGGER IF NOT EXISTS cafe_lan_receipt_usage_update AFTER UPDATE OF response_ciphertext ON cafe_lan_receipts_v1 BEGIN
        UPDATE cafe_lan_usage_v1 SET bytes=bytes-length(coalesce(OLD.response_ciphertext,''))
        +length(coalesce(NEW.response_ciphertext,'')) WHERE child_id=NEW.child_id;
        END;
        CREATE TRIGGER IF NOT EXISTS cafe_lan_receipt_usage_delete AFTER DELETE ON cafe_lan_receipts_v1 BEGIN
        UPDATE cafe_lan_usage_v1 SET receipts=receipts-1,
        bytes=bytes-length(coalesce(OLD.response_ciphertext,'')) WHERE child_id=OLD.child_id;
        END;",
    )
    .map_err(journal_error)?;
    tx.commit().map_err(journal_error)
}
/// Admits an authenticated delivery once, before any cloud call: a stale
/// timestamp or a replayed nonce is refused locally. Older waiters send no
/// timestamp; their frames keep the nonce check.
fn admit_frame(
    conn: &Connection,
    frame: &Frame,
    request: &Request,
    now_ms: i64,
) -> Result<(), String> {
    if request
        .sent_at
        .is_some_and(|sent_at| now_ms.abs_diff(sent_at) > FRAME_WINDOW_MS)
    {
        return Err("LAN_FRAME_EXPIRED".into());
    }
    schema(conn)?;
    let now = now_ms.div_euclid(1000);
    let tx = conn.unchecked_transaction().map_err(journal_error)?;
    tx.execute(
        "DELETE FROM cafe_lan_nonces_v1 WHERE child_id=?1 AND seen_at<?2",
        params![frame.scope.source_terminal_id, now - NONCE_RETENTION_SECS],
    )
    .map_err(journal_error)?;
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO cafe_lan_nonces_v1(child_id,nonce,seen_at) VALUES(?1,?2,?3)",
            params![frame.scope.source_terminal_id, frame.nonce, now],
        )
        .map_err(journal_error)?;
    if inserted == 0 {
        return Err("LAN_NONCE_REPLAY".into());
    }
    tx.commit().map_err(journal_error)
}
fn receipt_usage(conn: &Connection, child: &str) -> Result<(i64, i64), String> {
    conn.query_row(
        "SELECT receipts,bytes FROM cafe_lan_usage_v1 WHERE child_id=?1",
        [child],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map(|usage| usage.unwrap_or((0, 0)))
    .map_err(journal_error)
}
/// Makes room for one more receipt without refusing the waiter: receipts
/// expire by age, then the oldest settled ones give way to the count and size
/// caps. In-flight dispatch claims are never removed.
fn make_room(conn: &Connection, child: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM cafe_lan_receipts_v1 WHERE child_id=?1 AND updated_at<?2",
        params![child, now - RECEIPT_RETENTION_SECS],
    )
    .map_err(journal_error)?;
    let oldest = "DELETE FROM cafe_lan_receipts_v1 WHERE rowid IN (
        SELECT rowid FROM cafe_lan_receipts_v1 WHERE child_id=?1
        AND NOT (state='dispatching' AND updated_at>=?2) ORDER BY updated_at,rowid LIMIT ?3)";
    let (receipts, _) = receipt_usage(conn, child)?;
    if receipts >= MAX_RECEIPTS_PER_CHILD {
        conn.execute(
            oldest,
            params![
                child,
                now - DISPATCH_CLAIM_SECS,
                receipts - MAX_RECEIPTS_PER_CHILD + 1
            ],
        )
        .map_err(journal_error)?;
    }
    for _ in 0..64 {
        if receipt_usage(conn, child)?.1 < MAX_RECEIPT_BYTES_PER_CHILD {
            break;
        }
        let removed = conn
            .execute(oldest, params![child, now - DISPATCH_CLAIM_SECS, 256])
            .map_err(journal_error)?;
        if removed == 0 {
            break;
        }
    }
    let (receipts, bytes) = receipt_usage(conn, child)?;
    if receipts >= MAX_RECEIPTS_PER_CHILD || bytes >= MAX_RECEIPT_BYTES_PER_CHILD {
        return Err("LAN_PAIR_CAPACITY_ROTATE_REQUIRED".into());
    }
    Ok(())
}
enum Receipt {
    Dispatch,
    Cached(String),
    Busy,
}
/// Claims the receipt of one mutation (reads keep none). Nonces are admitted
/// separately, before any cloud call.
fn begin_receipt(
    conn: &Connection,
    frame: &Frame,
    hash: &str,
    path: &str,
) -> Result<Receipt, String> {
    schema(conn)?;
    let now = chrono::Utc::now().timestamp();
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    let existing:Option<(String,Option<String>,String,i64)>=tx.query_row(
        "SELECT request_hash,response_ciphertext,state,updated_at FROM cafe_lan_receipts_v1 WHERE child_id=?1 AND request_id=?2",
        params![frame.scope.source_terminal_id,frame.request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
        .optional().map_err(|_|"LAN_JOURNAL_UNAVAILABLE")?;
    if existing.as_ref().is_some_and(|row| row.0 != hash) {
        return Err("LAN_REQUEST_ID_CONFLICT".into());
    }
    if existing.is_none() {
        make_room(&tx, &frame.scope.source_terminal_id, now)?;
    }
    let result = match existing {
        Some((_, Some(response), _, _)) => Receipt::Cached(response),
        Some((_, None, state, updated))
            if state == "dispatching" && now - updated < DISPATCH_CLAIM_SECS =>
        {
            Receipt::Busy
        }
        _ => {
            tx.execute("INSERT INTO cafe_lan_receipts_v1(child_id,request_id,request_hash,path,state,updated_at)
                VALUES(?1,?2,?3,?4,'dispatching',?5) ON CONFLICT(child_id,request_id)
                DO UPDATE SET state='dispatching',updated_at=excluded.updated_at",
                params![frame.scope.source_terminal_id,frame.request_id,hash,path.split('?').next().unwrap_or(""),now]).map_err(|_|"LAN_JOURNAL_UNAVAILABLE")?;
            Receipt::Dispatch
        }
    };
    tx.commit().map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    Ok(result)
}
#[derive(Debug, PartialEq, Eq)]
enum ReplyClass {
    /// 2xx or a deterministic refusal: the final canonical answer for these bytes.
    Final,
    /// A refusal that may change on the next attempt; relayed once, never retained.
    Retry,
    /// 202, 1xx, 3xx or 5xx: the cloud outcome is unknown.
    Uncertain,
}
fn reply_class(status: u16, body: &Value) -> ReplyClass {
    let asks_retry = ["retryable", "retry_same_identity"]
        .iter()
        .any(|key| body.get(*key).and_then(Value::as_bool) == Some(true));
    match status {
        202 => ReplyClass::Uncertain,
        200..=299 => ReplyClass::Final,
        400..=499 if DETERMINISTIC_REFUSALS.contains(&status) && !asks_retry => ReplyClass::Final,
        400..=499 => ReplyClass::Retry,
        _ => ReplyClass::Uncertain,
    }
}
fn wire_is_final(wire: &Value) -> bool {
    wire["status"]
        .as_u64()
        .and_then(|status| u16::try_from(status).ok())
        .is_some_and(|status| reply_class(status, &wire["data"]) == ReplyClass::Final)
}
/// Retains a canonical reply only when it is the final answer for this exact
/// request (a 2xx or a deterministic refusal). A retry-class refusal (408,
/// 409, 429, a reply asking to retry the same identity...) is never retained:
/// the attempt is left pending, so the next delivery of the same operation
/// asks the cloud again instead of replaying a stale refusal forever.
/// Returns whether the reply was retained.
fn persist_response(
    conn: &Connection,
    frame: &Frame,
    hash: &str,
    secret: &[u8],
    response: &Value,
) -> Result<bool, String> {
    if !wire_is_final(&response["wire"]) {
        pending(conn, frame);
        return Ok(false);
    }
    let encrypted = encrypt(
        secret,
        &receipt_aad(frame, hash),
        response.to_string().as_bytes(),
    )?;
    let changed = conn
        .execute(
            "UPDATE cafe_lan_receipts_v1 SET response_ciphertext=?1,state='received',updated_at=?2
        WHERE child_id=?3 AND request_id=?4 AND request_hash=?5",
            params![
                encrypted,
                chrono::Utc::now().timestamp(),
                frame.scope.source_terminal_id,
                frame.request_id,
                hash
            ],
        )
        .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    if changed != 1 {
        return Err("LAN_JOURNAL_IDENTITY_CHANGED".into());
    }
    Ok(true)
}
fn pending(conn: &Connection, frame: &Frame) {
    let _=conn.execute("UPDATE cafe_lan_receipts_v1 SET state='pending' WHERE child_id=?1 AND request_id=?2 AND response_ciphertext IS NULL",
        params![frame.scope.source_terminal_id,frame.request_id]);
}
/// Takes over a receipt whose retained reply is not final (desktop builds
/// before 1.4.124 retained retry-class refusals). Exactly one delivery wins;
/// a concurrent one sees the claim and reports the request as in progress.
fn reclaim_receipt(
    conn: &Connection,
    frame: &Frame,
    hash: &str,
    encrypted: &str,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE cafe_lan_receipts_v1 SET response_ciphertext=NULL,state='dispatching',updated_at=?1
        WHERE child_id=?2 AND request_id=?3 AND request_hash=?4 AND response_ciphertext=?5",
        params![
            chrono::Utc::now().timestamp(),
            frame.scope.source_terminal_id,
            frame.request_id,
            hash,
            encrypted
        ],
    )
    .map(|changed| changed == 1)
    .map_err(journal_error)
}
fn request_hash(request: &Request) -> String {
    let identity = json!([
        request.method,
        request.path,
        request.body,
        request.idempotency_key,
        request
            .payment_capabilities
            .as_deref()
            .filter(|s| !s.is_empty())
    ])
    .to_string();
    hex(digest::digest(&digest::SHA256, identity.as_bytes()).as_ref())
}
fn stable(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|v| !v.trim().is_empty() && v.len() <= 255)
}
fn allowed(request: &Request) -> Result<(), String> {
    if !["GET", "POST", "PATCH"].contains(&request.method.as_str())
        || request.path.len() > 2048
        || request.path.contains(['#', '\\'])
        || request.path.chars().any(|c| c.is_control())
    {
        return Err("LAN_PATH_DENIED".into());
    }
    let path = request.path.split('?').next().unwrap_or("");
    if path.contains('%') {
        return Err("LAN_PATH_DENIED".into());
    }
    let parts: Vec<_> = path.split('/').collect();
    let uuid_at = |n: usize| {
        parts
            .get(n)
            .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
    };
    let get = request.method == "GET";
    let permitted = match parts.as_slice() {
        ["pos", "orders"] | ["pos", "orders", "sync"] => true,
        ["pos", "payments"] => request.method == "POST",
        ["pos", "table-sessions"] => get || request.method == "POST",
        ["pos", "tables"] => get,
        ["pos", "table-sessions", _] => uuid_at(2) && (get || request.method == "PATCH"),
        ["pos", "table-sessions", _, "items", "transfer"] => uuid_at(2) && request.method == "POST",
        ["pos", "table-sessions", _, "items", _] => {
            uuid_at(2) && uuid_at(4) && request.method == "PATCH"
        }
        ["pos", "tables", _] => uuid_at(2) && (get || request.method == "PATCH"),
        _ => false,
    };
    if !permitted || (!get && request.path.contains('?')) {
        return Err("LAN_PATH_DENIED".into());
    }
    if request.api_key.is_empty()
        || request.api_key.len() > 8192
        || request.body.as_ref().is_some_and(|b| b.len() > MAX_PLAIN)
    {
        return Err("LAN_INVALID_REQUEST".into());
    }
    if let Some(session) = request.staff_session_id.as_deref() {
        uuid::Uuid::parse_str(session).map_err(|_| "LAN_INVALID_STAFF_SESSION")?;
    }
    if request
        .payment_capabilities
        .as_ref()
        .is_some_and(|s| s.len() > 255 || s.chars().any(|c| c.is_control()))
    {
        return Err("LAN_INVALID_CAPABILITIES".into());
    }
    if get {
        if request.body.is_some() {
            return Err("LAN_GET_BODY_DENIED".into());
        }
        return Ok(());
    }
    let value: Value = serde_json::from_str(
        request
            .body
            .as_deref()
            .ok_or("LAN_MUTATION_BODY_REQUIRED")?,
    )
    .map_err(|_| "LAN_INVALID_REQUEST")?;
    // Every relayed mutation is a JSON object, as on an Android main.
    if !value.is_object() {
        return Err("LAN_INVALID_REQUEST".into());
    }
    // Approval/PIN/token exchange is direct HTTPS only, including nested fields.
    fn sensitive(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(k, v)| {
                [
                    "pin",
                    "manager_pin",
                    "approval_token",
                    "approval_grant",
                    "cancellation_approval_token",
                ]
                .contains(&k.to_ascii_lowercase().as_str())
                    || sensitive(v)
            }),
            Value::Array(rows) => rows.iter().any(sensitive),
            _ => false,
        }
    }
    if sensitive(&value) {
        return Err("LAN_SENSITIVE_OPERATION_DENIED".into());
    }
    if path == "pos/payments" {
        if let (Some(header), Some(body)) = (
            request.idempotency_key.as_deref(),
            value.get("idempotency_key").and_then(Value::as_str),
        ) {
            if header != body {
                return Err("LAN_PAYMENT_IDENTITY_CONFLICT".into());
            }
        }
    }
    let identity = if path == "pos/payments" {
        stable(&value, "idempotency_key")
            || request
                .idempotency_key
                .as_ref()
                .is_some_and(|v| !v.is_empty() && v.len() <= 255)
    } else if path == "pos/orders" && request.method == "POST" {
        ["client_order_id", "client_request_id", "id"]
            .iter()
            .any(|key| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
            })
    } else if path == "pos/orders/sync" {
        stable(&value, "receipt_id")
            && value
                .get("operations")
                .and_then(Value::as_array)
                .is_some_and(|rows| {
                    !rows.is_empty()
                        && rows.len() <= 50
                        && rows.iter().all(|row| {
                            stable(row, "client_order_id")
                                && (row.get("operation").and_then(Value::as_str) == Some("insert")
                                    || stable(&row["data"], "client_event_id"))
                        })
                })
    } else {
        stable(&value, "client_event_id")
    };
    if !identity {
        return Err("LAN_CANONICAL_MUTATION_KEY_REQUIRED".into());
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "LAN_HTTPS_CLIENT_FAILED".into())
}
fn endpoint(origin: &str, path: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(origin).map_err(|_| "LAN_MAIN_ORIGIN_INVALID")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("LAN_HTTPS_ORIGIN_REQUIRED".into());
    }
    Ok(format!("{}/api/{path}", origin.trim_end_matches('/')))
}
/// A payment keyed only by its header carries the same key in its body. A
/// body that is not a JSON object is refused instead of panicking on insert.
fn outbound_body(path: &str, body: &str, idem: Option<&str>) -> Result<String, String> {
    let Some(idem) = idem.filter(|_| path == "pos/payments") else {
        return Ok(body.to_string());
    };
    let mut value: Value = serde_json::from_str(body).map_err(|_| "LAN_INVALID_REQUEST")?;
    if !stable(&value, "idempotency_key") {
        value
            .as_object_mut()
            .ok_or("LAN_INVALID_REQUEST")?
            .insert("idempotency_key".into(), json!(idem));
    }
    Ok(value.to_string())
}
async fn http(
    client: &reqwest::Client,
    origin: &str,
    path: &str,
    method: &str,
    key: &str,
    terminal: &str,
    body: Option<&str>,
    idem: Option<&str>,
    staff: Option<&str>,
    capabilities: Option<&str>,
) -> Result<(u16, Value), String> {
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "LAN_INVALID_METHOD")?;
    let mut builder = client
        .request(method, endpoint(origin, path)?)
        .header("x-terminal-id", terminal)
        .header("x-pos-api-key", key)
        .header("content-type", "application/json");
    if let Some(value) = capabilities {
        builder = builder.header("x-pos-capabilities", value);
    }
    if let Some(body) = body {
        builder = builder.body(outbound_body(path, body, idem)?);
    }
    if let Some(idem) = idem {
        builder = builder.header("idempotency-key", idem);
    }
    if let Some(staff) = staff {
        builder = builder.header("x-staff-session-id", staff);
    }
    let mut response = builder.send().await.map_err(|_| "LAN_CLOUD_UNCERTAIN")?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|n| n > MAX_PLAIN as u64)
    {
        return Err("LAN_CLOUD_RESPONSE_TOO_LARGE".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "LAN_CLOUD_UNCERTAIN")? {
        if bytes.len() + chunk.len() > MAX_PLAIN {
            return Err("LAN_CLOUD_RESPONSE_TOO_LARGE".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "LAN_CLOUD_INVALID_RESPONSE")?;
    if !value.is_object() {
        return Err("LAN_CLOUD_INVALID_RESPONSE".into());
    }
    Ok((status, value))
}
async fn main_authority(app: &tauri::AppHandle) -> Result<(String, String, String, Value), String> {
    let db = app.state::<crate::db::DbState>();
    let (origin, key) = crate::resolve_admin_endpoint(Some(&db))
        .await
        .map_err(|_| "LAN_MAIN_BINDING_UNAVAILABLE")?;
    let terminal = crate::storage::get_credential_strict("terminal_id")?
        .ok_or("LAN_MAIN_BINDING_UNAVAILABLE")?;
    let (status, body) = http(
        &client()?,
        &origin,
        "pos/lan/validate",
        "GET",
        &key,
        &terminal,
        None,
        None,
        None,
        None,
    )
    .await?;
    if status != 200
        || body.get("success").and_then(Value::as_bool) != Some(true)
        || body.get("parent_terminal_id").and_then(Value::as_str) != Some(terminal.as_str())
    {
        return Err("LAN_MAIN_AUTHORITY_DENIED".into());
    }
    Ok((
        origin,
        body.get("organization_id")
            .and_then(Value::as_str)
            .ok_or("LAN_MAIN_SCOPE_MISSING")?
            .into(),
        body.get("branch_id")
            .and_then(Value::as_str)
            .ok_or("LAN_MAIN_SCOPE_MISSING")?
            .into(),
        body,
    ))
}
fn pair_key(child: &str) -> Result<String, String> {
    if child.is_empty()
        || child.len() > 255
        || child.trim() != child
        || child.chars().any(|c| c.is_control())
    {
        return Err("LAN_INVALID_CHILD".into());
    }
    Ok(format!("{KEY_PREFIX}{child}"))
}
fn read_pair(child: &str) -> Result<Pair, String> {
    let value =
        crate::storage::get_lan_pair_record(&pair_key(child)?)?.ok_or("LAN_PAIR_NOT_FOUND")?;
    serde_json::from_str(&value).map_err(|_| "LAN_PAIR_INVALID".into())
}
pub async fn pair(app: &tauri::AppHandle, child: &str) -> Result<Value, String> {
    let state = app.state::<LanTransportState>();
    let _transition = state.transitions.lock().await;
    require_running_scope(&state)?;
    pair_key(child)?;
    let (_, org, branch, authority) = main_authority(app).await?;
    if !authority
        .get("children")
        .and_then(Value::as_array)
        .is_some_and(|rows| {
            rows.iter()
                .any(|row| row.get("terminal_id").and_then(Value::as_str) == Some(child))
        })
    {
        return Err("LAN_CHILD_PAIRING_DENIED".into());
    }
    let pair = Pair {
        scope: Scope {
            organization_id: org,
            branch_id: branch,
            parent_terminal_id: authority["parent_terminal_id"]
                .as_str()
                .unwrap_or("")
                .into(),
            source_terminal_id: child.into(),
        },
        secret_hex: random_hex(32)?,
    };
    // Native-only keyring seam; rotate first invalidates every old encrypted frame.
    crate::storage::set_lan_pair_record(
        &pair_key(child)?,
        &serde_json::to_string(&pair).map_err(|_| "LAN_PAIR_INVALID")?,
    )?;
    clear_journal(app, child)?;
    let mut result = serde_json::to_value(&pair).map_err(|_| "LAN_PAIR_INVALID")?;
    result["version"] = json!(1);
    result["port"] = json!(PORT);
    Ok(result)
}
fn clear_journal(app: &tauri::AppHandle, child: &str) -> Result<(), String> {
    let db = app.state::<crate::db::DbState>();
    let conn = db.conn.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
    schema(&conn)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    tx.execute(
        "DELETE FROM cafe_lan_receipts_v1 WHERE child_id=?1",
        [child],
    )
    .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    tx.execute("DELETE FROM cafe_lan_nonces_v1 WHERE child_id=?1", [child])
        .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    tx.execute("DELETE FROM cafe_lan_usage_v1 WHERE child_id=?1", [child])
        .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
    tx.commit().map_err(|_| "LAN_JOURNAL_UNAVAILABLE".into())
}
pub async fn revoke(app: &tauri::AppHandle, child: &str) -> Result<Value, String> {
    let state = app.state::<LanTransportState>();
    let _transition = state.transitions.lock().await;
    require_running_scope(&state)?;
    crate::storage::delete_lan_pair_credential(&pair_key(child)?)?;
    clear_journal(app, child)?;
    Ok(json!({"success":true}))
}
fn check_pair_current(frame: &Frame, secret: &[u8]) -> Result<(), String> {
    let pair = read_pair(&frame.scope.source_terminal_id)?;
    if pair.scope != frame.scope || unhex(&pair.secret_hex, 32)?.as_slice() != secret {
        return Err("LAN_PAIR_ROTATED_OR_REVOKED".into());
    }
    Ok(())
}
fn require_same_revision(original: &Value, current: &Value) -> Result<(), String> {
    let expected = original
        .get("snapshot_revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or("LAN_CANONICAL_REVISION_REQUIRED")?;
    if current.get("id") != original.get("id")
        || current.get("snapshot_revision").and_then(Value::as_i64) != Some(expected)
    {
        return Err("LAN_CANONICAL_SNAPSHOT_CHANGED".into());
    }
    Ok(())
}

fn collect_hydration_ids(
    value: &Value,
    orders: &mut BTreeSet<String>,
    sessions: &mut BTreeSet<String>,
) {
    match value {
        Value::Object(map) => {
            for key in ["order_id", "active_order_id"] {
                if let Some(id) = map.get(key).and_then(Value::as_str) {
                    if uuid::Uuid::parse_str(id).is_ok() {
                        orders.insert(id.into());
                    }
                }
            }
            if let Some(id) = map.get("table_session_id").and_then(Value::as_str) {
                sessions.insert(id.into());
            }
            if let Some(rows) = map.get("affected_session_ids").and_then(Value::as_array) {
                for id in rows.iter().filter_map(Value::as_str) {
                    sessions.insert(id.into());
                }
            }
            for key in ["order", "canonicalOrder"] {
                if let Some(order) = map.get(key) {
                    if let Some(id) = order.get("id").and_then(Value::as_str) {
                        orders.insert(id.into());
                    }
                    collect_hydration_ids(order, orders, sessions);
                }
            }
            for key in ["session", "source_session", "target_session"] {
                if let Some(row) = map.get(key) {
                    if let Some(id) = row.get("id").and_then(Value::as_str) {
                        sessions.insert(id.into());
                    }
                    collect_hydration_ids(row, orders, sessions);
                }
            }
            for key in [
                "sessions",
                "orders",
                "payment",
                "payments",
                "items",
                "allocations",
                "data",
            ] {
                if let Some(rows) = map.get(key) {
                    if key == "orders" {
                        if let Some(rows) = rows.as_array() {
                            for row in rows {
                                if let Some(id) = row.get("id").and_then(Value::as_str) {
                                    if uuid::Uuid::parse_str(id).is_ok() {
                                        orders.insert(id.into());
                                    }
                                }
                            }
                        }
                    }
                    if key == "sessions" {
                        if let Some(rows) = rows.as_array() {
                            for row in rows {
                                if let Some(id) = row.get("id").and_then(Value::as_str) {
                                    sessions.insert(id.into());
                                }
                            }
                        }
                    }
                    collect_hydration_ids(rows, orders, sessions);
                }
            }
        }
        Value::Array(rows) => {
            for row in rows {
                collect_hydration_ids(row, orders, sessions)
            }
        }
        _ => (),
    }
}

async fn hydrate(
    client: &reqwest::Client,
    origin: &str,
    terminal: &str,
    request: &Request,
    response: &mut Value,
) -> Result<(), String> {
    let mut order_ids = BTreeSet::new();
    let mut session_ids = BTreeSet::new();
    collect_hydration_ids(response, &mut order_ids, &mut session_ids);
    if let Some(body) = request.body.as_deref() {
        if let Ok(value) = serde_json::from_str::<Value>(body) {
            collect_hydration_ids(&value, &mut order_ids, &mut session_ids);
            if request.path.starts_with("pos/orders") {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if uuid::Uuid::parse_str(id).is_ok() {
                        order_ids.insert(id.into());
                    }
                }
            }
        }
    }
    let parts: Vec<_> = request
        .path
        .split('?')
        .next()
        .unwrap_or("")
        .split('/')
        .collect();
    if parts.get(1) == Some(&"table-sessions") {
        if let Some(id) = parts.get(2) {
            session_ids.insert((*id).into());
        }
    }
    if session_ids.len() > 50 || order_ids.len() > 50 {
        return Err("LAN_TOO_MANY_CANONICAL_SNAPSHOTS".into());
    }
    let mut sessions = Vec::new();
    let mut orders = Vec::new();
    let mut payments = Vec::new();
    let mut seen_sessions = BTreeSet::new();
    let mut seen_orders = BTreeSet::new();
    while !session_ids.is_empty() || !order_ids.is_empty() {
        if seen_sessions.len() + session_ids.len() > 50 || seen_orders.len() + order_ids.len() > 50
        {
            return Err("LAN_TOO_MANY_CANONICAL_SNAPSHOTS".into());
        }
        for id in std::mem::take(&mut session_ids) {
            if !seen_sessions.insert(id.clone()) {
                continue;
            }
            uuid::Uuid::parse_str(&id).map_err(|_| "LAN_CANONICAL_SESSION_INVALID")?;
            let (status, body) = http(
                client,
                origin,
                &format!("pos/table-sessions/{id}"),
                "GET",
                &request.api_key,
                terminal,
                None,
                None,
                request.staff_session_id.as_deref(),
                request.payment_capabilities.as_deref(),
            )
            .await?;
            if status != 200 {
                return Err("LAN_CANONICAL_REFRESH_REQUIRED".into());
            }
            let session = body
                .get("session")
                .ok_or("LAN_CANONICAL_REFRESH_REQUIRED")?;
            if session.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                return Err("LAN_CANONICAL_REFRESH_REQUIRED".into());
            }
            collect_hydration_ids(
                &json!({"session":session}),
                &mut order_ids,
                &mut session_ids,
            );
            sessions.push(session.clone());
        }
        if order_ids.len() > 50 {
            return Err("LAN_TOO_MANY_CANONICAL_SNAPSHOTS".into());
        }
        for id in std::mem::take(&mut order_ids) {
            if !seen_orders.insert(id.clone()) {
                continue;
            }
            uuid::Uuid::parse_str(&id).map_err(|_| "LAN_CANONICAL_ORDER_INVALID")?;
            let (status, body) = http(
                client,
                origin,
                &format!("pos/orders/sync?order_id={id}&limit=1"),
                "GET",
                &request.api_key,
                terminal,
                None,
                None,
                request.staff_session_id.as_deref(),
                request.payment_capabilities.as_deref(),
            )
            .await?;
            if status != 200 {
                return Err("LAN_CANONICAL_REFRESH_REQUIRED".into());
            }
            let rows = body
                .get("orders")
                .and_then(Value::as_array)
                .ok_or("LAN_CANONICAL_REFRESH_REQUIRED")?;
            let order = rows
                .iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or("LAN_CANONICAL_REFRESH_REQUIRED")?;
            // A new dine-in create may return only a parent order. Its canonical
            // binding discovers the check even when no workflow envelope exists.
            collect_hydration_ids(order, &mut order_ids, &mut session_ids);
            orders.push(order.clone());
            let (status, ledger) = http(
                client,
                origin,
                &format!("pos/payments?order_id={id}&limit=500"),
                "GET",
                &request.api_key,
                terminal,
                None,
                None,
                request.staff_session_id.as_deref(),
                request.payment_capabilities.as_deref(),
            )
            .await?;
            if status != 200 || ledger.get("has_more").and_then(Value::as_bool) != Some(false) {
                return Err("LAN_CANONICAL_LEDGER_REFRESH_REQUIRED".into());
            }
            let rows = ledger
                .get("payments")
                .and_then(Value::as_array)
                .ok_or("LAN_CANONICAL_LEDGER_REFRESH_REQUIRED")?;
            if rows
                .iter()
                .any(|row| row.get("order_id").and_then(Value::as_str) != Some(id.as_str()))
            {
                return Err("LAN_CANONICAL_LEDGER_SCOPE_MISMATCH".into());
            }
            for row in rows {
                let mut payment = row.clone();
                // GET's fixed canonical select omits organization_id; its authenticated
                // branch and the exact full parent supply that immutable scope proof.
                if payment.get("organization_id").is_none() {
                    payment["organization_id"] = order["organization_id"].clone();
                }
                payments.push(payment);
            }
        }
        order_ids.retain(|id| !seen_orders.contains(id));
        session_ids.retain(|id| !seen_sessions.contains(id));
    }
    let mut tables = Vec::new();
    if request.path.starts_with("pos/tables")
        || request.path.starts_with("pos/table-sessions")
        || !sessions.is_empty()
    {
        let (status, body) = http(
            client,
            origin,
            "pos/tables",
            "GET",
            &request.api_key,
            terminal,
            None,
            None,
            request.staff_session_id.as_deref(),
            request.payment_capabilities.as_deref(),
        )
        .await?;
        if status != 200 {
            return Err("LAN_CANONICAL_REFRESH_REQUIRED".into());
        }
        tables = body
            .get("tables")
            .and_then(Value::as_array)
            .ok_or("LAN_CANONICAL_REFRESH_REQUIRED")?
            .clone();
    }
    // Payments may advance a check revision without changing order.version.
    // Recheck all scopes after collecting ledger and table projections, before
    // any hydrated response is cached or applied as a successful receipt.
    for session in &sessions {
        let id = session
            .get("id")
            .and_then(Value::as_str)
            .ok_or("LAN_CANONICAL_SESSION_INVALID")?;
        let (status, body) = http(
            client,
            origin,
            &format!("pos/table-sessions/{id}"),
            "GET",
            &request.api_key,
            terminal,
            None,
            None,
            request.staff_session_id.as_deref(),
            request.payment_capabilities.as_deref(),
        )
        .await?;
        if status != 200 {
            return Err("LAN_CANONICAL_REFRESH_REQUIRED".into());
        }
        require_same_revision(
            session,
            body.get("session")
                .ok_or("LAN_CANONICAL_REFRESH_REQUIRED")?,
        )?;
    }
    for order in &orders {
        let id = order
            .get("id")
            .and_then(Value::as_str)
            .ok_or("LAN_CANONICAL_ORDER_INVALID")?;
        let (status, body) = http(
            client,
            origin,
            &format!("pos/orders/sync?order_id={id}&limit=1"),
            "GET",
            &request.api_key,
            terminal,
            None,
            None,
            request.staff_session_id.as_deref(),
            request.payment_capabilities.as_deref(),
        )
        .await?;
        let current = body
            .get("orders")
            .and_then(Value::as_array)
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
            });
        if status != 200
            || current.map_or(true, |current| {
                current.get("version") != order.get("version")
                    || current.get("updated_at") != order.get("updated_at")
            })
        {
            return Err("LAN_CANONICAL_SNAPSHOT_CHANGED".into());
        }
    }

    for key in ["session", "source_session", "target_session"] {
        if let Some(id) = response
            .get(key)
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
        {
            if let Some(fresh) = sessions
                .iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                response[key] = fresh.clone();
            }
        }
    }
    if response.get("sessions").is_some() {
        response["sessions"] = json!(sessions);
    }
    for (key, rows) in [("order", &orders), ("table", &tables)] {
        if let Some(id) = response
            .get(key)
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
        {
            if let Some(fresh) = rows
                .iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                response[key] = fresh.clone();
            }
        }
    }
    if response.get("orders").is_some() {
        response["orders"] = json!(orders);
    }
    if response.get("tables").is_some() {
        response["tables"] = json!(tables);
    }
    if let Some(order_id) = response
        .get("order_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
    {
        if let Some(order) = orders
            .iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(order_id.as_str()))
        {
            for key in ["payment_status", "payment_method"] {
                if response.get(key).is_some() {
                    response[key] = order[key].clone();
                }
            }
        }
    }
    response["cafe_lan_snapshot"] =
        json!({"orders":orders,"sessions":sessions,"tables":tables,"payments":payments});
    Ok(())
}

fn validation_path(request: &Request) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query
        .append_pair("request_path", &request.path)
        .append_pair("request_method", &request.method);
    if request.path == "pos/payments" {
        if let Some(method) = request
            .body
            .as_deref()
            .and_then(|body| serde_json::from_str::<Value>(body).ok())
            .and_then(|value| {
                value
                    .get("payment_method")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
        {
            query.append_pair("payment_method", &method);
        }
    }
    format!("pos/lan/validate?{}", query.finish())
}

fn decode_cached_receipt(
    frame: &Frame,
    hash: &str,
    secret: &[u8],
    encrypted: &str,
) -> Result<Value, String> {
    let mut cached: Value =
        serde_json::from_slice(&decrypt(secret, &receipt_aad(frame, hash), encrypted)?)
            .map_err(|_| "LAN_CACHED_RESPONSE_INVALID")?;
    // The business outcome is retained, but the shared table/check snapshot is
    // refreshed for every replay, including a receipt already applied locally.
    if cached["wire"]["success"].as_bool() == Some(true) {
        cached["ready"] = json!(false);
    }
    Ok(cached)
}

/// What the relay core needs from outside: the keyring pair fence, the
/// canonical HTTPS API and the domain owners. Production uses [`HttpsRelay`];
/// tests script every call to prove ordering and journaling rules.
trait RelayPorts: Sync {
    fn pair_current(&self, frame: &Frame, secret: &[u8]) -> Result<(), String>;
    fn validate(
        &self,
        frame: &Frame,
        request: &Request,
    ) -> impl std::future::Future<Output = Result<(u16, Value), String>> + Send;
    fn send(
        &self,
        frame: &Frame,
        request: &Request,
    ) -> impl std::future::Future<Output = Result<(u16, Value), String>> + Send;
    fn hydrate(
        &self,
        frame: &Frame,
        request: &Request,
        data: &mut Value,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn apply(&self, conn: &Connection, path: &str, canonical: &Value) -> Result<(), String>;
    fn applied(&self, frame: &Frame);
}

struct HttpsRelay<'a> {
    app: &'a tauri::AppHandle,
    client: reqwest::Client,
    origin: String,
}

impl RelayPorts for HttpsRelay<'_> {
    fn pair_current(&self, frame: &Frame, secret: &[u8]) -> Result<(), String> {
        check_pair_current(frame, secret)
    }
    async fn validate(&self, frame: &Frame, request: &Request) -> Result<(u16, Value), String> {
        let scope = serde_json::to_string(&frame.scope).map_err(|_| "LAN_INVALID_SCOPE")?;
        http(
            &self.client,
            &self.origin,
            &validation_path(request),
            "POST",
            &request.api_key,
            &frame.scope.source_terminal_id,
            Some(&scope),
            None,
            request.staff_session_id.as_deref(),
            request.payment_capabilities.as_deref(),
        )
        .await
    }
    async fn send(&self, frame: &Frame, request: &Request) -> Result<(u16, Value), String> {
        http(
            &self.client,
            &self.origin,
            &request.path,
            &request.method,
            &request.api_key,
            &frame.scope.source_terminal_id,
            request.body.as_deref(),
            request.idempotency_key.as_deref(),
            request.staff_session_id.as_deref(),
            request.payment_capabilities.as_deref(),
        )
        .await
    }
    async fn hydrate(
        &self,
        frame: &Frame,
        request: &Request,
        data: &mut Value,
    ) -> Result<(), String> {
        hydrate(
            &self.client,
            &self.origin,
            &frame.scope.source_terminal_id,
            request,
            data,
        )
        .await
    }
    fn apply(&self, conn: &Connection, path: &str, canonical: &Value) -> Result<(), String> {
        crate::sync::apply_lan_canonical_response(conn, path, canonical)
    }
    fn applied(&self, frame: &Frame) {
        let _ = self.app.emit(
            "order_realtime_update",
            json!({"source":"lan","request_id":frame.request_id}),
        );
    }
}

async fn dispatch(
    app: &tauri::AppHandle,
    frame: &Frame,
    secret: &[u8],
    request: &Request,
) -> Result<Value, String> {
    let db = app.state::<crate::db::DbState>();
    let (origin, _main_key) = crate::resolve_admin_endpoint(Some(&db))
        .await
        .map_err(|_| "LAN_MAIN_BINDING_UNAVAILABLE")?;
    let current = crate::storage::get_credential_strict("terminal_id")?
        .ok_or("LAN_MAIN_BINDING_UNAVAILABLE")?;
    if current.as_str() != frame.scope.parent_terminal_id {
        return Err("LAN_MAIN_SCOPE_CHANGED".into());
    }
    let ports = HttpsRelay {
        app,
        client: client()?,
        origin,
    };
    relay(
        &ports,
        &db.conn,
        frame,
        secret,
        request,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}

async fn relay<P: RelayPorts>(
    ports: &P,
    db: &Mutex<Connection>,
    frame: &Frame,
    secret: &[u8],
    request: &Request,
    now_ms: i64,
) -> Result<Value, String> {
    allowed(request)?;
    // A stale or replayed delivery is refused here, before any cloud call.
    {
        let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
        admit_frame(&conn, frame, request, now_ms)?;
    }
    ports.pair_current(frame, secret)?;
    let (auth_status, auth) = ports.validate(frame, request).await?;
    if auth_status != 200 || auth.get("success").and_then(Value::as_bool) != Some(true) {
        // A refusal of the relay itself (pairing, module or action policy, rate
        // limit) is not the canonical answer to the waiter's operation. As on an
        // Android main, the waiter retries it on its own HTTPS path.
        return Err("LAN_CHILD_AUTHORITY_DENIED".into());
    }
    for (key, expected) in [
        ("organization_id", &frame.scope.organization_id),
        ("branch_id", &frame.scope.branch_id),
        ("parent_terminal_id", &frame.scope.parent_terminal_id),
        ("source_terminal_id", &frame.scope.source_terminal_id),
    ] {
        if auth.get(key).and_then(Value::as_str) != Some(expected.as_str()) {
            return Err("LAN_AUTHORITY_SCOPE_MISMATCH".into());
        }
    }
    if request.method == "GET" {
        return relay_read(ports, db, frame, secret, request).await;
    }
    let hash = request_hash(request);
    let receipt = {
        let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
        begin_receipt(&conn, frame, &hash, &request.path)?
    };
    let sent = match receipt {
        Receipt::Busy => return Err("LAN_REQUEST_IN_PROGRESS".into()),
        Receipt::Cached(encrypted) => {
            let cached = decode_cached_receipt(frame, &hash, secret, &encrypted)?;
            if wire_is_final(&cached["wire"]) {
                Sent::Durable(cached)
            } else {
                let reclaimed = {
                    let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
                    reclaim_receipt(&conn, frame, &hash, &encrypted)?
                };
                if !reclaimed {
                    return Err("LAN_REQUEST_IN_PROGRESS".into());
                }
                send_mutation(ports, db, frame, secret, request, &hash).await?
            }
        }
        Receipt::Dispatch => send_mutation(ports, db, frame, secret, request, &hash).await?,
    };
    let mut durable = match sent {
        Sent::Durable(durable) => durable,
        Sent::Refused(wire) => return Ok(wire),
    };
    if durable["wire"]["success"].as_bool() == Some(true) {
        if durable["ready"].as_bool() != Some(true) {
            ports
                .hydrate(frame, request, &mut durable["wire"]["data"])
                .await?;
            if durable["wire"].to_string().len() > MAX_PLAIN {
                return Err("LAN_RESPONSE_TOO_LARGE".into());
            }
            durable["ready"] = json!(true);
            let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
            ports.pair_current(frame, secret)?;
            persist_response(&conn, frame, &hash, secret, &durable)?;
        }
        {
            let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
            ports.pair_current(frame, secret)?;
            let canonical = lan_canonical(&durable["wire"]["data"]);
            let tx = conn
                .unchecked_transaction()
                .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
            let path = format!("/api/{}", request.path.split('?').next().unwrap_or(""));
            if let Err(error) = ports.apply(&tx, &path, &canonical) {
                tx.rollback().map_err(|_| "LAN_DOMAIN_ROLLBACK_FAILED")?;
                durable["ready"] = json!(false);
                persist_response(&conn, frame, &hash, secret, &durable)?;
                return Err(error);
            }
            let updated=tx.execute("UPDATE cafe_lan_receipts_v1 SET state='applied' WHERE child_id=?1 AND request_id=?2 AND request_hash=?3",
                params![frame.scope.source_terminal_id,frame.request_id,hash]).map_err(|_|"LAN_JOURNAL_UNAVAILABLE")?;
            if updated != 1 {
                return Err("LAN_JOURNAL_IDENTITY_CHANGED".into());
            }
            tx.commit().map_err(|_| "LAN_JOURNAL_COMMIT_FAILED")?;
        }
        ports.applied(frame);
    }
    Ok(durable["wire"].clone())
}

enum Sent {
    /// A final reply, retained before any follow-up read.
    Durable(Value),
    /// A retry-class refusal: relayed to the waiter once, never retained.
    Refused(Value),
}

async fn send_mutation<P: RelayPorts>(
    ports: &P,
    db: &Mutex<Connection>,
    frame: &Frame,
    secret: &[u8],
    request: &Request,
    hash: &str,
) -> Result<Sent, String> {
    let (status, canonical) = match ports.send(frame, request).await {
        Ok(value) => value,
        Err(error) => {
            if let Ok(conn) = db.lock() {
                pending(&conn, frame);
            }
            return Err(error);
        }
    };
    if reply_class(status, &canonical) == ReplyClass::Uncertain {
        if let Ok(conn) = db.lock() {
            pending(&conn, frame);
        }
        return Err("LAN_CLOUD_UNCERTAIN".into());
    }
    let successful = (200..300).contains(&status)
        && canonical.get("success").and_then(Value::as_bool) != Some(false);
    // Persist the canonical reply before follow-up refresh: a failed refresh
    // can be repaired by retrying the original canonical operation key.
    let initial =
        json!({"wire":{"success":successful,"status":status,"data":canonical},"ready":!successful});
    let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
    ports.pair_current(frame, secret)?;
    Ok(if persist_response(&conn, frame, hash, secret, &initial)? {
        Sent::Durable(initial)
    } else {
        Sent::Refused(initial["wire"].clone())
    })
}

/// Reads keep no receipt: a repeated order poll or table read simply asks the
/// cloud again. A successful read still refreshes the main's own snapshot.
async fn relay_read<P: RelayPorts>(
    ports: &P,
    db: &Mutex<Connection>,
    frame: &Frame,
    secret: &[u8],
    request: &Request,
) -> Result<Value, String> {
    let (status, canonical) = ports.send(frame, request).await?;
    if reply_class(status, &canonical) == ReplyClass::Uncertain {
        return Err("LAN_CLOUD_UNCERTAIN".into());
    }
    let successful = (200..300).contains(&status)
        && canonical.get("success").and_then(Value::as_bool) != Some(false);
    let mut wire = json!({"success":successful,"status":status,"data":canonical});
    if successful {
        ports.hydrate(frame, request, &mut wire["data"]).await?;
        if wire.to_string().len() > MAX_PLAIN {
            return Err("LAN_RESPONSE_TOO_LARGE".into());
        }
        {
            let conn = db.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
            ports.pair_current(frame, secret)?;
            let tx = conn
                .unchecked_transaction()
                .map_err(|_| "LAN_JOURNAL_UNAVAILABLE")?;
            let path = format!("/api/{}", request.path.split('?').next().unwrap_or(""));
            if let Err(error) = ports.apply(&tx, &path, &lan_canonical(&wire["data"])) {
                tx.rollback().map_err(|_| "LAN_DOMAIN_ROLLBACK_FAILED")?;
                return Err(error);
            }
            tx.commit().map_err(|_| "LAN_JOURNAL_COMMIT_FAILED")?;
        }
        ports.applied(frame);
    }
    Ok(wire)
}

/// The domain owners read the hydrated snapshot under these flat keys.
fn lan_canonical(data: &Value) -> Value {
    let mut canonical = data.clone();
    for key in ["orders", "sessions", "tables", "payments"] {
        canonical[format!("lan_canonical_{key}")] = data["cafe_lan_snapshot"][key].clone();
    }
    canonical
}
async fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| "LAN_FRAME_READ_FAILED")?;
        if count == 0 {
            return Err("LAN_TRUNCATED_FRAME".into());
        }
        if bytes.len() + count > MAX_FRAME + 1 {
            return Err("LAN_FRAME_TOO_LARGE".into());
        }
        if let Some(end) = chunk[..count].iter().position(|b| *b == b'\n') {
            if end + 1 != count {
                return Err("LAN_MULTIPLE_FRAMES_DENIED".into());
            }
            bytes.extend_from_slice(&chunk[..end]);
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}
async fn connection(app: tauri::AppHandle, mut stream: TcpStream) -> Result<(), String> {
    let bytes = tokio::time::timeout(Duration::from_secs(8), read_frame(&mut stream))
        .await
        .map_err(|_| "LAN_FRAME_TIMEOUT")??;
    let frame: Frame = serde_json::from_slice(&bytes).map_err(|_| "LAN_INVALID_FRAME")?;
    let pair = read_pair(&frame.scope.source_terminal_id)?;
    if pair.scope != frame.scope {
        return Err("LAN_PAIR_SCOPE_MISMATCH".into());
    }
    let secret = Zeroizing::new(unhex(&pair.secret_hex, 32)?);
    verify(&frame, &secret)?;
    let plain = decrypt(&secret, &aad(&frame, "request"), &frame.ciphertext)?;
    let request: Request = serde_json::from_slice(&plain).map_err(|_| "LAN_INVALID_REQUEST")?;
    let reply = match tokio::time::timeout(
        Duration::from_secs(90),
        dispatch(&app, &frame, &secret, &request),
    )
    .await
    {
        Ok(Ok(reply)) => reply,
        Ok(Err(error)) => json!({"success":false,"status":503,"error":error}),
        Err(_) => json!({"success":false,"status":503,"error":"LAN_CLOUD_UNCERTAIN"}),
    };
    let encrypted = response_frame(&frame, &secret, &reply)?;
    let mut bytes = serde_json::to_vec(&encrypted).map_err(|_| "LAN_INVALID_RESPONSE")?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(8), stream.write_all(&bytes))
        .await
        .map_err(|_| "LAN_WRITE_TIMEOUT")?
        .map_err(|_| "LAN_WRITE_FAILED")?;
    let _ = stream.shutdown().await;
    Ok(())
}
pub fn status(state: &LanTransportState) -> Result<Value, String> {
    let active = state.running.lock().map_err(|_| "LAN_STATE_UNAVAILABLE")?;
    Ok(
        json!({"running":active.as_ref().is_some_and(|running|!running.cancel.is_cancelled()),"port":PORT,"protocol_version":1}),
    )
}
pub async fn stop_and_drain(state: &LanTransportState) -> Result<Value, String> {
    let running = state
        .running
        .lock()
        .map_err(|_| "LAN_STATE_UNAVAILABLE")?
        .take();
    if let Some(running) = running {
        running.cancel.cancel();
        running.task.await.map_err(|_| "LAN_SHUTDOWN_FAILED")?;
    }
    status(state)
}
fn set_enabled_choice(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let db = app.state::<crate::db::DbState>();
    let conn = db.conn.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
    crate::db::set_setting(
        &conn,
        "terminal",
        ENABLED_SETTING,
        if enabled { "true" } else { "false" },
    )
}
fn enabled_choice(app: &tauri::AppHandle) -> Result<bool, String> {
    let db = app.state::<crate::db::DbState>();
    let conn = db.conn.lock().map_err(|_| "LAN_DB_LOCK_FAILED")?;
    Ok(crate::db::get_setting(&conn, "terminal", ENABLED_SETTING).as_deref() == Some("true"))
}
/// Startup is authorization-preserving: restore only an operator's enabled
/// choice and recheck current main authority before listening. An offline boot
/// leaves the saved choice available for the next startup/connection retry.
pub async fn restore_startup(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<LanTransportState>();
    if enabled_choice(&app)? {
        start(app.clone(), &state).await?;
    }
    status(&state)
}
fn require_running_scope(state: &LanTransportState) -> Result<(), String> {
    if state.reset_fenced.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("LAN_RECEIVER_RESET_FENCED".into());
    }
    Ok(())
}
/// Serialize reset with pairing/start/stop configuration writes; after draining,
/// this process cannot recreate a listener or secret while its data is wiped.
pub async fn prepare_reset(app: &tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<LanTransportState>();
    let _transition = state.transitions.lock().await;
    state
        .reset_fenced
        .store(true, std::sync::atomic::Ordering::SeqCst);
    stop_and_drain(&state).await
}
pub async fn enable(app: tauri::AppHandle, state: &LanTransportState) -> Result<Value, String> {
    let _transition = state.transitions.lock().await;
    require_running_scope(state)?;
    let result = start_inner(app.clone(), state).await?;
    if let Err(error) = set_enabled_choice(&app, true) {
        stop_and_drain(state).await?;
        return Err(error);
    }
    Ok(result)
}
pub async fn disable(app: &tauri::AppHandle, state: &LanTransportState) -> Result<Value, String> {
    let _transition = state.transitions.lock().await;
    require_running_scope(state)?;
    let saved = set_enabled_choice(app, false);
    let result = stop_and_drain(state).await?;
    saved?;
    Ok(result)
}
pub async fn start(app: tauri::AppHandle, state: &LanTransportState) -> Result<Value, String> {
    let _transition = state.transitions.lock().await;
    require_running_scope(state)?;
    start_inner(app, state).await
}
async fn start_inner(app: tauri::AppHandle, state: &LanTransportState) -> Result<Value, String> {
    if status(state)?["running"].as_bool() == Some(true) {
        return status(state);
    }
    stop_and_drain(state).await?;
    main_authority(&app).await?;
    if status(state)?["running"].as_bool() == Some(true) {
        return status(state);
    }
    let listener = TcpListener::bind(("0.0.0.0", PORT))
        .await
        .map_err(|_| "LAN_PORT_UNAVAILABLE")?;
    let token = CancellationToken::new();
    let worker_token = token.clone();
    let task = tokio::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(16));
        let mut workers = tokio::task::JoinSet::new();
        let mut window = Instant::now();
        let mut count = 0usize;
        let mut peers: HashMap<std::net::IpAddr, usize> = HashMap::new();
        loop {
            tokio::select! {
                _=worker_token.cancelled()=>break,
                _=workers.join_next(),if !workers.is_empty()=>(),
                accepted=listener.accept()=>match accepted {Ok((stream,address))=>{
                    if window.elapsed()>=Duration::from_secs(60){window=Instant::now();count=0;peers.clear();}
                    if count>=512||peers.len()>=64&&!peers.contains_key(&address.ip())||peers.get(&address.ip()).copied().unwrap_or(0)>=128{drop(stream);continue;}
                    count+=1;*peers.entry(address.ip()).or_default()+=1;
                    let permit=match semaphore.clone().try_acquire_owned(){Ok(permit)=>permit,Err(_)=>{drop(stream);continue;}};
                    let app=app.clone();let connection_token=worker_token.clone();
                    workers.spawn(async move {let _permit=permit;tokio::select!{_=connection_token.cancelled()=>(),_=connection(app,stream)=>()}});
                },Err(_)=>break}
            }
        }
        worker_token.cancel();
        drop(listener);
        // Cancellation drops unfinished HTTPS/framing futures. Joining every
        // task also waits for an already-running SQLite transaction to finish.
        while workers.join_next().await.is_some() {}
    });
    *state.running.lock().map_err(|_| "LAN_STATE_UNAVAILABLE")? = Some(Running {
        cancel: token,
        task,
    });
    status(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> Frame {
        Frame {
            version: 1,
            scope: Scope {
                organization_id: "00000000-0000-4000-8000-000000000001".into(),
                branch_id: "00000000-0000-4000-8000-000000000002".into(),
                parent_terminal_id: "00000000-0000-4000-8000-000000000003".into(),
                source_terminal_id: "00000000-0000-4000-8000-000000000004".into(),
            },
            request_id: "00000000-0000-4000-8000-000000000005".into(),
            nonce: "0123456789abcdef0123456789abcdef".into(),
            ciphertext: String::new(),
            mac: String::new(),
        }
    }
    fn request(path: &str, method: &str, body: Option<Value>) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            body: body.map(|v| v.to_string()),
            idempotency_key: None,
            api_key: "child-only-key".into(),
            staff_session_id: None,
            payment_capabilities: None,
            sent_at: None,
        }
    }
    #[test]
    fn authenticated_roundtrip_and_tamper_rejection() {
        let secret = [7; 32];
        let mut f = frame();
        f.ciphertext = encrypt(&secret, &aad(&f, "request"), br#"{"method":"GET"}"#).unwrap();
        f.mac = hex(hmac::sign(
            &mac_key(&secret),
            format!("{}\n{}", aad(&f, "request"), f.ciphertext).as_bytes(),
        )
        .as_ref());
        verify(&f, &secret).unwrap();
        assert_eq!(
            &*decrypt(&secret, &aad(&f, "request"), &f.ciphertext).unwrap(),
            br#"{"method":"GET"}"#
        );
        let reply = response_frame(&f, &secret, &json!({"success":true,"status":200})).unwrap();
        assert!(decrypt(&secret, &aad(&f, "request"), &reply.ciphertext).is_err());
        f.scope.branch_id = "00000000-0000-4000-8000-000000000099".into();
        assert!(verify(&f, &secret).is_err());
    }
    #[test]
    fn mac_derivation_matches_protocol_vector() {
        // Independently calculated with Node crypto HMAC-SHA256.
        assert_eq!(
            hex(hmac::sign(
                &hmac::Key::new(hmac::HMAC_SHA256, &[7; 32]),
                b"cafe-lan-v1:mac"
            )
            .as_ref()),
            "72a39b98b6ec17131776d3a0d5d76b205c7e7f9e6447c462e069aa73613e20b4"
        );
    }
    #[test]
    fn native_android_crypto_format_matches_independent_node_vector() {
        let mut f = frame();
        f.ciphertext="v1:000102030405060708090a0b:63a384156961b62d5588c7dba70c4e873361e140913459eec436f2a8983baa3b".into();
        f.mac = "281b4173ce659dfac83d22faa4a048d3e9fdd780134c4fe524a51e1c011cafcd".into();
        verify(&f, &[7; 32]).unwrap();
        assert_eq!(
            &*decrypt(&[7; 32], &aad(&f, "request"), &f.ciphertext).unwrap(),
            br#"{"method":"GET"}"#
        );
        f.mac.replace_range(0..2, "00");
        assert!(verify(&f, &[7; 32]).is_err());
    }
    #[test]
    fn stable_identity_excludes_credentials_preserves_exact_body() {
        let mut r = request(
            "pos/payments",
            "POST",
            Some(json!({"idempotency_key":"stable","amount":1})),
        );
        let hash = request_hash(&r);
        r.api_key = "rotated-key".into();
        r.staff_session_id = Some("00000000-0000-4000-8000-000000000099".into());
        assert_eq!(request_hash(&r), hash);
        r.body = Some("{\"idempotency_key\":\"stable\",\"amount\":2}".into());
        assert_ne!(request_hash(&r), hash);
    }
    #[test]
    fn allowlist_denies_secrets_arbitrary_paths_and_unkeyed_mutations() {
        for path in [
            "https://evil/pos/orders",
            "pos/../orders",
            "pos/table-cancel-approvals",
            "pos/payments/refund",
            "pos/orders%2fsync",
        ] {
            assert!(allowed(&request(path, "POST", Some(json!({"client_event_id":"x"})))).is_err());
        }
        assert!(allowed(&request("pos/payments", "POST", Some(json!({"amount":10})))).is_err());
        assert!(allowed(&request(
            "pos/payments",
            "POST",
            Some(json!({"idempotency_key":"x","manager_pin":"1234"}))
        ))
        .is_err());
        allowed(&request(
            "pos/payments",
            "POST",
            Some(json!({"idempotency_key":"x","amount":10})),
        ))
        .unwrap();
        allowed(&request(
            "pos/orders/sync?order_id=00000000-0000-4000-8000-000000000005&limit=1",
            "GET",
            None,
        ))
        .unwrap();
        allowed(&request(
            "pos/table-sessions/00000000-0000-4000-8000-000000000005/items/transfer",
            "POST",
            Some(json!({"client_event_id":"stable-transfer"})),
        ))
        .unwrap();
        assert!(allowed(&request(
            "pos/table-sessions/00000000-0000-4000-8000-000000000005/transfer",
            "POST",
            Some(json!({"client_event_id":"stable-transfer"}))
        ))
        .is_err());
        assert!(endpoint("http://localhost:3000", "pos/orders").is_err());
        assert!(endpoint("https://user:pw@example.com", "pos/orders").is_err());
    }
    #[test]
    fn replay_authorization_includes_actual_action_and_payment_method() {
        let request = request(
            "pos/payments",
            "POST",
            Some(json!({"payment_method":"cash","idempotency_key":"stable"})),
        );
        let path = validation_path(&request);
        let url = url::Url::parse(&format!("https://canonical.example/api/{path}")).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["request_path"], "pos/payments");
        assert_eq!(params["request_method"], "POST");
        assert_eq!(params["payment_method"], "cash");
        assert!(!path.contains("child-only-key"));
    }
    #[test]
    fn durable_receipt_replay_conflict_and_uncertain_retry() {
        let conn = Connection::open_in_memory().unwrap();
        let mut f = frame();
        let payment = request(
            "pos/payments",
            "POST",
            Some(json!({"idempotency_key":"stable","amount":1})),
        );
        admit_frame(&conn, &f, &payment, now_ms()).unwrap();
        assert_eq!(
            admit_frame(&conn, &f, &payment, now_ms()).unwrap_err(),
            "LAN_NONCE_REPLAY"
        );
        assert!(matches!(
            begin_receipt(&conn, &f, "hash", "pos/payments").unwrap(),
            Receipt::Dispatch
        ));
        f.nonce = random_hex(16).unwrap();
        assert!(matches!(
            begin_receipt(&conn, &f, "hash", "pos/payments").unwrap(),
            Receipt::Busy
        ));
        pending(&conn, &f);
        f.nonce = random_hex(16).unwrap();
        assert!(matches!(
            begin_receipt(&conn, &f, "hash", "pos/payments").unwrap(),
            Receipt::Dispatch
        ));
        let response = json!({"wire":{"success":true,"status":200,"data":{"payment_id":"canonical"}},"ready":false});
        persist_response(&conn, &f, "hash", &[7; 32], &response).unwrap();
        f.nonce = random_hex(16).unwrap();
        let Receipt::Cached(encrypted) = begin_receipt(&conn, &f, "hash", "pos/payments").unwrap()
        else {
            panic!("missing cached reply")
        };
        assert!(!encrypted.contains("canonical"));
        assert_eq!(
            serde_json::from_slice::<Value>(
                &decrypt(&[7; 32], &receipt_aad(&f, "hash"), &encrypted).unwrap()
            )
            .unwrap(),
            response
        );
        f.nonce = random_hex(16).unwrap();
        assert_eq!(
            begin_receipt(&conn, &f, "changed", "pos/payments")
                .err()
                .unwrap(),
            "LAN_REQUEST_ID_CONFLICT"
        );
        assert!(decrypt(&[8; 32], &receipt_aad(&f, "hash"), &encrypted).is_err());
    }
    #[test]
    fn cached_success_requires_fresh_snapshot_without_redispatching_money() {
        let conn = Connection::open_in_memory().unwrap();
        let mut f = frame();
        begin_receipt(&conn, &f, "hash", "pos/payments").unwrap();
        let receipt = json!({"wire":{"success":true,"status":200,"data":{"payment_id":"same-canonical-receipt","cafe_lan_snapshot":{"sessions":[{"snapshot_revision":1}]}}},"ready":true});
        persist_response(&conn, &f, "hash", &[7; 32], &receipt).unwrap();
        f.nonce = random_hex(16).unwrap();
        let Receipt::Cached(encrypted) = begin_receipt(&conn, &f, "hash", "pos/payments").unwrap()
        else {
            panic!("financial request was redispatched")
        };
        let replay = decode_cached_receipt(&f, "hash", &[7; 32], &encrypted).unwrap();
        assert_eq!(replay["ready"], false);
        assert_eq!(
            replay["wire"]["data"]["payment_id"],
            "same-canonical-receipt"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM cafe_lan_receipts_v1", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1
        );
    }
    #[test]
    fn receipt_claim_rolls_back_without_leaving_a_receipt_or_usage() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        conn.execute_batch("CREATE TRIGGER deny_receipt BEFORE INSERT ON cafe_lan_receipts_v1 BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        let f = frame();
        assert!(begin_receipt(&conn, &f, "hash", "pos/payments").is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM cafe_lan_receipts_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            receipt_usage(&conn, &f.scope.source_terminal_id).unwrap(),
            (0, 0)
        );
        conn.execute_batch("DROP TRIGGER deny_receipt;").unwrap();
        assert!(matches!(
            begin_receipt(&conn, &f, "hash", "pos/payments").unwrap(),
            Receipt::Dispatch
        ));
        assert_eq!(
            receipt_usage(&conn, &f.scope.source_terminal_id).unwrap(),
            (1, 0)
        );
    }
    #[test]
    fn reply_classes_follow_the_journal_contract() {
        let plain = json!({"success": false});
        for status in [200, 201, 204] {
            assert_eq!(reply_class(status, &plain), ReplyClass::Final);
        }
        for status in DETERMINISTIC_REFUSALS {
            assert_eq!(reply_class(status, &plain), ReplyClass::Final);
            assert_eq!(
                reply_class(status, &json!({"retry_same_identity": true})),
                ReplyClass::Retry
            );
        }
        for status in [401, 403, 404, 408, 409, 423, 425, 429] {
            assert_eq!(reply_class(status, &plain), ReplyClass::Retry);
        }
        for status in [101, 202, 302, 500, 502, 503] {
            assert_eq!(reply_class(status, &plain), ReplyClass::Uncertain);
        }
    }
    #[test]
    fn outbound_payment_body_rejects_arrays_and_carries_the_header_key() {
        assert_eq!(
            outbound_body("pos/payments", "[{\"amount\":1}]", Some("key")).unwrap_err(),
            "LAN_INVALID_REQUEST"
        );
        let keyed: Value = serde_json::from_str(
            &outbound_body("pos/payments", "{\"amount\":1}", Some("key")).unwrap(),
        )
        .unwrap();
        assert_eq!(keyed["idempotency_key"], "key");
        assert_eq!(
            outbound_body("pos/orders", "[1]", Some("key")).unwrap(),
            "[1]"
        );
    }
    #[test]
    fn two_waiters_claim_one_dispatch_and_keep_uncertain_receipt() {
        let conn = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let conn = conn.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut f = frame();
                    f.nonce = random_hex(16).unwrap();
                    barrier.wait();
                    let conn = conn.lock().unwrap();
                    match begin_receipt(&conn, &f, "samehash", "pos/payments").unwrap() {
                        Receipt::Dispatch => 1,
                        Receipt::Busy => 0,
                        Receipt::Cached(_) => panic!("unexpected completed receipt"),
                    }
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .sum::<i32>(),
            1
        );
        assert_eq!(
            conn.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM cafe_lan_receipts_v1 WHERE state='dispatching'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
    #[test]
    fn concurrent_payment_revision_fences_snapshot_even_when_parent_version_is_unchanged() {
        let original = json!({"id":"check","snapshot_revision":20,"order":{"version":5},"balance":{"paid_total":8}});
        let current = json!({"id":"check","snapshot_revision":21,"order":{"version":5},"balance":{"paid_total":16}});
        assert_eq!(
            require_same_revision(&original, &current).unwrap_err(),
            "LAN_CANONICAL_SNAPSHOT_CHANGED"
        );
        require_same_revision(&original, &original).unwrap();
        assert!(require_same_revision(&json!({"id":"check"}), &current).is_err());
    }
    #[test]
    fn reset_fence_denies_restarting_receiver_in_the_same_process() {
        let state = LanTransportState::default();
        require_running_scope(&state).unwrap();
        state
            .reset_fenced
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            require_running_scope(&state).unwrap_err(),
            "LAN_RECEIVER_RESET_FENCED"
        );
    }
    #[tokio::test]
    async fn stop_drain_waits_for_all_inflight_tasks_before_database_reset() {
        let state = LanTransportState::default();
        let cancel = CancellationToken::new();
        let worker_cancel = cancel.clone();
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finish = finished.clone();
        let task = tokio::spawn(async move {
            worker_cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(15)).await;
            finish.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        *state.running.lock().unwrap() = Some(Running { cancel, task });
        assert_eq!(status(&state).unwrap()["running"], true);
        stop_and_drain(&state).await.unwrap();
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(status(&state).unwrap()["running"], false);
        assert!(state.running.lock().unwrap().is_none());
    }
    #[test]
    fn crash_lan_new_dine_in_parent_discovers_canonical_check_without_workflow() {
        let order = "11111111-1111-4111-8111-111111111111";
        let session = "22222222-2222-4222-8222-222222222222";
        let mut orders = BTreeSet::new();
        let mut sessions = BTreeSet::new();
        collect_hydration_ids(
            &json!({"success":true,"order":{"id":order,"table_session_id":session}}),
            &mut orders,
            &mut sessions,
        );
        assert_eq!(orders, BTreeSet::from([order.to_string()]));
        assert_eq!(sessions, BTreeSet::from([session.to_string()]));
        sessions.clear();
        orders.clear();
        collect_hydration_ids(
            &json!({"id":order,"table_session_id":session,"order_items":[]}),
            &mut orders,
            &mut sessions,
        );
        assert_eq!(sessions, BTreeSet::from([session.to_string()]));
        let source = "33333333-3333-4333-8333-333333333333";
        collect_hydration_ids(
            &json!({"session":{"id":session,"active_order_id":order,"items":[{"order_id":source}]}}),
            &mut orders,
            &mut sessions,
        );
        assert!(orders.contains(source));
        let current = json!({"id":session,"snapshot_revision":2});
        let mut changed = current.clone();
        changed["snapshot_revision"] = json!(3);
        assert!(require_same_revision(&current, &changed).is_err());
    }

    #[tokio::test]
    async fn fragmented_ndjson_roundtrip_and_multiple_frame_denial() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let send = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(b"{\"v\":").await.unwrap();
            tokio::task::yield_now().await;
            stream.write_all(b"1}\n").await.unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_eq!(read_frame(&mut stream).await.unwrap(), b"{\"v\":1}");
        send.await.unwrap();
        let send = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(b"{}\n{}\n").await.unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(read_frame(&mut stream).await.is_err());
        send.await.unwrap();
    }

    // Relay core regressions from the 2026-10-06 LAN review (desktop 1.4.124).
    const TABLE: &str = "pos/tables/00000000-0000-4000-8000-000000000009";

    #[derive(Default)]
    struct ScriptedCloud {
        validate_reply: Mutex<Option<(u16, Value)>>,
        sends: Mutex<std::collections::VecDeque<(u16, Value)>>,
        calls: Mutex<Vec<&'static str>>,
    }
    impl ScriptedCloud {
        fn replying(replies: Vec<(u16, Value)>) -> Self {
            Self {
                sends: Mutex::new(replies.into()),
                ..Self::default()
            }
        }
        fn record(&self, call: &'static str) {
            self.calls.lock().unwrap().push(call);
        }
        fn count(&self, call: &str) -> usize {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|seen| **seen == call)
                .count()
        }
        fn refuse_validation(&self, status: u16, body: Value) {
            *self.validate_reply.lock().unwrap() = Some((status, body));
        }
    }
    impl RelayPorts for ScriptedCloud {
        fn pair_current(&self, _frame: &Frame, _secret: &[u8]) -> Result<(), String> {
            Ok(())
        }
        async fn validate(
            &self,
            frame: &Frame,
            _request: &Request,
        ) -> Result<(u16, Value), String> {
            self.record("validate");
            let scripted = self.validate_reply.lock().unwrap().clone();
            Ok(scripted.unwrap_or_else(|| {
                (
                    200,
                    json!({
                        "success": true,
                        "organization_id": frame.scope.organization_id,
                        "branch_id": frame.scope.branch_id,
                        "parent_terminal_id": frame.scope.parent_terminal_id,
                        "source_terminal_id": frame.scope.source_terminal_id,
                    }),
                )
            }))
        }
        async fn send(&self, _frame: &Frame, _request: &Request) -> Result<(u16, Value), String> {
            self.record("send");
            let next = self.sends.lock().unwrap().pop_front();
            Ok(next.unwrap_or_else(|| (200, json!({"success": true}))))
        }
        async fn hydrate(
            &self,
            _frame: &Frame,
            _request: &Request,
            data: &mut Value,
        ) -> Result<(), String> {
            self.record("hydrate");
            data["cafe_lan_snapshot"] =
                json!({"orders": [], "sessions": [], "tables": [], "payments": []});
            Ok(())
        }
        fn apply(&self, _conn: &Connection, _path: &str, _canonical: &Value) -> Result<(), String> {
            self.record("apply");
            Ok(())
        }
        fn applied(&self, _frame: &Frame) {}
    }
    fn delivery() -> Frame {
        let mut next = frame();
        next.nonce = random_hex(16).unwrap();
        next
    }
    fn read_delivery() -> Frame {
        let mut next = delivery();
        next.request_id = random_hex(32).unwrap();
        next
    }
    fn now_ms() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn table_edit() -> Request {
        request(
            TABLE,
            "PATCH",
            Some(json!({"client_event_id": "assign-waiter-1", "waiter_id": "waiter"})),
        )
    }
    fn receipt_count(db: &Mutex<Connection>) -> i64 {
        db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM cafe_lan_receipts_v1", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[tokio::test]
    async fn retry_class_refusals_are_never_replayed_from_the_journal() {
        for refusal in [
            (
                429,
                json!({"success": false, "error": "Rate limit exceeded"}),
            ),
            (
                409,
                json!({"success": false, "error": "Waiting for parent order sync"}),
            ),
            (408, json!({"success": false, "error": "Request timeout"})),
        ] {
            let db = Mutex::new(Connection::open_in_memory().unwrap());
            let cloud = ScriptedCloud::replying(vec![
                refusal.clone(),
                (200, json!({"success": true, "table": {"id": "table"}})),
            ]);
            let request = table_edit();
            let first = relay(&cloud, &db, &delivery(), &[7; 32], &request, now_ms())
                .await
                .unwrap();
            assert_eq!(first["status"], refusal.0);
            assert_eq!(first["success"], false);
            let second = relay(&cloud, &db, &delivery(), &[7; 32], &request, now_ms())
                .await
                .unwrap();
            assert_eq!(
                cloud.count("send"),
                2,
                "status {} was replayed from the journal",
                refusal.0
            );
            assert_eq!(second["status"], 200);
            assert_eq!(cloud.count("apply"), 1);
        }
    }

    #[tokio::test]
    async fn deterministic_refusals_stay_journaled_unless_marked_retryable() {
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::replying(vec![(
            400,
            json!({"success": false, "error": "Validation failed"}),
        )]);
        for _ in 0..2 {
            let reply = relay(&cloud, &db, &delivery(), &[7; 32], &table_edit(), now_ms())
                .await
                .unwrap();
            assert_eq!(reply["status"], 400);
        }
        assert_eq!(cloud.count("send"), 1);
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::replying(vec![
            (
                422,
                json!({"success": false, "code": "PAYMENT_CURRENCY_UNRESOLVED", "retry_same_identity": true}),
            ),
            (200, json!({"success": true})),
        ]);
        relay(&cloud, &db, &delivery(), &[7; 32], &table_edit(), now_ms())
            .await
            .unwrap();
        let retried = relay(&cloud, &db, &delivery(), &[7; 32], &table_edit(), now_ms())
            .await
            .unwrap();
        assert_eq!(cloud.count("send"), 2);
        assert_eq!(retried["status"], 200);
    }

    #[tokio::test]
    async fn legacy_retained_retry_refusal_is_dispatched_again() {
        // A 1.4.123 main retained a 429 as final; after the upgrade that row
        // must stop answering the waiter's retries.
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let request = table_edit();
        let hash = request_hash(&request);
        let seeded = delivery();
        {
            let conn = db.lock().unwrap();
            assert!(matches!(
                begin_receipt(&conn, &seeded, &hash, &request.path).unwrap(),
                Receipt::Dispatch
            ));
            let legacy = json!({"wire": {"success": false, "status": 429, "data": {"success": false, "error": "Rate limit exceeded"}}, "ready": true});
            let encrypted = encrypt(
                &[7; 32],
                &receipt_aad(&seeded, &hash),
                legacy.to_string().as_bytes(),
            )
            .unwrap();
            conn.execute(
                "UPDATE cafe_lan_receipts_v1 SET response_ciphertext=?1,state='received' WHERE request_id=?2",
                params![encrypted, seeded.request_id],
            )
            .unwrap();
        }
        let cloud = ScriptedCloud::replying(vec![(200, json!({"success": true}))]);
        let reply = relay(&cloud, &db, &delivery(), &[7; 32], &request, now_ms())
            .await
            .unwrap();
        assert_eq!(cloud.count("send"), 1);
        assert_eq!(reply["status"], 200);
        let again = relay(&cloud, &db, &delivery(), &[7; 32], &request, now_ms())
            .await
            .unwrap();
        assert_eq!(again["status"], 200);
        assert_eq!(
            cloud.count("send"),
            1,
            "the fresh success is the final receipt"
        );
    }

    #[tokio::test]
    async fn reads_keep_no_receipt_and_still_refresh_the_main() {
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::default();
        let poll = request("pos/orders/sync?limit=100", "GET", None);
        for _ in 0..3 {
            let reply = relay(&cloud, &db, &read_delivery(), &[7; 32], &poll, now_ms())
                .await
                .unwrap();
            assert_eq!(reply["success"], true);
        }
        assert_eq!(receipt_count(&db), 0);
        assert_eq!(cloud.count("apply"), 3);
    }

    #[test]
    fn mutation_receipts_are_pruned_by_age_and_count_instead_of_refusing_the_waiter() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let f = delivery();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
             INSERT INTO cafe_lan_receipts_v1(child_id,request_id,request_hash,path,response_ciphertext,state,updated_at)
             SELECT ?1,'seed-'||i,'h','pos/orders','v1:00','applied',
               CASE WHEN i<=4000 THEN ?2 ELSE ?3-10000+i END FROM n",
            params![f.scope.source_terminal_id, now - 8 * 24 * 60 * 60, now - 60],
        )
        .unwrap();
        assert!(matches!(
            begin_receipt(&conn, &f, "hash", "pos/payments").unwrap(),
            Receipt::Dispatch
        ));
        let (count, oldest_kept): (i64, i64) = conn
            .query_row(
                "SELECT count(*),min(CAST(substr(request_id,6) AS INTEGER)) FROM cafe_lan_receipts_v1 WHERE request_id LIKE 'seed-%'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 4_999);
        assert_eq!(oldest_kept, 5_002);
        let usage: (i64, i64) = conn
            .query_row(
                "SELECT receipts,bytes FROM cafe_lan_usage_v1 WHERE child_id=?1",
                [&f.scope.source_terminal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(usage, (5_000, 4_999 * 5));
    }

    #[test]
    fn receipt_size_accounting_is_incremental() {
        let conn = Connection::open_in_memory().unwrap();
        let f = delivery();
        let child = f.scope.source_terminal_id.clone();
        begin_receipt(&conn, &f, "hash", "pos/payments").unwrap();
        persist_response(
            &conn,
            &f,
            "hash",
            &[7; 32],
            &json!({"wire": {"success": true, "status": 200, "data": {"payment_id": "p"}}, "ready": false}),
        )
        .unwrap();
        let stored = |conn: &Connection| -> (i64, i64) {
            conn.query_row(
                "SELECT receipts,bytes FROM cafe_lan_usage_v1 WHERE child_id=?1",
                [&child],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        let actual = |conn: &Connection| -> (i64, i64) {
            conn.query_row(
                "SELECT count(*),coalesce(sum(length(response_ciphertext)),0) FROM cafe_lan_receipts_v1 WHERE child_id=?1",
                [&child],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(stored(&conn), actual(&conn));
        assert!(stored(&conn).1 > 0);
        conn.execute("DELETE FROM cafe_lan_receipts_v1", [])
            .unwrap();
        assert_eq!(stored(&conn), (0, 0));
    }

    #[tokio::test]
    async fn nonce_history_is_bounded_by_age() {
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::default();
        let read = request("pos/tables", "GET", None);
        let first = read_delivery();
        let start = now_ms();
        relay(&cloud, &db, &first, &[7; 32], &read, start)
            .await
            .unwrap();
        relay(
            &cloud,
            &db,
            &read_delivery(),
            &[7; 32],
            &read,
            start + 2 * 60 * 60 * 1000,
        )
        .await
        .unwrap();
        let kept: i64 = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM cafe_lan_nonces_v1 WHERE nonce=?1",
                [&first.nonce],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 0);
    }

    #[tokio::test]
    async fn replayed_frame_is_refused_before_any_cloud_call() {
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::default();
        let payment = request(
            "pos/payments",
            "POST",
            Some(json!({"idempotency_key": "pay-1", "amount": 5})),
        );
        let delivered = delivery();
        relay(&cloud, &db, &delivered, &[7; 32], &payment, now_ms())
            .await
            .unwrap();
        assert_eq!(
            relay(&cloud, &db, &delivered, &[7; 32], &payment, now_ms())
                .await
                .unwrap_err(),
            "LAN_NONCE_REPLAY"
        );
        assert_eq!(cloud.count("validate"), 1);
        assert_eq!(cloud.count("send"), 1);
    }

    #[tokio::test]
    async fn stale_or_future_frames_are_refused_before_any_cloud_call() {
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::default();
        let now = now_ms();
        for skew in [-11 * 60 * 1000, 11 * 60 * 1000] {
            let mut read = request("pos/tables", "GET", None);
            read.sent_at = Some(now + skew);
            assert_eq!(
                relay(&cloud, &db, &read_delivery(), &[7; 32], &read, now)
                    .await
                    .unwrap_err(),
                "LAN_FRAME_EXPIRED"
            );
        }
        assert_eq!(cloud.count("validate"), 0);
        let mut read = request("pos/tables", "GET", None);
        read.sent_at = Some(now - 30_000);
        relay(&cloud, &db, &read_delivery(), &[7; 32], &read, now)
            .await
            .unwrap();
        // Waiters older than Android 1.0.20 send no timestamp and keep working.
        relay(
            &cloud,
            &db,
            &read_delivery(),
            &[7; 32],
            &request("pos/tables", "GET", None),
            now,
        )
        .await
        .unwrap();
        assert_eq!(cloud.count("validate"), 2);
    }

    #[tokio::test]
    async fn relay_policy_refusal_falls_back_to_https_instead_of_answering() {
        let db = Mutex::new(Connection::open_in_memory().unwrap());
        let cloud = ScriptedCloud::default();
        let payment = request(
            "pos/payments",
            "POST",
            Some(json!({"idempotency_key": "pay-1", "amount": 5})),
        );
        for (status, body) in [
            (
                403,
                json!({"success": false, "error": "MODULE_REQUIRED", "missingModules": ["tables"]}),
            ),
            (
                429,
                json!({"success": false, "error": "Rate limit exceeded"}),
            ),
        ] {
            cloud.refuse_validation(status, body);
            assert_eq!(
                relay(&cloud, &db, &delivery(), &[7; 32], &payment, now_ms())
                    .await
                    .unwrap_err(),
                "LAN_CHILD_AUTHORITY_DENIED"
            );
        }
        assert_eq!(cloud.count("send"), 0);
        assert_eq!(receipt_count(&db), 0);
    }

    #[test]
    fn allowlist_rejects_non_object_mutation_bodies() {
        let mut payment = request(
            "pos/payments",
            "POST",
            Some(json!([{"idempotency_key": "x", "amount": 1}])),
        );
        payment.idempotency_key = Some("x".into());
        assert_eq!(allowed(&payment).unwrap_err(), "LAN_INVALID_REQUEST");
        assert!(allowed(&request(TABLE, "PATCH", Some(json!("client_event_id")))).is_err());
    }
}
