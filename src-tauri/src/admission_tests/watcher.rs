use super::*;
use crate::tests::harness::TestDb;
use std::{rc::Rc, sync::mpsc, time::Duration};

#[test]
fn admission_image_ingest_validates_before_writer_and_commits_page_event_and_ledger() {
    let db = TestDb::open();
    let conn = Rc::new(Connection::open(db.db_path()).unwrap());
    conn.busy_timeout(Duration::from_millis(5000)).unwrap();
    let (entered, pause) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let observed = conn.clone();
    store::PAGE_VALIDATOR_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            assert!(observed.is_autocommit());
            entered.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(2)).unwrap();
        }))
    });
    let path = db.db_path().to_owned();
    let checkout = std::thread::spawn(move || {
        pause.recv_timeout(Duration::from_secs(2)).unwrap();
        let at = std::time::Instant::now();
        let checkout = crate::admission_tests::writer(&path);
        checkout.execute_batch("CREATE TABLE checkout_probe(id INTEGER); INSERT INTO checkout_probe VALUES(1); COMMIT").unwrap();
        assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
        release.send(()).unwrap();
    });
    let source = WatchedFolderSource {
        id: "your-source".into(),
        name: "your-folder".into(),
        folder: db.dir().to_owned(),
        housekeeping: Housekeeping::None,
    };
    let result = ingest_document(
        &conn,
        db.dir(),
        &source,
        &db.dir().join("your-image.png"),
        "image/png",
        b"your-page",
        "your-hash",
    )
    .unwrap();
    store::PAGE_VALIDATOR_HOOK.with(|hook| *hook.borrow_mut() = None);
    checkout.join().unwrap();
    let id = result.capture_id.unwrap();
    let doc = store::get_document(&conn, &id).unwrap().unwrap();
    assert_eq!(doc.page_count, 1);
    assert_eq!(doc.status, CaptureStatus::Waiting);
    assert_eq!(store::list_pages(&conn, &id).unwrap().len(), 1);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM capture_ingest_ledger", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn admission_missing_ingest_file_creates_no_document() {
    let db = TestDb::open();
    let conn = Rc::new(Connection::open(db.db_path()).unwrap());
    conn.busy_timeout(Duration::from_millis(5000)).unwrap();
    let root = files::captures_root(db.dir()).unwrap();
    store::PAGE_VALIDATOR_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            for directory in std::fs::read_dir(&root).unwrap() {
                for page in std::fs::read_dir(directory.unwrap().path()).unwrap() {
                    std::fs::remove_file(page.unwrap().path()).unwrap();
                }
            }
        }))
    });
    let source = WatchedFolderSource {
        id: "your-source".into(),
        name: "your-folder".into(),
        folder: db.dir().to_owned(),
        housekeeping: Housekeeping::None,
    };
    let before = conn.total_changes();
    assert!(ingest_document(
        &conn,
        db.dir(),
        &source,
        &db.dir().join("your-image.png"),
        "image/png",
        b"your-page",
        "your-hash"
    )
    .is_err());
    store::PAGE_VALIDATOR_HOOK.with(|hook| *hook.borrow_mut() = None);
    assert_eq!(conn.total_changes(), before);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM capture_documents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
