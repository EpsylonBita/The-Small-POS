//! Historical free-text commands are permanently unsupported.
use rusqlite::Connection;

pub fn refuse_unavailable(_conn: &Connection) -> &'static str {
    "UNSUPPORTED_ON_PLATFORM"
}
