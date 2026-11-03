use crate::support::{db::SupportDb, terminal_cmd};

#[test]
fn historical_command_kind_is_permanently_unsupported() {
    let dir = crate::tests::harness::TempDir::new();
    let db = SupportDb::open(dir.path()).unwrap();
    assert_eq!(
        terminal_cmd::refuse_unavailable(&db.conn),
        "UNSUPPORTED_ON_PLATFORM"
    );
}

#[test]
fn no_encoding_display_switch_or_launch_scaffolding_remains() {
    let source = include_str!("../terminal_cmd.rs");
    for forbidden in [
        "CreateProcess",
        "Command::new",
        "ApprovedText",
        "encode_utf16",
        "request_onsite",
        "check_switch",
    ] {
        assert!(
            !source.contains(forbidden),
            "unexpected runner surface: {forbidden}"
        );
    }
}
