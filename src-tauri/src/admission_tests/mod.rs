//! File-backed WAL fixtures for the write-admission review regressions.
use rusqlite::Connection;
use std::time::{Duration, Instant};

/// How long an action may take and still count as not having waited for a writer.
/// Waiting would cost the held writer's 5 s busy timeout, or the paused admission's
/// 2 s resume timeout before the writer frees. 250 ms flaked on a loaded Windows
/// runner (PR #401: an uncontended BEGIN IMMEDIATE ... COMMIT took longer).
pub(crate) const UNBLOCKED: Duration = Duration::from_millis(1500);

pub(crate) fn writer(path: &std::path::Path) -> Connection {
    let writer = Connection::open(path).unwrap();
    writer.busy_timeout(Duration::from_millis(5000)).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    writer
}

pub(crate) fn no_write<T>(conn: &Connection, action: impl FnOnce() -> T) -> T {
    assert_eq!(
        conn.pragma_query_value(None, "busy_timeout", |r| r.get::<_, i64>(0))
            .unwrap(),
        5000
    );
    let before = conn.total_changes();
    let at = Instant::now();
    let result = action();
    assert!(
        at.elapsed() < UNBLOCKED,
        "read-only outcome waited: {:?}",
        at.elapsed()
    );
    assert_eq!(conn.total_changes(), before);
    assert!(conn.is_autocommit());
    result
}

pub(crate) fn terminal(conn: &Connection) {
    for (key, value) in [
        ("organization_id", "11111111-1111-4111-8111-111111111111"),
        ("branch_id", "22222222-2222-4222-8222-222222222222"),
        ("terminal_id", "your-terminal"),
        ("owner_terminal_id", "33333333-3333-4333-8333-333333333333"),
    ] {
        crate::db::set_setting(conn, "terminal", key, value).unwrap();
    }
}

pub(crate) fn order(conn: &Connection) {
    conn.execute_batch("INSERT INTO orders(id,supabase_id,organization_id,branch_id,items,total_amount,total_amount_cents,status,payment_status,created_at,updated_at) VALUES('your-order','44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','[]',10,1000,'pending','pending','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');").unwrap();
}

pub(crate) fn before_admission(hook: impl FnOnce(&Connection) + 'static) {
    crate::db::BEFORE_WRITE_ADMISSION.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

/// Pause the real credential seam on its first read. Every later read is also
/// checked for autocommit, including nested after-first-write call trees.
pub(crate) fn pause_credentials_for_checkout(
    conn: std::rc::Rc<Connection>,
    path: std::path::PathBuf,
) -> std::thread::JoinHandle<()> {
    let (entered, paused) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let mut first = true;
    crate::tests::fake_keyring::before_each_read(move |key| {
        assert!(conn.is_autocommit(), "credential {key} under writer");
        if first {
            first = false;
            entered.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(2)).unwrap();
        }
    });
    std::thread::spawn(move || {
        paused.recv_timeout(Duration::from_secs(2)).unwrap();
        let at = Instant::now();
        let checkout = writer(&path);
        checkout.execute_batch("CREATE TABLE checkout_probe(id INTEGER); INSERT INTO checkout_probe VALUES(1); COMMIT").unwrap();
        assert!(at.elapsed() < UNBLOCKED);
        release.send(()).unwrap();
    })
}
