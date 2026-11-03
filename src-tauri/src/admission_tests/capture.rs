use super::*;
use crate::admission_tests::writer;
use crate::tests::harness::TestDb;
use std::{rc::Rc, sync::mpsc, time::Duration};

#[test]
fn admission_lifecycle_is_scoped_to_the_capture_store() {
    let first = TestDb::open();
    let second = TestDb::open();
    let _guard = files::lock_lifecycle(first.dir(), "your-capture").unwrap();
    assert!(files::try_lock_lifecycle(first.dir(), "your-capture")
        .unwrap()
        .is_none());
    assert!(files::try_lock_lifecycle(second.dir(), "your-capture")
        .unwrap()
        .is_some());
}

#[test]
fn admission_page_validation_does_not_reserve_and_missing_or_discarded_pages_refuse() {
    for count in [1, 3] {
        let db = TestDb::open();
        let conn = Rc::new(Connection::open(db.db_path()).unwrap());
        conn.busy_timeout(Duration::from_millis(5000)).unwrap();
        let id = "your-capture";
        create_document(
            &conn,
            &super::NewCaptureDocument {
                id: id.into(),
                source_kind: CaptureSourceKind::WatchedFolder,
                source_name: None,
                staff_id: None,
                captured_at: "2026-11-01T00:00:00Z".into(),
                content_hash: None,
            },
        )
        .unwrap();
        let pages = (0..count)
            .map(|index| {
                files::write_page_blocking(db.dir(), id, index, "image/png", b"your-page").unwrap()
            })
            .collect::<Vec<_>>();
        let lifecycle = files::lock_lifecycle(db.dir(), id).unwrap();
        let (entered, pause) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let observed = conn.clone();
        let mut once = false;
        PAGE_VALIDATOR_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                assert!(observed.is_autocommit());
                if !once {
                    once = true;
                    entered.send(()).unwrap();
                    resume.recv_timeout(Duration::from_secs(2)).unwrap();
                }
            }))
        });
        let path = db.db_path().to_owned();
        let checkout = std::thread::spawn(move || {
            pause.recv_timeout(Duration::from_secs(2)).unwrap();
            let at = std::time::Instant::now();
            let checkout = writer(&path);
            checkout.execute_batch("CREATE TABLE checkout_probe(id INTEGER); INSERT INTO checkout_probe VALUES(1); COMMIT").unwrap();
            assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
            release.send(()).unwrap();
        });
        let validated = pages
            .iter()
            .map(|page| validate_written_page(&lifecycle, id, page).unwrap())
            .collect::<Vec<_>>();
        PAGE_VALIDATOR_HOOK.with(|hook| *hook.borrow_mut() = None);
        checkout.join().unwrap();
        crate::capture::watcher::record_rendered_pages(&conn, id, &validated).unwrap();
        assert_eq!(list_pages(&conn, id).unwrap().len(), count);
        drop(validated);
        drop(lifecycle);
        // An explicit discard wins before another admission; no page can be added.
        set_status(&conn, id, CaptureStatus::Discarded, None).unwrap();
        files::remove_capture_files(db.dir(), id).unwrap();
        let lifecycle = files::lock_lifecycle(db.dir(), id).unwrap();
        assert!(validate_written_page(&lifecycle, id, &pages[0]).is_err());
    }
}

#[test]
fn admission_lifecycle_fences_replacement_and_discard_through_commit() {
    let db = TestDb::open();
    let id = "your-capture";
    let conn = db.state.conn.lock().unwrap();
    create_document(
        &conn,
        &super::NewCaptureDocument {
            id: id.into(),
            source_kind: CaptureSourceKind::WatchedFolder,
            source_name: None,
            staff_id: None,
            captured_at: "2026-11-01T00:00:00Z".into(),
            content_hash: None,
        },
    )
    .unwrap();
    let page = files::write_page_blocking(db.dir(), id, 0, "image/png", b"your-page").unwrap();
    let lifecycle = files::lock_lifecycle(db.dir(), id).unwrap();
    let validated = validate_written_page(&lifecycle, id, &page).unwrap();
    assert!(files::try_lock_lifecycle(db.dir(), id).unwrap().is_none());
    set_status(&conn, id, CaptureStatus::Discarded, None).unwrap();
    let before = conn.total_changes();
    let tx = crate::db::immediate_transaction(&conn).unwrap();
    assert!(record_validated_page(&tx, id, &validated).is_err());
    drop(tx);
    assert_eq!(conn.total_changes(), before);
    assert!(list_pages(&conn, id).unwrap().is_empty());
}
