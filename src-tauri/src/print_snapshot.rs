use flate2::{write::ZlibEncoder, Compression, Decompress, FlushDecompress, Status};
// Only the cfg(test) seeding/read-back helpers below touch SQLite directly; the shipped
// encode/decode pair is pure. Production snapshot I/O lives in `prepare_managed_attempt`.
#[cfg(test)]
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::io::Write;

pub const PRINT_SNAPSHOT_VERSION: i64 = 1;

const MAX_DECODED_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

pub struct EncodedPrintSnapshot {
    pub version: i64,
    pub compressed: Vec<u8>,
    pub sha256: String,
}

pub fn encode_print_payload(bytes: &[u8]) -> Result<EncodedPrintSnapshot, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(bytes)
        .map_err(|error| format!("compress print payload: {error}"))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("finish print payload compression: {error}"))?;

    Ok(EncodedPrintSnapshot {
        version: PRINT_SNAPSHOT_VERSION,
        compressed,
        sha256: sha256_hex(bytes),
    })
}

pub fn decode_print_payload(
    version: i64,
    compressed: &[u8],
    sha256: &str,
) -> Result<Vec<u8>, String> {
    if version != PRINT_SNAPSHOT_VERSION {
        return Err(format!("unsupported print snapshot version: {version}"));
    }
    if !is_lowercase_sha256(sha256) {
        return Err("malformed print snapshot SHA-256 digest".to_string());
    }

    let mut decompressor = Decompress::new(true);
    let mut decoded = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    let mut input_offset = 0;
    loop {
        let input_before = decompressor.total_in();
        let output_before = decompressor.total_out();
        let status = decompressor
            .decompress(
                &compressed[input_offset..],
                &mut buffer,
                FlushDecompress::None,
            )
            .map_err(|error| format!("decompress print payload: {error}"))?;
        let bytes_consumed = usize::try_from(decompressor.total_in() - input_before)
            .map_err(|_| "decompress print payload consumed too many bytes")?;
        let bytes_produced = usize::try_from(decompressor.total_out() - output_before)
            .map_err(|_| "decompress print payload produced too many bytes")?;
        input_offset = input_offset
            .checked_add(bytes_consumed)
            .ok_or("decompress print payload input offset overflow")?;

        if decoded.len().saturating_add(bytes_produced) > MAX_DECODED_PAYLOAD_BYTES {
            return Err("decoded print payload exceeds the 4 MiB limit".to_string());
        }
        decoded.extend_from_slice(&buffer[..bytes_produced]);

        match status {
            Status::StreamEnd => {
                if input_offset != compressed.len() {
                    return Err("print snapshot has trailing compressed bytes".to_string());
                }
                break;
            }
            Status::Ok | Status::BufError if bytes_consumed != 0 || bytes_produced != 0 => {}
            Status::Ok | Status::BufError => {
                return Err("decompress print payload: incomplete zlib stream".to_string());
            }
        }
    }

    if sha256_hex(&decoded) != sha256 {
        return Err("print snapshot SHA-256 mismatch".to_string());
    }

    Ok(decoded)
}

/// Test-only snapshot seeding.
///
/// Production no longer writes snapshots through a standalone helper:
/// `print_dispatch::prepare_managed_attempt` performs the same write-if-absent inside the
/// immediate transaction that claims the parent job, and additionally verifies an already
/// stored snapshot matches the frozen dispatch. Keeping a second writable path in the
/// shipped binary would let a caller persist a snapshot without claiming the parent, which
/// is the split-transaction shape the managed pipeline exists to remove. Retained behind
/// cfg(test) purely so tests can seed a snapshot directly.
#[cfg(test)]
pub fn persist_snapshot_if_absent(
    conn: &Connection,
    job_id: &str,
    encoded: &EncodedPrintSnapshot,
    render_profile_json: &str,
) -> Result<bool, String> {
    // Validate caller-provided encoded data before it becomes an immutable
    // stored snapshot. This also enforces the decoded-size ceiling at write time.
    decode_print_payload(encoded.version, &encoded.compressed, &encoded.sha256)?;

    let rows_changed = conn
        .execute(
            "
            UPDATE print_jobs
            SET document_snapshot_version = ?1,
                document_snapshot_zlib = ?2,
                document_snapshot_sha256 = ?3,
                render_profile_snapshot_json = ?4
            WHERE id = ?5
              AND document_snapshot_version IS NULL
              AND document_snapshot_zlib IS NULL
              AND document_snapshot_sha256 IS NULL
              AND render_profile_snapshot_json IS NULL
            ",
            (
                encoded.version,
                &encoded.compressed,
                &encoded.sha256,
                render_profile_json,
                job_id,
            ),
        )
        .map_err(|error| format!("persist print snapshot: {error}"))?;

    if rows_changed == 1 {
        return Ok(true);
    }

    match read_snapshot_columns(conn, job_id)? {
        None => Err(format!("print job not found for snapshot: {job_id}")),
        Some(snapshot) if snapshot.is_empty() => {
            Err(format!("print snapshot write lost for job: {job_id}"))
        }
        Some(snapshot) if snapshot.is_complete() => Ok(false),
        Some(_) => Err(format!("print snapshot is partial for job: {job_id}")),
    }
}

/// Test-only snapshot read-back.
///
/// Used by tests to assert what the live path stored; production decodes the snapshot
/// inline in `prepare_managed_attempt` (to prove immutability against the frozen
/// dispatch) rather than reloading it through a helper.
#[cfg(test)]
pub fn load_snapshot(conn: &Connection, job_id: &str) -> Result<Option<Vec<u8>>, String> {
    match read_snapshot_columns(conn, job_id)? {
        None => Ok(None),
        Some(snapshot) if snapshot.is_empty() => Ok(None),
        Some(snapshot) if snapshot.is_complete() => Ok(Some(decode_print_payload(
            snapshot.version.expect("complete snapshot version"),
            snapshot
                .compressed
                .as_deref()
                .expect("complete snapshot payload"),
            snapshot
                .sha256
                .as_deref()
                .expect("complete snapshot digest"),
        )?)),
        Some(_) => Err(format!("print snapshot is partial for job: {job_id}")),
    }
}

// Test-only: exists solely to back the two cfg(test) helpers above.
#[cfg(test)]
#[derive(Debug)]
struct SnapshotColumns {
    version: Option<i64>,
    compressed: Option<Vec<u8>>,
    sha256: Option<String>,
    render_profile_json: Option<String>,
}

#[cfg(test)]
impl SnapshotColumns {
    fn is_empty(&self) -> bool {
        self.version.is_none()
            && self.compressed.is_none()
            && self.sha256.is_none()
            && self.render_profile_json.is_none()
    }

    fn is_complete(&self) -> bool {
        self.version.is_some()
            && self.compressed.is_some()
            && self.sha256.is_some()
            && self.render_profile_json.is_some()
    }
}

// Test-only: exists solely to back the two cfg(test) helpers above.
#[cfg(test)]
fn read_snapshot_columns(
    conn: &Connection,
    job_id: &str,
) -> Result<Option<SnapshotColumns>, String> {
    conn.query_row(
        "
        SELECT document_snapshot_version,
               document_snapshot_zlib,
               document_snapshot_sha256,
               render_profile_snapshot_json
        FROM print_jobs
        WHERE id = ?1
        ",
        [job_id],
        |row| {
            Ok(SnapshotColumns {
                version: row.get(0)?,
                compressed: row.get(1)?,
                sha256: row.get(2)?,
                render_profile_json: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("read print snapshot: {error}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_print_payload, encode_print_payload, load_snapshot, persist_snapshot_if_absent,
        PRINT_SNAPSHOT_VERSION,
    };
    use rusqlite::Connection;

    fn snapshot_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory snapshot database");
        conn.execute_batch(
            "
            CREATE TABLE print_jobs (
                id TEXT PRIMARY KEY,
                document_snapshot_version INTEGER,
                document_snapshot_zlib BLOB,
                document_snapshot_sha256 TEXT,
                render_profile_snapshot_json TEXT
            );
            ",
        )
        .expect("create snapshot test schema");
        conn
    }

    fn insert_job(conn: &Connection, job_id: &str) {
        conn.execute("INSERT INTO print_jobs (id) VALUES (?1)", [job_id])
            .expect("insert print job");
    }

    #[test]
    fn round_trips_exact_greek_escpos_like_bytes() {
        let payload = [
            b"\x1b@\x1bt\x11\x1ba\x01".as_slice(),
            "\u{039a}\u{03b1}\u{03bb}\u{03b7}\u{03bc}\u{03ad}\u{03c1}\u{03b1}".as_bytes(),
            b"\n\x1dV\x00",
        ]
        .concat();

        let encoded = encode_print_payload(&payload).expect("encode payload");
        let decoded = decode_print_payload(encoded.version, &encoded.compressed, &encoded.sha256)
            .expect("decode payload");

        assert_eq!(decoded, payload);
        assert_eq!(encoded.version, PRINT_SNAPSHOT_VERSION);
        assert_eq!(encoded.sha256.len(), 64);
        assert!(encoded
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn deterministic_raster_payload_compresses_smaller() {
        let payload = (0..64 * 1024)
            .map(|index| if index % 64 < 48 { 0u8 } else { 0xff })
            .collect::<Vec<_>>();

        let encoded = encode_print_payload(&payload).expect("encode raster payload");

        assert!(encoded.compressed.len() < payload.len());
        assert_eq!(
            decode_print_payload(encoded.version, &encoded.compressed, &encoded.sha256)
                .expect("decode raster payload"),
            payload
        );
    }

    #[test]
    fn rejects_sha_mismatch() {
        let encoded = encode_print_payload(b"integrity").expect("encode payload");

        let error = decode_print_payload(encoded.version, &encoded.compressed, &"0".repeat(64))
            .expect_err("mismatched digest must fail");

        assert!(error.contains("SHA-256"));
        assert!(
            decode_print_payload(encoded.version, &encoded.compressed, "not-a-digest")
                .expect_err("malformed digest must fail")
                .contains("malformed")
        );
    }

    #[test]
    fn rejects_unsupported_version() {
        let encoded = encode_print_payload(b"versioned").expect("encode payload");

        let error = decode_print_payload(
            PRINT_SNAPSHOT_VERSION + 1,
            &encoded.compressed,
            &encoded.sha256,
        )
        .expect_err("unsupported version must fail");

        assert!(error.contains("unsupported"));
    }

    #[test]
    fn rejects_valid_zlib_with_trailing_garbage() {
        let encoded = encode_print_payload(b"complete stream").expect("encode payload");
        let mut trailing = encoded.compressed.clone();
        trailing.extend_from_slice(b"not part of the zlib stream");

        assert!(
            decode_print_payload(encoded.version, &trailing, &encoded.sha256)
                .expect_err("trailing bytes must fail")
                .contains("trailing")
        );
    }

    #[test]
    fn rejects_additional_zlib_member() {
        let first = encode_print_payload(b"first stream").expect("encode first payload");
        let second = encode_print_payload(b"second stream").expect("encode second payload");
        let mut concatenated = first.compressed.clone();
        concatenated.extend_from_slice(&second.compressed);

        assert!(
            decode_print_payload(first.version, &concatenated, &first.sha256)
                .expect_err("a second zlib member must fail")
                .contains("trailing")
        );
    }

    #[test]
    fn rejects_truncated_zlib_stream() {
        let encoded = encode_print_payload(b"complete stream").expect("encode payload");
        let mut truncated = encoded.compressed.clone();
        truncated.pop();

        assert!(
            decode_print_payload(encoded.version, &truncated, &encoded.sha256)
                .expect_err("truncated stream must fail")
                .contains("decompress")
        );
    }

    #[test]
    fn rejects_corrupted_zlib_stream_with_correct_plaintext_digest() {
        let payload = vec![0x5a; 4 * 1024];
        let encoded = encode_print_payload(&payload).expect("encode payload");
        let mut corrupt = encoded.compressed.clone();
        let final_checksum_byte = corrupt
            .last_mut()
            .expect("zlib payload has an Adler-32 checksum");
        *final_checksum_byte ^= 0x01;

        assert!(
            decode_print_payload(encoded.version, &corrupt, &encoded.sha256)
                .expect_err("corrupt stream must fail even with the original digest")
                .contains("decompress")
        );
    }

    #[test]
    fn rejects_payload_over_decoded_size_limit() {
        let payload = vec![0x5a; 4 * 1024 * 1024 + 1];
        let encoded = encode_print_payload(&payload).expect("encode oversized payload");

        let error = decode_print_payload(encoded.version, &encoded.compressed, &encoded.sha256)
            .expect_err("oversized decoded payload must fail");

        assert!(error.contains("4 MiB"));
    }

    #[test]
    fn empty_payload_round_trips() {
        let encoded = encode_print_payload(&[]).expect("encode empty payload");

        assert_eq!(
            decode_print_payload(encoded.version, &encoded.compressed, &encoded.sha256)
                .expect("decode empty payload"),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn persists_first_snapshot_and_loads_exact_bytes() {
        let conn = snapshot_db();
        insert_job(&conn, "job-first");
        let payload = b"\x1b@first snapshot\n";
        let encoded = encode_print_payload(payload).expect("encode payload");

        assert!(persist_snapshot_if_absent(
            &conn,
            "job-first",
            &encoded,
            r#"{"template":"classic"}"#,
        )
        .expect("persist first snapshot"));
        assert_eq!(
            load_snapshot(&conn, "job-first").expect("load first snapshot"),
            Some(payload.to_vec())
        );
    }

    #[test]
    fn real_v73_schema_persists_first_snapshot_and_enforces_immutability() {
        let conn = Connection::open_in_memory().expect("open in-memory migrated database");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "
            INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
            VALUES (?1, 'order_receipt', 'order-1', 'pending', datetime('now'), datetime('now'))
            ",
            ["v73-schema-job"],
        )
        .expect("insert migrated print job");
        let encoded = encode_print_payload(b"v73 persisted snapshot").expect("encode payload");

        assert!(
            persist_snapshot_if_absent(&conn, "v73-schema-job", &encoded, "{}")
                .expect("persist snapshot on migrated schema")
        );
        assert!(conn
            .execute(
                "UPDATE print_jobs SET document_snapshot_version = 2 WHERE id = ?1",
                ["v73-schema-job"],
            )
            .expect_err("v73 immutable snapshot trigger must reject changes")
            .to_string()
            .contains("immutable"));
        assert_eq!(
            load_snapshot(&conn, "v73-schema-job").expect("load migrated snapshot"),
            Some(b"v73 persisted snapshot".to_vec())
        );
    }

    #[test]
    fn second_conflicting_snapshot_never_overwrites_first() {
        let conn = snapshot_db();
        insert_job(&conn, "job-conflict");
        let first = encode_print_payload(b"first immutable bytes").expect("encode first");
        let second = encode_print_payload(b"conflicting bytes").expect("encode second");

        assert!(
            persist_snapshot_if_absent(&conn, "job-conflict", &first, "{}")
                .expect("persist first snapshot")
        );
        assert!(
            !persist_snapshot_if_absent(&conn, "job-conflict", &second, "{}")
                .expect("reject conflicting second snapshot")
        );
        assert_eq!(
            load_snapshot(&conn, "job-conflict").expect("load first snapshot"),
            Some(b"first immutable bytes".to_vec())
        );
    }

    #[test]
    fn missing_or_legacy_snapshot_returns_none() {
        let conn = snapshot_db();
        insert_job(&conn, "legacy-job");

        assert_eq!(
            load_snapshot(&conn, "missing-job").expect("missing job"),
            None
        );
        assert_eq!(
            load_snapshot(&conn, "legacy-job").expect("legacy job"),
            None
        );
    }

    #[test]
    fn partial_stored_snapshot_is_an_error() {
        let conn = snapshot_db();
        insert_job(&conn, "partial-job");
        conn.execute(
            "UPDATE print_jobs SET document_snapshot_version = ?1 WHERE id = ?2",
            [
                PRINT_SNAPSHOT_VERSION.to_string(),
                "partial-job".to_string(),
            ],
        )
        .expect("create partial snapshot");
        let encoded = encode_print_payload(b"replacement").expect("encode replacement");

        assert!(
            persist_snapshot_if_absent(&conn, "partial-job", &encoded, "{}")
                .expect_err("partial snapshot must not be repaired")
                .contains("partial")
        );
        assert!(load_snapshot(&conn, "partial-job")
            .expect_err("partial snapshot must not load")
            .contains("partial"));
    }

    #[test]
    fn corrupt_or_unsupported_stored_snapshot_is_an_error() {
        let conn = snapshot_db();
        insert_job(&conn, "corrupt-job");
        insert_job(&conn, "unsupported-job");
        let encoded = encode_print_payload(b"stored payload").expect("encode stored payload");

        conn.execute(
            "
            UPDATE print_jobs
            SET document_snapshot_version = ?1,
                document_snapshot_zlib = ?2,
                document_snapshot_sha256 = ?3,
                render_profile_snapshot_json = ?4
            WHERE id = ?5
            ",
            (
                encoded.version,
                &encoded.compressed,
                "0".repeat(64),
                "{}",
                "corrupt-job",
            ),
        )
        .expect("store corrupt snapshot");
        conn.execute(
            "
            UPDATE print_jobs
            SET document_snapshot_version = ?1,
                document_snapshot_zlib = ?2,
                document_snapshot_sha256 = ?3,
                render_profile_snapshot_json = ?4
            WHERE id = ?5
            ",
            (
                PRINT_SNAPSHOT_VERSION + 1,
                &encoded.compressed,
                &encoded.sha256,
                "{}",
                "unsupported-job",
            ),
        )
        .expect("store unsupported snapshot");

        assert!(load_snapshot(&conn, "corrupt-job")
            .expect_err("corrupt snapshot must not load")
            .contains("SHA-256"));
        assert!(load_snapshot(&conn, "unsupported-job")
            .expect_err("unsupported snapshot must not load")
            .contains("unsupported"));
    }
}
