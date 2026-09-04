use crate::repair_transport::RepairSessionErrorCode;
use crate::repair_transport::{
    classify_repair_http_response, classify_repair_json_response_body,
    classify_repair_sync_response, prepare_repair_command_request, prepare_repair_json_request,
    repair_json_request, resolve_repair_session, send_repair_actor_bootstrap_request,
    send_repair_json_request, BoundedRepairHttpResponse, NativeRepairScope, ParityTerminalAuthCode,
    RepairAttachmentDisposition, RepairAttachmentUploadResult, RepairConflictProjection,
    RepairHookError, RepairJsonDisposition, RepairJsonRequest, RepairJsonTransportInput,
    RepairQueueContext, RepairQueueHooks, RepairRawAttachmentMetadata, RepairRawAttachmentUpload,
    RepairSyncDisposition, RepairSyncExpectedIdentity, RepairSyncSuccessSignal, RepairTypedCommand,
    UnavailableRepairQueueHooks, MAX_REPAIR_COLLECTION_RESPONSE_BYTES, MAX_REPAIR_RESPONSE_BYTES,
    MAX_REPAIR_RETRY_AFTER_SECONDS, REPAIR_PERMISSIONS,
};
use crate::sync_queue::{create_tables, peek, process_queue_with_repair_hooks, SyncQueueItem};
use crate::tests::fake_http::MockServer;
use crate::tests::fake_keyring;
use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use zeroize::{Zeroize, Zeroizing};

const SESSION_ID: &str = "11111111-1111-4a11-8111-111111111111";
const STAFF_ID: &str = "22222222-2222-4222-8222-222222222222";
const BRANCH_ID: &str = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID: &str = "44444444-4444-4444-8444-444444444444";
const TERMINAL_ID: &str = "terminal-repairs-a";
const OPERATION_ID: &str = "77777777-7777-4777-8777-777777777777";
const REPAIR_ID: &str = "88888888-8888-4888-8888-888888888888";
const UNBOUND_QUEUE_ID: &str = "99999999-9999-4999-8999-999999999999";
const REPAIR_SCOPE_TOKEN: &str = "55555555-5555-4555-8555-555555555555";

#[test]
fn repair_typed_ipc_command_exists_as_a_native_entrypoint() {
    let _native_command = repair_json_request;
}

#[tokio::test(flavor = "current_thread")]
async fn repair_typed_ipc_rejects_untrusted_transport_fields_and_missing_native_key() {
    let _keyring = install_repair_identity();
    let outer = serde_json::json!({
        "staffSessionId": SESSION_ID,
        "request": { "action": "settings" },
        "host": "https://attacker.example",
    });
    assert!(serde_json::from_value::<RepairJsonTransportInput>(outer).is_err());
    let variant = serde_json::json!({
        "staffSessionId": SESSION_ID,
        "request": {
            "action": "workspace",
            "repair_id": REPAIR_ID,
            "method": "DELETE",
            "headers": { "authorization": "attacker" }
        }
    });
    assert!(serde_json::from_value::<RepairJsonTransportInput>(variant).is_err());

    let server = MockServer::new(r#"{"unexpected":true}"#);
    let error = send_repair_json_request(
        &server.url,
        "",
        None,
        &native_scope(),
        &RepairJsonTransportInput {
            staff_session_id: SESSION_ID.to_string(),
            request: RepairJsonRequest::Settings,
        },
    )
    .await
    .expect_err("missing native API key must fail before request");
    assert_eq!(error.code(), "REPAIR_NATIVE_API_KEY_UNAVAILABLE");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

fn native_scope() -> NativeRepairScope {
    NativeRepairScope {
        organization_id: ORGANIZATION_ID.to_string(),
        branch_id: BRANCH_ID.to_string(),
        terminal_id: TERMINAL_ID.to_string(),
    }
}

fn complete_session_blob() -> String {
    serde_json::json!({
        "sessionId": SESSION_ID,
        "staffId": STAFF_ID,
        "branchId": BRANCH_ID,
        "organizationId": ORGANIZATION_ID,
        "terminalId": TERMINAL_ID,
        "staffName": "Repair Technician",
        "role": { "name": "technician" }
    })
    .to_string()
}

fn expected_sync_identity() -> RepairSyncExpectedIdentity {
    RepairSyncExpectedIdentity {
        operation_id: OPERATION_ID.to_string(),
        repair_id: REPAIR_ID.to_string(),
        expected_version: 3,
    }
}

#[test]
fn repair_session_gate_rejects_missing_and_partial_persisted_sessions() {
    let missing = resolve_repair_session(
        None,
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect_err("a missing native session must fail closed");
    assert_eq!(missing.code(), RepairSessionErrorCode::SessionRequired);

    let partial = serde_json::json!({
        "sessionId": SESSION_ID,
        "staffId": STAFF_ID,
        "terminalId": TERMINAL_ID
    })
    .to_string();
    let partial_error = resolve_repair_session(
        Some(&partial),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect_err("renderer-compatible partial sessions are not repair credentials");
    assert_eq!(partial_error.code(), RepairSessionErrorCode::SessionInvalid);
}

#[test]
fn repair_session_gate_requires_canonical_uuids_and_exact_claims() {
    let uppercase_id = SESSION_ID.to_uppercase();
    assert_ne!(
        uppercase_id, SESSION_ID,
        "fixture must exercise UUID casing"
    );
    let uppercase_session = complete_session_blob().replace(SESSION_ID, &uppercase_id);
    let non_canonical = resolve_repair_session(
        Some(&uppercase_session),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect_err("non-canonical UUID text must not become a header claim");
    assert_eq!(non_canonical.code(), RepairSessionErrorCode::SessionInvalid);

    let claim_mismatch = resolve_repair_session(
        Some(&complete_session_blob()),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect_err("claimed and stored sessions must match");
    assert_eq!(
        claim_mismatch.code(),
        RepairSessionErrorCode::SessionMismatch
    );

    let envelope_mismatch = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect_err("envelope and stored sessions must match");
    assert_eq!(
        envelope_mismatch.code(),
        RepairSessionErrorCode::SessionMismatch
    );
}

#[test]
fn repair_session_gate_cross_checks_native_tenant_scope() {
    let wrong_branch = NativeRepairScope {
        branch_id: "55555555-5555-4555-8555-555555555555".to_string(),
        ..native_scope()
    };
    let branch_error = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &wrong_branch,
    )
    .expect_err("stored branch must match native branch");
    assert_eq!(branch_error.code(), RepairSessionErrorCode::ScopeMismatch);

    let item_org_error = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        "66666666-6666-4666-8666-666666666666",
        &native_scope(),
    )
    .expect_err("queue organization must match the native session");
    assert_eq!(item_org_error.code(), RepairSessionErrorCode::ScopeMismatch);
}

#[test]
fn repair_session_gate_returns_only_the_validated_native_header_claim() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("complete canonical native session should pass");

    assert_eq!(session.staff_session_id(), SESSION_ID);
    assert_eq!(session.staff_id(), STAFF_ID);
    assert_eq!(session.organization_id(), ORGANIZATION_ID);
    assert_eq!(session.branch_id(), BRANCH_ID);
    assert_eq!(session.terminal_id(), TERMINAL_ID);
}

#[test]
fn repair_debug_surfaces_redact_sessions_and_projected_customer_data() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated repair session");
    let session_debug = format!("{session:?}");
    for forbidden in [
        SESSION_ID,
        STAFF_ID,
        BRANCH_ID,
        ORGANIZATION_ID,
        TERMINAL_ID,
    ] {
        assert!(!session_debug.contains(forbidden));
    }

    let sentinel = "PRIVATE_FILENAME_CAPTION_BYTES_OR_CUSTOMER_NAME";
    let disposition = RepairJsonDisposition::Success {
        status: 200,
        data: serde_json::json!({
            "filename": sentinel,
            "caption": sentinel,
            "bytes": sentinel,
            "customer_name": sentinel,
            "staff_session_id": SESSION_ID
        }),
    };
    let disposition_debug = format!("{disposition:?}");
    assert!(!disposition_debug.contains(sentinel));
    assert!(!disposition_debug.contains(SESSION_ID));

    let raw_body_sentinel = "PRIVATE-RAW-HTTP-BODY-MUST-NOT-ECHO";
    let response = BoundedRepairHttpResponse {
        status: 422,
        retry_after: Some("120".to_string()),
        body: raw_body_sentinel.as_bytes().to_vec(),
        exceeded_limit: false,
    };
    let response_debug = format!("{response:?}");
    assert!(!response_debug.contains(raw_body_sentinel));
    assert!(response_debug.contains(&raw_body_sentinel.len().to_string()));
}

#[test]
fn repair_attachment_plaintext_seam_zeroizes_owned_metadata_and_bytes() {
    let bytes = b"sensitive-decrypted-attachment-bytes".to_vec();
    let mut metadata = attachment_metadata(&bytes);
    metadata.filename = "private-customer-device-photo.png".to_string();
    metadata.caption = Some("private diagnostic caption".to_string());
    metadata.zeroize();

    assert!(metadata.attachment_id.is_empty());
    assert!(metadata.operation_id.is_empty());
    assert!(metadata.staff_session_id.is_empty());
    assert_eq!(metadata.expected_version, 0);
    assert!(metadata.occurred_at.is_empty());
    assert!(metadata.attachment_type.is_empty());
    assert!(metadata.filename.is_empty());
    assert!(metadata.caption.is_none());
    assert!(metadata.mime_type.is_empty());
    assert_eq!(metadata.byte_size, 0);
    assert!(metadata.sha256_hex.is_empty());

    let mut upload = RepairRawAttachmentUpload {
        repair_id: REPAIR_ID.to_string(),
        metadata: attachment_metadata(&bytes),
        bytes: Zeroizing::new(bytes),
    };
    upload.zeroize();
    assert!(upload.repair_id.is_empty());
    assert!(upload.metadata.filename.is_empty());
    assert!(upload.metadata.caption.is_none());
    assert!(upload.bytes.is_empty());
}

#[test]
fn repair_sync_response_accepts_one_strict_success_signal() {
    let body = serde_json::json!({
        "results": [{
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID,
            "ok": true,
            "status": 200,
            "replayed": false,
            "signal": {
                "repair_id": REPAIR_ID,
                "status": "repairing",
                "version": 5,
                "display_number": "R-ATH-26-000001",
                "provisional_alias": "R-OFF-A1B2-000001"
            }
        }]
    })
    .to_string();

    let disposition =
        classify_repair_sync_response(200, body.as_bytes(), &expected_sync_identity());
    let RepairSyncDisposition::Success(signal) = disposition else {
        panic!("expected a bounded success signal, got {disposition:?}");
    };
    assert_eq!(signal.repair_id, REPAIR_ID);
    assert_eq!(signal.status.as_str(), "repairing");
    assert_eq!(signal.version, 5);
    assert_eq!(signal.display_number.as_deref(), Some("R-ATH-26-000001"));
    assert_eq!(
        signal.provisional_alias.as_deref(),
        Some("R-OFF-A1B2-000001")
    );

    for stale_version in [3, 2] {
        let mut stale: serde_json::Value = serde_json::from_str(&body).expect("success fixture");
        stale["results"][0]["signal"]["version"] = serde_json::json!(stale_version);
        assert_eq!(
            classify_repair_sync_response(
                200,
                stale.to_string().as_bytes(),
                &expected_sync_identity(),
            ),
            RepairSyncDisposition::MalformedResponse
        );
    }
}

#[test]
fn repair_sync_response_projects_only_a_complete_safe_version_conflict() {
    let body = serde_json::json!({
        "results": [{
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID,
            "ok": false,
            "status": 409,
            "error": {
                "code": "REPAIR_VERSION_CONFLICT",
                "message": "Repair was updated by another terminal",
                "current_version": 4,
                "allowed_transitions": ["repairing", "quality_check"],
                "summary": {
                    "display_number": "R-ATH-26-000001",
                    "status": "repairing",
                    "version": 4,
                    "updated_at": "2026-08-26T10:00:00.000Z"
                }
            }
        }]
    })
    .to_string();

    let disposition =
        classify_repair_sync_response(200, body.as_bytes(), &expected_sync_identity());
    let RepairSyncDisposition::Conflict(conflict) = disposition else {
        panic!("expected a bounded conflict, got {disposition:?}");
    };
    assert_eq!(conflict.operation_id, OPERATION_ID);
    assert_eq!(conflict.repair_id, REPAIR_ID);
    assert_eq!(conflict.expected_version, 3);
    assert_eq!(conflict.current_version, 4);
    assert_eq!(
        conflict.allowed_transitions,
        vec!["repairing".to_string(), "quality_check".to_string()]
    );
    assert_eq!(conflict.summary.version, conflict.current_version);

    let mut oversized_version: serde_json::Value =
        serde_json::from_str(&body).expect("conflict fixture");
    oversized_version["results"][0]["error"]["current_version"] =
        serde_json::json!(9_007_199_254_740_992_u64);
    oversized_version["results"][0]["error"]["summary"]["version"] =
        serde_json::json!(9_007_199_254_740_992_u64);
    assert_eq!(
        classify_repair_sync_response(
            200,
            oversized_version.to_string().as_bytes(),
            &expected_sync_identity(),
        ),
        RepairSyncDisposition::MalformedResponse
    );
}

#[test]
fn repair_sync_response_rejects_unknown_fields_and_identity_mismatches() {
    let unknown_field = serde_json::json!({
        "results": [{
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID,
            "ok": true,
            "status": 200,
            "signal": {
                "repair_id": REPAIR_ID,
                "status": "repairing",
                "version": 4,
                "display_number": null,
                "provisional_alias": null,
                "diagnosis": "must never cross the bounded signal"
            }
        }]
    })
    .to_string();
    assert_eq!(
        classify_repair_sync_response(200, unknown_field.as_bytes(), &expected_sync_identity(),),
        RepairSyncDisposition::MalformedResponse
    );

    let wrong_identity = serde_json::json!({
        "results": [{
            "operation_id": "99999999-9999-4999-8999-999999999999",
            "repair_id": REPAIR_ID,
            "ok": true,
            "status": 200,
            "signal": {
                "repair_id": REPAIR_ID,
                "status": "repairing",
                "version": 4,
                "display_number": null,
                "provisional_alias": null
            }
        }]
    })
    .to_string();
    assert_eq!(
        classify_repair_sync_response(200, wrong_identity.as_bytes(), &expected_sync_identity(),),
        RepairSyncDisposition::MalformedResponse
    );
}

#[test]
fn repair_sync_response_rejects_empty_multiple_and_oversized_bodies_without_echo() {
    for body in [r#"{"results":[]}"#, r#"{"results":[{},{}]}"#] {
        assert_eq!(
            classify_repair_sync_response(200, body.as_bytes(), &expected_sync_identity()),
            RepairSyncDisposition::MalformedResponse
        );
    }

    let sensitive_sentinel = "PRIVATE-DIAGNOSIS-MUST-NOT-ECHO";
    let mut oversized = vec![b'x'; MAX_REPAIR_RESPONSE_BYTES + 1];
    oversized[..sensitive_sentinel.len()].copy_from_slice(sensitive_sentinel.as_bytes());
    let disposition = classify_repair_sync_response(200, &oversized, &expected_sync_identity());
    assert_eq!(disposition, RepairSyncDisposition::MalformedResponse);
    assert!(!format!("{disposition:?}").contains(sensitive_sentinel));
}

fn one_error_result(status: u16, code: &str) -> Vec<u8> {
    serde_json::json!({
        "results": [{
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID,
            "ok": false,
            "status": status,
            "error": { "code": code, "message": "bounded operator-safe message" }
        }]
    })
    .to_string()
    .into_bytes()
}

#[test]
fn repair_http_classifier_parks_session_and_module_results_without_raw_payloads() {
    for (status, code) in [
        (403, "STAFF_SESSION_REQUIRED"),
        (403, "STAFF_SESSION_INVALID"),
        (403, "STAFF_SESSION_MISMATCH"),
        (409, "REPAIR_EXPIRED_SESSION"),
    ] {
        let disposition = classify_repair_http_response(
            200,
            &one_error_result(status, code),
            None,
            &expected_sync_identity(),
        );
        assert!(
            matches!(disposition, RepairSyncDisposition::SessionRequired(_)),
            "{code} must park for sign-in, got {disposition:?}"
        );
    }

    let module = classify_repair_http_response(
        200,
        &one_error_result(403, "MODULE_REQUIRED"),
        None,
        &expected_sync_identity(),
    );
    assert!(matches!(module, RepairSyncDisposition::ModuleRequired(_)));

    let top_level_session = br#"{"code":"STAFF_SESSION_INVALID","message":"Sign in again"}"#;
    assert!(matches!(
        classify_repair_http_response(403, top_level_session, None, &expected_sync_identity(),),
        RepairSyncDisposition::SessionRequired(_)
    ));

    let strict_terminal_required =
        br#"{"code":"POS_TERMINAL_REQUIRED","message":"Strict terminal context required"}"#;
    assert!(matches!(
        classify_repair_http_response(
            403,
            strict_terminal_required,
            None,
            &expected_sync_identity(),
        ),
        RepairSyncDisposition::SessionRequired(ref error)
            if error.code == "POS_TERMINAL_REQUIRED"
    ));

    let top_level_module =
        br#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["repairs"]}"#;
    assert!(matches!(
        classify_repair_http_response(403, top_level_module, None, &expected_sync_identity(),),
        RepairSyncDisposition::ModuleRequired(_)
    ));

    for invalid_module_gate in [
        br#"{"error":"MODULE_REQUIRED","missingModules":["repairs"]}"#.as_slice(),
        br#"{"success":true,"error":"MODULE_REQUIRED","missingModules":["repairs"]}"#.as_slice(),
        br#"{"success":false,"error":"MODULE_REQUIRED","missingModules":[]}"#.as_slice(),
        br#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["orders"]}"#.as_slice(),
        br#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["repairs","orders"]}"#
            .as_slice(),
    ] {
        assert_eq!(
            classify_repair_http_response(
                403,
                invalid_module_gate,
                None,
                &expected_sync_identity(),
            ),
            RepairSyncDisposition::MalformedResponse
        );
    }
}

#[test]
fn repair_http_classifier_distinguishes_rate_permanent_and_retryable_failures() {
    let rate_limited = classify_repair_http_response(
        200,
        &one_error_result(429, "REPAIR_RATE_LIMITED"),
        Some("120"),
        &expected_sync_identity(),
    );
    assert_eq!(
        rate_limited,
        RepairSyncDisposition::RateLimited {
            retry_after_seconds: 120
        }
    );

    let bounded_transport_rate =
        classify_repair_http_response(429, b"", Some("999999999"), &expected_sync_identity());
    assert_eq!(
        bounded_transport_rate,
        RepairSyncDisposition::RateLimited {
            retry_after_seconds: MAX_REPAIR_RETRY_AFTER_SECONDS
        }
    );

    assert!(matches!(
        classify_repair_http_response(
            200,
            &one_error_result(422, "REPAIR_COMMAND_INVALID"),
            None,
            &expected_sync_identity(),
        ),
        RepairSyncDisposition::PermanentFailure(_)
    ));
    assert!(matches!(
        classify_repair_http_response(
            200,
            &one_error_result(503, "REPAIR_SERVICE_UNAVAILABLE"),
            None,
            &expected_sync_identity(),
        ),
        RepairSyncDisposition::RetryableFailure(_)
    ));
    assert!(matches!(
        classify_repair_http_response(503, b"", None, &expected_sync_identity(),),
        RepairSyncDisposition::RetryableFailure(_)
    ));
}

#[test]
fn repair_http_classifier_requires_strict_bounded_top_level_errors() {
    let valid = br#"{"code":"REPAIR_PERMISSION_DENIED","message":"Not allowed"}"#;
    assert!(matches!(
        classify_repair_http_response(403, valid, None, &expected_sync_identity()),
        RepairSyncDisposition::PermanentFailure(_)
    ));

    for malformed in [
        br#"{}"#.as_slice(),
        br#"{"code":"REPAIR_PERMISSION_DENIED","private_note":"leak"}"#.as_slice(),
        br#"{"code":"lowercase_code"}"#.as_slice(),
    ] {
        assert_eq!(
            classify_repair_http_response(403, malformed, None, &expected_sync_identity()),
            RepairSyncDisposition::MalformedResponse
        );
    }
}

#[test]
fn repair_transport_preserves_allowlisted_pos_auth_without_response_text_or_ids() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated auth response session");
    let prepared = prepare_repair_json_request(&session, &RepairJsonRequest::Settings)
        .expect("settings request");
    let auth_cases = [
        (
            "missing_terminal_id",
            ParityTerminalAuthCode::MissingTerminalId,
            None,
        ),
        (
            "terminal_not_found",
            ParityTerminalAuthCode::TerminalNotFound,
            None,
        ),
        (
            "terminal_lookup_error",
            ParityTerminalAuthCode::TerminalLookupError,
            None,
        ),
        (
            "terminal_inactive",
            ParityTerminalAuthCode::TerminalInactive,
            Some(false),
        ),
        (
            "organization_inactive",
            ParityTerminalAuthCode::OrganizationInactive,
            Some(false),
        ),
        (
            "organization_lookup_error",
            ParityTerminalAuthCode::OrganizationLookupError,
            None,
        ),
        (
            "organization_pending_deletion",
            ParityTerminalAuthCode::OrganizationPendingDeletion,
            Some(false),
        ),
        (
            "invalid_terminal_api_key",
            ParityTerminalAuthCode::InvalidTerminalApiKey,
            Some(true),
        ),
        (
            "terminal_identity_mismatch",
            ParityTerminalAuthCode::TerminalIdentityMismatch,
            Some(true),
        ),
        (
            "authentication_error",
            ParityTerminalAuthCode::AuthenticationError,
            None,
        ),
        ("unauthorized", ParityTerminalAuthCode::Unauthorized, None),
        (
            "per_terminal_auth_required",
            ParityTerminalAuthCode::PerTerminalAuthRequired,
            None,
        ),
    ];
    let sensitive_error = "PRIVATE-PROVIDER-TEXT-MUST-NOT-CROSS-NATIVE";
    let sensitive_terminal_id = "terminal-private-identifier-must-not-cross-native";
    for (wire_code, expected_code, terminal_active) in auth_cases {
        let body = serde_json::json!({
            "success": false,
            "error": sensitive_error,
            "code": wire_code,
            "authSource": "db",
            "terminalActive": terminal_active,
            "terminalId": sensitive_terminal_id
        });
        let serialized = body.to_string();
        let disposition = classify_repair_http_response(
            401,
            serialized.as_bytes(),
            None,
            &expected_sync_identity(),
        );
        assert!(matches!(
            disposition,
            RepairSyncDisposition::TerminalAuth(ref failure)
                if failure.code == expected_code
                    && failure.terminal_active == terminal_active
        ));
        assert_eq!(
            expected_code.is_hard(),
            matches!(
                expected_code,
                ParityTerminalAuthCode::TerminalInactive
                    | ParityTerminalAuthCode::InvalidTerminalApiKey
            ),
            "only the two approved terminal-auth codes may enter reset"
        );
        let debug = format!("{disposition:?}");
        assert!(!debug.contains(sensitive_error));
        assert!(!debug.contains(sensitive_terminal_id));
        assert!(matches!(
            classify_repair_json_response_body(401, serialized.as_bytes(), None, &prepared),
            RepairJsonDisposition::SessionRequired { ref error }
                if error.code == "POS_TERMINAL_AUTH_REQUIRED" && error.message.is_none()
        ));
    }

    let module = br#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["repairs"]}"#;
    assert!(matches!(
        classify_repair_json_response_body(403, module, None, &prepared),
        RepairJsonDisposition::ModuleRequired { .. }
    ));

    for malformed in [
        serde_json::json!({
            "success": true,
            "error": "Terminal is inactive",
            "code": "terminal_inactive"
        }),
        serde_json::json!({
            "success": false,
            "error": "Terminal is inactive",
            "code": "not_a_real_pos_auth_code"
        }),
        serde_json::json!({
            "success": false,
            "error": "Terminal is inactive",
            "code": "terminal_inactive",
            "authSource": "attacker"
        }),
        serde_json::json!({
            "success": false,
            "error": "Terminal is inactive",
            "code": "terminal_inactive",
            "privateNote": "must not cross native boundary"
        }),
    ] {
        assert_eq!(
            classify_repair_json_response_body(
                401,
                malformed.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse
        );
    }
}

#[derive(Default)]
struct RecordingRepairHooks {
    events: Mutex<Vec<String>>,
    attachment_upload: Mutex<Option<RepairRawAttachmentUpload>>,
    fail_reconciliation: bool,
    fail_attachment_reconciliation: bool,
    fail_conflict: bool,
    invalidate_generation_before_dispatch: bool,
}

impl RepairQueueHooks for RecordingRepairHooks {
    fn decode_attachment_upload(
        &self,
        _connection: &Connection,
        _item: &SyncQueueItem,
    ) -> Result<RepairRawAttachmentUpload, RepairHookError> {
        self.events
            .lock()
            .expect("lock hook events")
            .push("decode_attachment".to_string());
        self.attachment_upload
            .lock()
            .expect("lock staged attachment")
            .take()
            .ok_or_else(|| RepairHookError::unavailable("TEST_ATTACHMENT_DECODER_UNAVAILABLE"))
    }

    fn decode_command_envelope(
        &self,
        _connection: &Connection,
        item: &SyncQueueItem,
    ) -> Result<Zeroizing<String>, RepairHookError> {
        Ok(Zeroizing::new(item.data.clone()))
    }

    fn before_dispatch(
        &self,
        _connection: &Connection,
        context: &RepairQueueContext,
    ) -> Result<(), RepairHookError> {
        self.events
            .lock()
            .expect("lock hook events")
            .push(format!("before:{}", context.operation_id));
        if self.invalidate_generation_before_dispatch {
            _connection
                .execute(
                    "UPDATE parity_sync_queue
                     SET claim_generation = claim_generation + 1
                     WHERE id = ?1",
                    [&context.queue_id],
                )
                .expect("simulate stale repair claim");
        }
        Ok(())
    }

    fn validate_command_envelope(
        &self,
        _connection: &Connection,
        _context: &RepairQueueContext,
        _decoded_envelope: &str,
    ) -> Result<(), RepairHookError> {
        Ok(())
    }

    fn reconcile_success(
        &self,
        _connection: &Connection,
        context: &RepairQueueContext,
        signal: &RepairSyncSuccessSignal,
    ) -> Result<(), RepairHookError> {
        self.events.lock().expect("lock hook events").push(format!(
            "reconcile:{}:{}",
            context.operation_id, signal.version
        ));
        if self.fail_reconciliation {
            Err(RepairHookError::retryable("TEST_RECONCILIATION_FAILED"))
        } else {
            Ok(())
        }
    }

    fn reconcile_attachment_success(
        &self,
        connection: &Connection,
        context: &RepairQueueContext,
        result: &RepairAttachmentUploadResult,
    ) -> Result<(), RepairHookError> {
        let queue_status: String = connection
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                [&context.queue_id],
                |row| row.get(0),
            )
            .expect("attachment reconciliation runs before queue deletion");
        self.events.lock().expect("lock hook events").push(format!(
            "attachment_reconcile:{}:{}:{}",
            context.operation_id, result.version, queue_status
        ));
        if self.fail_attachment_reconciliation {
            Err(RepairHookError::retryable(
                "TEST_ATTACHMENT_RECONCILIATION_FAILED",
            ))
        } else {
            Ok(())
        }
    }

    fn park_conflict(
        &self,
        _connection: &Connection,
        context: &RepairQueueContext,
        conflict: &RepairConflictProjection,
    ) -> Result<(), RepairHookError> {
        let queue_status: String = _connection
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                [&context.queue_id],
                |row| row.get(0),
            )
            .expect("conflict hook runs while queue row still exists");
        self.events.lock().expect("lock hook events").push(format!(
            "conflict:{}:{}:{}",
            context.operation_id, conflict.current_version, queue_status
        ));
        if self.fail_conflict {
            Err(RepairHookError::retryable("TEST_CONFLICT_PARK_FAILED"))
        } else {
            Ok(())
        }
    }
}

fn repair_envelope() -> String {
    serde_json::json!({
        "operation_id": OPERATION_ID,
        "repair_id": REPAIR_ID,
        "expected_version": 3,
        "staff_session_id": SESSION_ID,
        "command": "add_note",
        "payload": { "note": "internal note", "visibility": "internal" },
        "occurred_at": "2026-08-26T10:00:00.000Z"
    })
    .to_string()
}

fn create_repair_transport_queue_tables(connection: &Connection) {
    create_tables(connection).expect("create parity queue tables");
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS orders (
                 id TEXT PRIMARY KEY,
                 supabase_id TEXT,
                 order_context TEXT
             );
             CREATE TABLE IF NOT EXISTS order_payments (
                 id TEXT PRIMARY KEY,
                 order_id TEXT
             );
             CREATE TABLE IF NOT EXISTS payment_adjustments (
                 id TEXT PRIMARY KEY,
                 order_id TEXT,
                 payment_id TEXT
             );
             CREATE TABLE IF NOT EXISTS repair_attachment_staging (
                 organization_id TEXT NOT NULL,
                 branch_id TEXT NOT NULL,
                 terminal_id TEXT NOT NULL,
                 attachment_id TEXT NOT NULL,
                 repair_id TEXT NOT NULL,
                 operation_id TEXT NOT NULL,
                 queue_id TEXT NOT NULL,
                 expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
                 scope_generation INTEGER NOT NULL CHECK (scope_generation > 0),
                 file_key TEXT NOT NULL,
                 metadata_nonce BLOB NOT NULL CHECK (length(metadata_nonce) = 12),
                 metadata_ciphertext BLOB NOT NULL CHECK (length(metadata_ciphertext) >= 16),
                 sha256_hex TEXT NOT NULL CHECK (length(sha256_hex) = 64),
                 mime_type TEXT NOT NULL,
                 size_bytes INTEGER NOT NULL CHECK (
                     size_bytes > 0 AND size_bytes <= 15728640
                 ),
                 state TEXT NOT NULL CHECK (
                     state IN ('queued', 'conflict', 'confirmed', 'cleanup_failed')
                 ),
                 server_version INTEGER,
                 cleanup_error_code TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY (organization_id, branch_id, terminal_id, attachment_id),
                 UNIQUE (organization_id, branch_id, terminal_id, operation_id),
                 UNIQUE (organization_id, branch_id, terminal_id, queue_id),
                 CHECK (queue_id = operation_id),
                 CHECK (
                     (state IN ('queued', 'conflict') AND server_version IS NULL)
                     OR (state IN ('confirmed', 'cleanup_failed') AND server_version > 0)
                 ),
                 CHECK (
                     (state = 'cleanup_failed' AND cleanup_error_code IS NOT NULL)
                     OR (state <> 'cleanup_failed' AND cleanup_error_code IS NULL)
                 )
             );",
        )
        .expect("create repair queue dependency fixture tables");
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_repair_attachment_staging_repair
               ON repair_attachment_staging (
                   organization_id, branch_id, terminal_id, repair_id, expected_version
               );
             CREATE INDEX IF NOT EXISTS idx_repair_attachment_cleanup
               ON repair_attachment_staging (state, updated_at)
               WHERE state IN ('confirmed', 'cleanup_failed');",
        )
        .expect("create repair attachment staging fixture indexes");
}

fn insert_repair_transport_queue_row(
    connection: &Connection,
    queue_id: &str,
    table_name: &str,
    record_id: &str,
    data: &str,
    version: i64,
) -> String {
    create_repair_transport_queue_tables(connection);
    connection
        .execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, repair_aggregate_id, status
             ) VALUES (?1, ?2, ?3, 'INSERT', ?4, ?5,
                       '2026-08-26T10:00:00Z', 0, 1000, 50, 'repairs',
                       'manual', ?6, ?7, 'pending')",
            rusqlite::params![
                queue_id,
                table_name,
                record_id,
                data,
                ORGANIZATION_ID,
                version,
                REPAIR_ID,
            ],
        )
        .expect("insert native-owned repair transport queue fixture");
    if table_name == "repair_attachments" {
        connection
            .execute(
                "INSERT INTO repair_attachment_staging (
                     organization_id, branch_id, terminal_id, attachment_id,
                     repair_id, operation_id, queue_id, expected_version,
                     scope_generation, file_key, metadata_nonce,
                     metadata_ciphertext, sha256_hex, mime_type, size_bytes,
                     state, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, 1,
                           'transport-fixture.part', zeroblob(12), zeroblob(16),
                           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                           'image/png', 1, 'queued',
                           '2026-08-26T10:00:00Z', '2026-08-26T10:00:00Z')",
                rusqlite::params![
                    ORGANIZATION_ID,
                    BRANCH_ID,
                    TERMINAL_ID,
                    record_id,
                    REPAIR_ID,
                    queue_id,
                    version,
                ],
            )
            .expect("insert repair attachment staging binding fixture");
    }
    queue_id.to_string()
}

fn seed_unbound_repair_queue(connection: &Connection, envelope: String) -> String {
    insert_repair_transport_queue_row(
        connection,
        UNBOUND_QUEUE_ID,
        "repairs",
        REPAIR_ID,
        &envelope,
        3,
    )
}

fn seed_repair_queue(connection: &Connection, envelope: String) -> String {
    insert_repair_transport_queue_row(connection, OPERATION_ID, "repairs", REPAIR_ID, &envelope, 3)
}

fn seed_unbound_repair_attachment_queue(
    connection: &Connection,
    upload: &RepairRawAttachmentUpload,
) -> String {
    insert_repair_transport_queue_row(
        connection,
        UNBOUND_QUEUE_ID,
        "repair_attachments",
        &upload.metadata.attachment_id,
        "[encrypted staged attachment]",
        i64::try_from(upload.metadata.expected_version).expect("attachment version"),
    )
}

fn seed_repair_attachment_queue(
    connection: &Connection,
    upload: &RepairRawAttachmentUpload,
) -> String {
    insert_repair_transport_queue_row(
        connection,
        &upload.metadata.operation_id,
        "repair_attachments",
        &upload.metadata.attachment_id,
        "[encrypted staged attachment]",
        i64::try_from(upload.metadata.expected_version).expect("attachment version"),
    )
}

fn repair_actor_attestation() -> serde_json::Value {
    let now = chrono::Utc::now();
    let issued_at = now - chrono::Duration::minutes(1);
    let offline_expires_at = now + chrono::Duration::hours(1);
    let session_expires_at = now + chrono::Duration::hours(2);
    let mut permissions = REPAIR_PERMISSIONS
        .iter()
        .map(|permission| (*permission).to_string())
        .collect::<Vec<_>>();
    permissions.sort();
    serde_json::json!({
        "version": 1,
        "organization_id": ORGANIZATION_ID,
        "branch_id": BRANCH_ID,
        "terminal_public_id": TERMINAL_ID,
        "staff_id": STAFF_ID,
        "staff_session_id": SESSION_ID,
        "issued_at": issued_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "session_expires_at": session_expires_at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "offline_expires_at": offline_expires_at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "permissions": permissions,
    })
}

fn repair_scope_blob() -> String {
    serde_json::json!({
        "version": 1,
        "organization_id": ORGANIZATION_ID,
        "branch_id": BRANCH_ID,
        "terminal_id": TERMINAL_ID,
        "scope_token": REPAIR_SCOPE_TOKEN,
        "scope_epoch": 1,
        "transition_pending": false,
        "reset_pending": false,
        "offline_terminal_token": null,
        "offline_sequence_lease_start": null,
        "offline_sequence_lease_end": null,
    })
    .to_string()
}

fn repair_entitlement_blob() -> String {
    serde_json::json!({
        "version": 1,
        "organization_id": ORGANIZATION_ID,
        "branch_id": BRANCH_ID,
        "terminal_id": TERMINAL_ID,
        "scope_epoch": 1,
        "enabled": true,
        "verified_at": "2026-08-26T10:00:00.000Z",
    })
    .to_string()
}

struct RepairTransportFixtureGuard {
    _keyring: fake_keyring::Guard,
    _lifecycle: crate::repairs::RepairLifecycleTestIsolation,
}

fn install_repair_identity() -> RepairTransportFixtureGuard {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let keyring = fake_keyring::install_seeded([
        ("pos_session", complete_session_blob()),
        ("terminal_id", TERMINAL_ID.to_string()),
        ("branch_id", BRANCH_ID.to_string()),
        ("organization_id", ORGANIZATION_ID.to_string()),
        (crate::storage::KEY_REPAIR_SCOPE_V1, repair_scope_blob()),
        (
            crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
            repair_entitlement_blob(),
        ),
        (
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            repair_actor_attestation().to_string(),
        ),
    ]);
    RepairTransportFixtureGuard {
        _keyring: keyring,
        _lifecycle: lifecycle,
    }
}

fn install_repair_scope_without_session() -> RepairTransportFixtureGuard {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let keyring = fake_keyring::install_seeded([
        ("terminal_id", TERMINAL_ID.to_string()),
        ("branch_id", BRANCH_ID.to_string()),
        ("organization_id", ORGANIZATION_ID.to_string()),
        (crate::storage::KEY_REPAIR_SCOPE_V1, repair_scope_blob()),
        (
            crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
            repair_entitlement_blob(),
        ),
    ]);
    RepairTransportFixtureGuard {
        _keyring: keyring,
        _lifecycle: lifecycle,
    }
}

fn install_empty_repair_keyring() -> RepairTransportFixtureGuard {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let keyring = fake_keyring::install_empty();
    RepairTransportFixtureGuard {
        _keyring: keyring,
        _lifecycle: lifecycle,
    }
}

fn success_response() -> String {
    serde_json::json!({
        "results": [{
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID,
            "ok": true,
            "status": 200,
            "signal": {
                "repair_id": REPAIR_ID,
                "status": "repairing",
                "version": 4,
                "display_number": "R-ATH-26-000001",
                "provisional_alias": "R-OFF-A1B2-000001"
            }
        }]
    })
    .to_string()
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_sends_one_native_staff_header_and_reconciles_before_delete() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let server = MockServer::new(success_response());
    let hooks = RecordingRepairHooks::default();

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("process repair queue");

    thread::sleep(Duration::from_millis(100));
    let requests = server.recorded();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/api/pos/repairs/sync");
    assert_eq!(requests[0].header("x-staff-session-id"), Some(SESSION_ID));
    assert_eq!(requests[0].header("x-terminal-id"), Some(TERMINAL_ID));
    assert_eq!(
        requests[0]
            .json_body()
            .and_then(|body| body.pointer("/items/0/operation_id").cloned())
            .and_then(|value| value.as_str().map(str::to_string))
            .as_deref(),
        Some(OPERATION_ID)
    );
    assert_eq!(result.processed, 1);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        [
            format!("before:{OPERATION_ID}"),
            format!("reconcile:{OPERATION_ID}:4")
        ]
    );
    let row_exists = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT 1 FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |_| Ok(()),
        )
        .optional()
        .expect("query queue row")
        .is_some();
    assert!(
        !row_exists,
        "row may delete only after reconciliation succeeds"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_retains_success_when_reconciliation_hook_fails() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let server = MockServer::new(success_response());
    let hooks = RecordingRepairHooks {
        fail_reconciliation: true,
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("failed reconciliation is a typed retry outcome");

    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 1);
    let (status, attempts): (String, i64) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("reconciliation failure must retain row");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_stale_generation_never_calls_reconciliation_or_deletes() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let server = MockServer::new(success_response());
    let hooks = RecordingRepairHooks {
        invalidate_generation_before_dispatch: true,
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("stale success is ignored safely");

    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 0);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        [format!("before:{OPERATION_ID}")],
        "generation guard must run before reconciliation"
    );
    let status: String = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| row.get(0),
        )
        .expect("stale worker must not delete the row");
    assert_eq!(status, "processing");
}

fn conflict_response() -> String {
    serde_json::json!({
        "results": [{
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID,
            "ok": false,
            "status": 409,
            "error": {
                "code": "REPAIR_VERSION_CONFLICT",
                "current_version": 4,
                "allowed_transitions": ["repairing", "quality_check"],
                "summary": {
                    "display_number": "R-ATH-26-000001",
                    "status": "repairing",
                    "version": 4,
                    "updated_at": "2026-08-26T10:00:00.000Z"
                }
            }
        }]
    })
    .to_string()
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_parks_valid_conflict_only_after_conflict_hook() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let server = MockServer::new(conflict_response());
    let hooks = RecordingRepairHooks::default();

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("process repair conflict");

    assert_eq!(result.conflicts, 1);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        [
            format!("before:{OPERATION_ID}"),
            format!("conflict:{OPERATION_ID}:4:processing")
        ]
    );
    let status: String = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| row.get(0),
        )
        .expect("conflict row remains parked");
    assert_eq!(status, "conflict");
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_conflict_hook_failure_keeps_row_retryable() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let server = MockServer::new(conflict_response());
    let hooks = RecordingRepairHooks {
        fail_conflict: true,
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("hook failure becomes retryable");

    assert_eq!(result.conflicts, 0);
    assert_eq!(result.failed, 1);
    let (status, attempts): (String, i64) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("failed conflict hook must retain row");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_missing_session_performs_no_hook_or_network_request() {
    let _keyring = install_repair_scope_without_session();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let server = MockServer::new(success_response());
    let hooks = RecordingRepairHooks::default();

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("missing staff session parks safely");

    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0, "session failure must happen before HTTP");
    assert!(
        hooks.events.lock().expect("lock hook events").is_empty(),
        "dependency/cache hooks must not run for an unauthenticated repair"
    );
    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 0);
    let (status, attempts): (String, i64) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("missing-session row remains parked");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 0, "sign-in prerequisite must not burn attempts");
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_actor_keyring_failure_is_unavailable_and_performs_no_request() {
    let _keyring = install_repair_identity();
    fake_keyring::fail_reads_for(
        crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        "KEYRING_READ_FAILED",
    );
    let connection = Connection::open_in_memory().expect("open sqlite");
    create_repair_transport_queue_tables(&connection);
    connection
        .execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, repair_aggregate_id, status
             ) VALUES (?1, 'repairs', ?2, 'INSERT', ?3, ?4,
                       '2026-08-26T10:00:00Z', 0, 1000, 50, 'repairs',
                       'manual', 3, ?2, 'pending')",
            rusqlite::params![OPERATION_ID, REPAIR_ID, repair_envelope(), ORGANIZATION_ID],
        )
        .expect("seed native-bound repair queue");
    let server = MockServer::new(success_response());
    let hooks = RecordingRepairHooks::default();
    let item = peek(&connection)
        .expect("peek repair queue")
        .expect("repair queue item");
    let error = match prepare_repair_command_request(&connection, &item, &hooks) {
        Ok(_) => panic!("keyring outage must stop request preparation"),
        Err(error) => error,
    };

    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0, "keyring failure must happen before HTTP");
    assert!(
        hooks.events.lock().expect("lock hook events").is_empty(),
        "no repair dispatch hook may run without a strict session read"
    );
    assert_eq!(error.code(), "REPAIR_ACTOR_ATTESTATION_UNAVAILABLE");
    assert_eq!(
        error.kind(),
        crate::repair_transport::RepairHookErrorKind::Unavailable
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_terminal_prerequisite_does_not_burn_attempts() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let body = serde_json::json!({
        "code": "POS_TERMINAL_REQUIRED",
        "message": "Strict terminal context required"
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(403, body);
    let hooks = RecordingRepairHooks::default();

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &url, "native-api-key", &hooks)
            .await
            .expect("strict-terminal denial is a deferred prerequisite");
    server.join().expect("join strict-terminal response server");

    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 0);
    let (status, attempts, error): (String, i64, Option<String>) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("strict-terminal prerequisite retains queue row");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 0, "terminal prerequisite must not burn attempts");
    assert_eq!(error.as_deref(), Some("POS_TERMINAL_REQUIRED"));
}

#[tokio::test(flavor = "current_thread")]
async fn repair_sync_queue_refuses_redirect_without_leaking_native_headers() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope());
    }

    let target_listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect target");
    target_listener
        .set_nonblocking(true)
        .expect("target nonblocking");
    let target_address = target_listener.local_addr().expect("target address");
    let target_requests = Arc::new(AtomicUsize::new(0));
    let leaked_request = Arc::new(Mutex::new(String::new()));
    let target_requests_thread = Arc::clone(&target_requests);
    let leaked_request_thread = Arc::clone(&leaked_request);
    let target_thread = thread::spawn(move || {
        for _ in 0..100 {
            match target_listener.accept() {
                Ok((mut stream, _)) => {
                    let mut bytes = vec![0u8; 64 * 1024];
                    let read = stream.read(&mut bytes).unwrap_or(0);
                    *leaked_request_thread.lock().expect("lock leaked request") =
                        String::from_utf8_lossy(&bytes[..read]).into_owned();
                    target_requests_thread.fetch_add(1, Ordering::SeqCst);
                    let body = success_response();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let redirect_listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect source");
    let redirect_address = redirect_listener.local_addr().expect("redirect address");
    let redirect_thread = thread::spawn(move || {
        let (mut stream, _) = redirect_listener.accept().expect("accept repair request");
        let mut bytes = vec![0u8; 64 * 1024];
        let _ = stream.read(&mut bytes);
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/credential-steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(response.as_bytes())
            .expect("write redirect");
    });

    let hooks = RecordingRepairHooks::default();
    process_queue_with_repair_hooks(
        connection.as_ref(),
        &format!("http://{redirect_address}"),
        "native-api-key",
        &hooks,
    )
    .await
    .expect("redirect response is handled as bounded malformed response");
    redirect_thread.join().expect("join redirect source");
    target_thread.join().expect("join redirect target");

    assert_eq!(
        target_requests.load(Ordering::SeqCst),
        0,
        "repair transport must never follow a redirect"
    );
    let leaked = leaked_request.lock().expect("lock leaked request");
    assert!(!leaked.to_ascii_lowercase().contains("x-pos-api-key"));
    assert!(!leaked.to_ascii_lowercase().contains("x-staff-session-id"));
}

fn attachment_metadata(bytes: &[u8]) -> RepairRawAttachmentMetadata {
    RepairRawAttachmentMetadata {
        attachment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
        operation_id: OPERATION_ID.to_string(),
        staff_session_id: SESSION_ID.to_string(),
        expected_version: 3,
        occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
        attachment_type: "diagnostic".to_string(),
        filename: "διάγνωση-οθόνη.png".to_string(),
        caption: Some("Φωτογραφία πριν την επισκευή".to_string()),
        mime_type: "image/png".to_string(),
        byte_size: u64::try_from(bytes.len()).expect("attachment size"),
        sha256_hex: format!("{:x}", Sha256::digest(bytes)),
    }
}

fn spawn_single_http_response(
    status: u16,
    response_body: String,
) -> (String, Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind response server");
    let address = listener.local_addr().expect("response server address");
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded_thread = Arc::clone(&recorded);
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set request timeout");
        let mut request = Vec::new();
        let mut chunk = [0u8; 8 * 1024];
        loop {
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        *recorded_thread.lock().expect("lock recorded request") = request;
        let reason = match status {
            201 => "Created",
            409 => "Conflict",
            _ => "OK",
        };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(), response_body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    });
    (format!("http://{address}"), recorded, handle)
}

fn split_recorded_request(request: &[u8]) -> (String, Vec<u8>) {
    let header_end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("recorded request headers");
    (
        String::from_utf8(request[..header_end].to_vec()).expect("ASCII request headers"),
        request[(header_end + 4)..].to_vec(),
    )
}

fn queued_attachment_upload() -> RepairRawAttachmentUpload {
    let bytes = b"encrypted-cache-bytes-decrypted-by-hook".to_vec();
    RepairRawAttachmentUpload {
        repair_id: REPAIR_ID.to_string(),
        metadata: attachment_metadata(&bytes),
        bytes: Zeroizing::new(bytes),
    }
}

fn copy_test_attachment_metadata(
    metadata: &RepairRawAttachmentMetadata,
) -> RepairRawAttachmentMetadata {
    RepairRawAttachmentMetadata {
        attachment_id: metadata.attachment_id.clone(),
        operation_id: metadata.operation_id.clone(),
        staff_session_id: metadata.staff_session_id.clone(),
        expected_version: metadata.expected_version,
        occurred_at: metadata.occurred_at.clone(),
        attachment_type: metadata.attachment_type.clone(),
        filename: metadata.filename.clone(),
        caption: metadata.caption.clone(),
        mime_type: metadata.mime_type.clone(),
        byte_size: metadata.byte_size,
        sha256_hex: metadata.sha256_hex.clone(),
    }
}

fn copy_test_attachment_upload(upload: &RepairRawAttachmentUpload) -> RepairRawAttachmentUpload {
    RepairRawAttachmentUpload {
        repair_id: upload.repair_id.clone(),
        metadata: copy_test_attachment_metadata(&upload.metadata),
        bytes: Zeroizing::new(upload.bytes.to_vec()),
    }
}

async fn send_repair_raw_attachment(
    base_url: &str,
    api_key: &str,
    session: &crate::repair_transport::ValidatedRepairSession,
    upload: &RepairRawAttachmentUpload,
) -> Result<RepairAttachmentDisposition, RepairHookError> {
    crate::repair_transport::send_repair_raw_attachment(
        base_url,
        api_key,
        session,
        copy_test_attachment_upload(upload),
    )
    .await
}

#[tokio::test(flavor = "current_thread")]
async fn repair_command_queue_rejects_operation_id_substitution_before_network() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_unbound_repair_queue(&guard, repair_envelope())
    };
    assert_ne!(queue_id, OPERATION_ID);
    let server = MockServer::new(success_response());
    let hooks = RecordingRepairHooks::default();

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("operation substitution fails closed");

    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
    assert_eq!(result.failed, 1);
    assert!(hooks.events.lock().expect("lock hook events").is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn repair_command_queue_rejects_negative_or_non_js_safe_versions_before_network() {
    let _keyring = install_repair_identity();
    for (row_version, envelope_version) in [
        (-1_i64, u64::MAX),
        (9_007_199_254_740_992_i64, 9_007_199_254_740_992_u64),
    ] {
        let connection = Arc::new(Mutex::new(
            Connection::open_in_memory().expect("open sqlite"),
        ));
        let mut envelope: serde_json::Value =
            serde_json::from_str(&repair_envelope()).expect("repair envelope fixture");
        envelope["expected_version"] = serde_json::json!(envelope_version);
        let queue_id = {
            let guard = connection.lock().expect("lock sqlite");
            let queue_id = seed_repair_queue(&guard, envelope.to_string());
            guard
                .execute(
                    "UPDATE parity_sync_queue SET version = ?1 WHERE id = ?2",
                    rusqlite::params![row_version, queue_id],
                )
                .expect("set adversarial row version");
            queue_id
        };
        let server = MockServer::new(success_response());
        let hooks = RecordingRepairHooks::default();
        let result = process_queue_with_repair_hooks(
            connection.as_ref(),
            &server.url,
            "native-api-key",
            &hooks,
        )
        .await
        .expect("unsafe version fails closed");
        thread::sleep(Duration::from_millis(100));
        assert_eq!(server.count(), 0);
        assert_eq!(result.failed, 0);
        assert!(hooks.events.lock().expect("lock hook events").is_empty());
        let status: String = connection
            .lock()
            .expect("lock sqlite")
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                [queue_id],
                |row| row.get(0),
            )
            .expect("unsafe version row retained");
        assert_eq!(status, "pending");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn repair_direct_transports_reject_unsafe_admin_origins_without_network() {
    let _keyring = install_repair_identity();
    let server = MockServer::new(r#"{"unexpected":true}"#);
    let local_userinfo_origin = server.url.replacen("http://", "http://attacker@", 1);
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated origin test session");
    let upload = queued_attachment_upload();
    let input = RepairJsonTransportInput {
        staff_session_id: SESSION_ID.to_string(),
        request: RepairJsonRequest::Settings,
    };

    for unsafe_origin in ["http://example.com", local_userinfo_origin.as_str()] {
        let json_error = send_repair_json_request(
            unsafe_origin,
            "native-api-key",
            None,
            &native_scope(),
            &input,
        )
        .await
        .expect_err("unsafe JSON origin must fail before request");
        assert_eq!(json_error.code(), "REPAIR_API_ORIGIN_INVALID");

        let raw_error =
            send_repair_raw_attachment(unsafe_origin, "native-api-key", &session, &upload)
                .await
                .expect_err("unsafe raw origin must fail before request");
        assert_eq!(raw_error.code(), "REPAIR_API_ORIGIN_INVALID");
    }
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_queue_remote_plain_http_stays_pending_without_attempt_or_hook_mutation() {
    let _keyring = install_repair_identity();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_queue(&guard, repair_envelope())
    };
    let hooks = RecordingRepairHooks::default();
    let result = process_queue_with_repair_hooks(
        connection.as_ref(),
        "http://example.com",
        "native-api-key",
        &hooks,
    )
    .await
    .expect("unsafe native origin is a deferred prerequisite");
    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 0);
    assert!(hooks.events.lock().expect("lock hook events").is_empty());
    let (status, attempts, error): (String, i64, String) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("remote HTTP repair row retained");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 0);
    assert_eq!(error, "REPAIR_API_ORIGIN_INVALID");
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_rejects_operation_id_substitution_before_network() {
    let _keyring = install_repair_identity();
    let upload = queued_attachment_upload();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_unbound_repair_attachment_queue(&guard, &upload)
    };
    assert_ne!(queue_id, upload.metadata.operation_id);
    let server = MockServer::new(r#"{"unexpected":true}"#);
    let hooks = RecordingRepairHooks {
        attachment_upload: Mutex::new(Some(upload)),
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &server.url, "native-api-key", &hooks)
            .await
            .expect("attachment operation substitution fails closed");

    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
    assert_eq!(result.failed, 1);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        ["decode_attachment".to_string()]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_default_hook_defers_without_network_or_attempt_burn() {
    let _keyring = install_repair_identity();
    let upload = queued_attachment_upload();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_attachment_queue(&guard, &upload)
    };
    let server = MockServer::new(r#"{"unexpected":true}"#);

    let result = process_queue_with_repair_hooks(
        connection.as_ref(),
        &server.url,
        "native-api-key",
        &UnavailableRepairQueueHooks,
    )
    .await
    .expect("unavailable attachment hook defers safely");

    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 0);
    let (status, attempts, error): (String, i64, Option<String>) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("deferred attachment row remains");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 0);
    assert_eq!(
        error.as_deref(),
        Some("REPAIR_ATTACHMENT_DECODER_UNAVAILABLE")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_reconciles_authoritative_201_before_delete() {
    let _keyring = install_repair_identity();
    let upload = queued_attachment_upload();
    let expected_body = upload.bytes.to_vec();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_attachment_queue(&guard, &upload)
    };
    let response = serde_json::json!({
        "attachment_id": upload.metadata.attachment_id,
        "repair_id": upload.repair_id,
        "status": "repairing",
        "version": upload.metadata.expected_version + 1
    })
    .to_string();
    let (url, recorded, server) = spawn_single_http_response(201, response);
    let hooks = RecordingRepairHooks {
        attachment_upload: Mutex::new(Some(upload)),
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &url, "native-api-key", &hooks)
            .await
            .expect("process staged repair attachment");
    server.join().expect("join attachment queue server");

    assert_eq!(result.processed, 1);
    assert_eq!(result.failed, 0);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        [
            "decode_attachment".to_string(),
            format!("before:{OPERATION_ID}"),
            format!("attachment_reconcile:{OPERATION_ID}:4:processing")
        ]
    );
    let row_exists = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT 1 FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |_| Ok(()),
        )
        .optional()
        .expect("query attachment queue row")
        .is_some();
    assert!(
        !row_exists,
        "queue row deletes only after confirmation hook"
    );
    let request = recorded.lock().expect("lock upload request").clone();
    let (headers, body) = split_recorded_request(&request);
    assert!(headers.starts_with(&format!(
        "POST /api/pos/repairs/{REPAIR_ID}/attachments/raw HTTP/1.1"
    )));
    assert!(headers
        .to_ascii_lowercase()
        .contains(&format!("x-staff-session-id: {SESSION_ID}")));
    assert_eq!(body, expected_body);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_reconciliation_failure_retains_retryable_row() {
    let _keyring = install_repair_identity();
    let upload = queued_attachment_upload();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_attachment_queue(&guard, &upload)
    };
    let response = serde_json::json!({
        "attachment_id": upload.metadata.attachment_id,
        "repair_id": upload.repair_id,
        "status": "repairing",
        "version": upload.metadata.expected_version + 1
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(201, response);
    let hooks = RecordingRepairHooks {
        attachment_upload: Mutex::new(Some(upload)),
        fail_attachment_reconciliation: true,
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &url, "native-api-key", &hooks)
            .await
            .expect("failed attachment reconciliation is retryable");
    server.join().expect("join attachment queue server");

    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 1);
    let (status, attempts): (String, i64) = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status, attempts FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("failed reconciliation retains attachment row");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_generation_guard_precedes_reconciliation() {
    let _keyring = install_repair_identity();
    let upload = queued_attachment_upload();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_attachment_queue(&guard, &upload);
    }
    let response = serde_json::json!({
        "attachment_id": upload.metadata.attachment_id,
        "repair_id": upload.repair_id,
        "status": "repairing",
        "version": upload.metadata.expected_version + 1
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(201, response);
    let hooks = RecordingRepairHooks {
        attachment_upload: Mutex::new(Some(upload)),
        invalidate_generation_before_dispatch: true,
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &url, "native-api-key", &hooks)
            .await
            .expect("stale attachment response is ignored");
    server.join().expect("join attachment queue server");

    assert_eq!(result.processed, 0);
    assert_eq!(result.failed, 0);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        [
            "decode_attachment".to_string(),
            format!("before:{OPERATION_ID}")
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_parks_conflict_only_after_hook() {
    let _keyring = install_repair_identity();
    let upload = queued_attachment_upload();
    let connection = Arc::new(Mutex::new(
        Connection::open_in_memory().expect("open sqlite"),
    ));
    let queue_id = {
        let guard = connection.lock().expect("lock sqlite");
        seed_repair_attachment_queue(&guard, &upload)
    };
    let response = serde_json::json!({
        "code": "REPAIR_VERSION_CONFLICT",
        "message": "Repair changed",
        "operation_id": upload.metadata.operation_id,
        "repair_id": upload.repair_id,
        "expected_version": upload.metadata.expected_version,
        "current_version": upload.metadata.expected_version + 1,
        "allowed_transitions": ["repairing", "quality_check"],
        "summary": {
            "display_number": "R-ATH-26-000001",
            "status": "repairing",
            "version": upload.metadata.expected_version + 1,
            "updated_at": "2026-08-26T10:00:00.000Z"
        }
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(409, response);
    let hooks = RecordingRepairHooks {
        attachment_upload: Mutex::new(Some(upload)),
        ..RecordingRepairHooks::default()
    };

    let result =
        process_queue_with_repair_hooks(connection.as_ref(), &url, "native-api-key", &hooks)
            .await
            .expect("process attachment conflict");
    server.join().expect("join attachment conflict server");

    assert_eq!(result.conflicts, 1);
    assert_eq!(
        hooks.events.lock().expect("lock hook events").as_slice(),
        [
            "decode_attachment".to_string(),
            format!("before:{OPERATION_ID}"),
            format!("conflict:{OPERATION_ID}:4:processing")
        ]
    );
    let status: String = connection
        .lock()
        .expect("lock sqlite")
        .query_row(
            "SELECT status FROM parity_sync_queue WHERE id = ?1",
            [queue_id],
            |row| row.get(0),
        )
        .expect("attachment conflict row remains");
    assert_eq!(status, "conflict");
}

#[tokio::test(flavor = "current_thread")]
async fn repair_attachment_queue_maps_bounded_non_success_dispositions() {
    let _keyring = install_repair_identity();
    let cases = [
        (
            401,
            serde_json::json!({
                "code": "REPAIR_EXPIRED_SESSION",
                "message": "Session expired"
            })
            .to_string(),
            "pending",
            0,
            "REPAIR_EXPIRED_SESSION",
            0,
        ),
        (
            403,
            serde_json::json!({
                "success": false,
                "error": "MODULE_REQUIRED",
                "message": "Repairs module required",
                "missingModules": ["repairs"]
            })
            .to_string(),
            "pending",
            0,
            "MODULE_REQUIRED",
            0,
        ),
        (
            401,
            serde_json::json!({
                "success": false,
                "error": "Invalid terminal API key",
                "code": "invalid_terminal_api_key",
                "authSource": "db",
                "terminalActive": true,
                "terminalId": TERMINAL_ID
            })
            .to_string(),
            "pending",
            0,
            "invalid_terminal_api_key",
            0,
        ),
        (
            429,
            "rate limited".to_string(),
            "pending",
            0,
            "REPAIR_RATE_LIMITED",
            1,
        ),
        (
            422,
            serde_json::json!({
                "code": "REPAIR_ATTACHMENT_POLICY_DENIED",
                "message": "Denied"
            })
            .to_string(),
            "failed",
            1,
            "REPAIR_ATTACHMENT_POLICY_DENIED",
            1,
        ),
        (
            500,
            "server private body".to_string(),
            "pending",
            1,
            "HTTP_SERVER_ERROR",
            1,
        ),
        (
            200,
            serde_json::json!({ "unexpected": true }).to_string(),
            "pending",
            1,
            "REPAIR_RESPONSE_MALFORMED",
            1,
        ),
    ];

    for (http_status, body, expected_status, expected_attempts, expected_error, failed) in cases {
        let upload = queued_attachment_upload();
        let connection = Arc::new(Mutex::new(
            Connection::open_in_memory().expect("open sqlite"),
        ));
        let queue_id = {
            let guard = connection.lock().expect("lock sqlite");
            seed_repair_attachment_queue(&guard, &upload)
        };
        let (url, _, server) = spawn_single_http_response(http_status, body);
        let hooks = RecordingRepairHooks {
            attachment_upload: Mutex::new(Some(upload)),
            ..RecordingRepairHooks::default()
        };

        let result =
            process_queue_with_repair_hooks(connection.as_ref(), &url, "native-api-key", &hooks)
                .await
                .expect("bounded attachment disposition");
        server.join().expect("join disposition server");

        let (status, attempts, error): (String, i64, Option<String>) = connection
            .lock()
            .expect("lock sqlite")
            .query_row(
                "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
                [queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("attachment disposition row remains");
        assert_eq!(status, expected_status, "HTTP {http_status}");
        assert_eq!(attempts, expected_attempts, "HTTP {http_status}");
        assert_eq!(error.as_deref(), Some(expected_error), "HTTP {http_status}");
        assert_eq!(result.failed, failed, "HTTP {http_status}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_sends_exact_bytes_hash_length_and_canonical_greek_headers() {
    let bytes = b"exact-repair-photo-bytes".to_vec();
    let metadata = attachment_metadata(&bytes);
    let upload = RepairRawAttachmentUpload {
        repair_id: REPAIR_ID.to_string(),
        metadata: copy_test_attachment_metadata(&metadata),
        bytes: Zeroizing::new(bytes.clone()),
    };
    let response_body = serde_json::json!({
        "attachment_id": metadata.attachment_id,
        "repair_id": REPAIR_ID,
        "status": "repairing",
        "version": 4
    })
    .to_string();
    let (url, recorded, server) = spawn_single_http_response(201, response_body);
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");

    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("send raw attachment");
    assert!(matches!(
        disposition,
        RepairAttachmentDisposition::Uploaded(ref result)
            if result.attachment_id == metadata.attachment_id && result.version == 4
    ));
    server.join().expect("join response server");

    let request = recorded.lock().expect("lock request").clone();
    let (headers, body) = split_recorded_request(&request);
    let lower_headers = headers.to_ascii_lowercase();
    assert!(headers.starts_with(&format!(
        "POST /api/pos/repairs/{REPAIR_ID}/attachments/raw HTTP/1.1"
    )));
    assert!(lower_headers.contains("content-type: application/octet-stream"));
    assert!(lower_headers.contains(&format!("content-length: {}", bytes.len())));
    assert!(lower_headers.contains(&format!("x-repair-content-hash: {}", metadata.sha256_hex)));
    assert!(lower_headers.contains("x-repair-content-type: image/png"));
    assert!(lower_headers.contains("x-pos-api-key: native-api-key"));
    assert!(lower_headers.contains(&format!("x-terminal-id: {TERMINAL_ID}")));
    assert!(lower_headers.contains(&format!("x-staff-session-id: {SESSION_ID}")));
    assert!(lower_headers.contains(&format!(
        "x-pos-client-version: {}",
        env!("CARGO_PKG_VERSION")
    )));
    assert_eq!(body, bytes);

    let filename_header = headers
        .lines()
        .find_map(|line| line.strip_prefix("x-repair-filename-b64url: "))
        .expect("filename header");
    let caption_header = headers
        .lines()
        .find_map(|line| line.strip_prefix("x-repair-caption-b64url: "))
        .expect("caption header");
    assert!(!filename_header.contains('='), "base64url must be unpadded");
    assert_eq!(
        String::from_utf8(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(filename_header)
                .expect("decode filename")
        )
        .expect("UTF-8 filename"),
        metadata.filename
    );
    assert_eq!(
        String::from_utf8(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(caption_header)
                .expect("decode caption")
        )
        .expect("UTF-8 caption"),
        metadata.caption.as_deref().expect("caption")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_rejects_invalid_hash_without_network() {
    let bytes = b"exact-repair-photo-bytes".to_vec();
    let mut metadata = attachment_metadata(&bytes);
    metadata.sha256_hex = "0".repeat(64);
    let server = MockServer::new(r#"{"unexpected":true}"#);
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");
    let error = send_repair_raw_attachment(
        &server.url,
        "native-api-key",
        &session,
        &RepairRawAttachmentUpload {
            repair_id: REPAIR_ID.to_string(),
            metadata,
            bytes: Zeroizing::new(bytes),
        },
    )
    .await
    .expect_err("hash mismatch must fail before request");
    assert_eq!(error.code(), "REPAIR_ATTACHMENT_HASH_MISMATCH");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_parses_only_bounded_safe_conflict() {
    let bytes = b"conflicting-repair-photo".to_vec();
    let metadata = attachment_metadata(&bytes);
    let conflict_body = serde_json::json!({
        "code": "REPAIR_VERSION_CONFLICT",
        "message": "Repair changed",
        "operation_id": OPERATION_ID,
        "repair_id": REPAIR_ID,
        "expected_version": 3,
        "current_version": 4,
        "allowed_transitions": ["repairing"],
        "summary": {
            "display_number": "R-ATH-26-000001",
            "status": "repairing",
            "version": 4,
            "updated_at": "2026-08-26T10:00:00.000Z"
        }
    })
    .to_string();
    let (url, _recorded, server) = spawn_single_http_response(409, conflict_body);
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");

    let disposition = send_repair_raw_attachment(
        &url,
        "native-api-key",
        &session,
        &RepairRawAttachmentUpload {
            repair_id: REPAIR_ID.to_string(),
            metadata,
            bytes: Zeroizing::new(bytes),
        },
    )
    .await
    .expect("parse attachment conflict");
    server.join().expect("join conflict server");
    assert!(matches!(
        disposition,
        RepairAttachmentDisposition::Conflict(ref conflict)
            if conflict.current_version == 4 && conflict.operation_id == OPERATION_ID
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_classifies_non_version_409_as_bounded_top_level_error() {
    let bytes = b"attachment-409-classification".to_vec();
    let upload = RepairRawAttachmentUpload {
        repair_id: REPAIR_ID.to_string(),
        metadata: attachment_metadata(&bytes),
        bytes: Zeroizing::new(bytes),
    };
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");

    let expired = serde_json::json!({
        "code": "REPAIR_EXPIRED_SESSION",
        "message": "Session expired"
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(409, expired);
    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded expired-session response");
    server.join().expect("join expired-session server");
    assert!(matches!(
        disposition,
        RepairAttachmentDisposition::SessionRequired(ref error)
            if error.code == "REPAIR_EXPIRED_SESSION"
    ));

    let mismatch = serde_json::json!({
        "code": "REPAIR_ATTACHMENT_OBJECT_MISMATCH",
        "message": "Stored object mismatch"
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(409, mismatch);
    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded object-mismatch response");
    server.join().expect("join object-mismatch server");
    assert!(matches!(
        disposition,
        RepairAttachmentDisposition::PermanentFailure(ref error)
            if error.code == "REPAIR_ATTACHMENT_OBJECT_MISMATCH"
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_rejects_invalid_metadata_and_bytes_without_network() {
    let bytes = b"exact-repair-photo-bytes".to_vec();
    let valid = attachment_metadata(&bytes);
    let mut invalid_metadata = Vec::new();

    let mut invalid_mime = copy_test_attachment_metadata(&valid);
    invalid_mime.mime_type = "image/svg+xml".to_string();
    invalid_metadata.push(invalid_mime);
    let mut invalid_type = copy_test_attachment_metadata(&valid);
    invalid_type.attachment_type = "private_note".to_string();
    invalid_metadata.push(invalid_type);
    let mut invalid_timestamp = copy_test_attachment_metadata(&valid);
    invalid_timestamp.occurred_at = "not-a-timestamp".to_string();
    invalid_metadata.push(invalid_timestamp);
    let mut invalid_filename = copy_test_attachment_metadata(&valid);
    invalid_filename.filename = " ".to_string();
    invalid_metadata.push(invalid_filename);
    let mut invalid_caption = copy_test_attachment_metadata(&valid);
    invalid_caption.caption = Some("x".repeat(1_001));
    invalid_metadata.push(invalid_caption);
    let mut invalid_size = copy_test_attachment_metadata(&valid);
    invalid_size.byte_size += 1;
    invalid_metadata.push(invalid_size);

    let server = MockServer::new(r#"{"unexpected":true}"#);
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");
    for metadata in invalid_metadata {
        let error = send_repair_raw_attachment(
            &server.url,
            "native-api-key",
            &session,
            &RepairRawAttachmentUpload {
                repair_id: REPAIR_ID.to_string(),
                metadata,
                bytes: Zeroizing::new(bytes.clone()),
            },
        )
        .await
        .expect_err("invalid metadata must fail before request");
        assert_eq!(error.code(), "REPAIR_ATTACHMENT_METADATA_INVALID");
    }

    let oversized_bytes = vec![0x5a; 15 * 1024 * 1024 + 1];
    let error = send_repair_raw_attachment(
        &server.url,
        "native-api-key",
        &session,
        &RepairRawAttachmentUpload {
            repair_id: REPAIR_ID.to_string(),
            metadata: attachment_metadata(&oversized_bytes),
            bytes: Zeroizing::new(oversized_bytes),
        },
    )
    .await
    .expect_err("oversized bytes must fail before request");
    assert_eq!(error.code(), "REPAIR_ATTACHMENT_METADATA_INVALID");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_requires_a_validated_session_before_network() {
    let server = MockServer::new(r#"{"unexpected":true}"#);
    let invalid_session = complete_session_blob().replace(SESSION_ID, "local-simple-pin");
    let error = resolve_repair_session(
        Some(&invalid_session),
        "local-simple-pin",
        "local-simple-pin",
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect_err("raw uploader cannot be called without a validated session");
    assert_eq!(error.code(), RepairSessionErrorCode::SessionInvalid);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_rejects_untrusted_success_shapes_and_oversized_responses() {
    let bytes = b"strict-attachment-response".to_vec();
    let metadata = attachment_metadata(&bytes);
    let upload = RepairRawAttachmentUpload {
        repair_id: REPAIR_ID.to_string(),
        metadata: copy_test_attachment_metadata(&metadata),
        bytes: Zeroizing::new(bytes),
    };
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");

    let mismatched = serde_json::json!({
        "attachment_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "repair_id": REPAIR_ID,
        "status": "repairing",
        "version": 4
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(201, mismatched);
    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded mismatched response");
    server.join().expect("join mismatch server");
    assert_eq!(disposition, RepairAttachmentDisposition::MalformedResponse);

    let later_current_version = serde_json::json!({
        "attachment_id": metadata.attachment_id,
        "repair_id": REPAIR_ID,
        "status": "repairing",
        "version": metadata.expected_version + 2
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(201, later_current_version);
    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded later-current-version response");
    server.join().expect("join later-current-version server");
    assert!(matches!(
        disposition,
        RepairAttachmentDisposition::Uploaded(ref result)
            if result.version == metadata.expected_version + 2
    ));

    for stale_version in [metadata.expected_version, metadata.expected_version - 1] {
        let stale = serde_json::json!({
            "attachment_id": metadata.attachment_id,
            "repair_id": REPAIR_ID,
            "status": "repairing",
            "version": stale_version
        })
        .to_string();
        let (url, _, server) = spawn_single_http_response(201, stale);
        let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
            .await
            .expect("bounded stale-version response");
        server.join().expect("join stale-version server");
        assert_eq!(disposition, RepairAttachmentDisposition::MalformedResponse);
    }

    let unknown_field = serde_json::json!({
        "attachment_id": metadata.attachment_id,
        "repair_id": REPAIR_ID,
        "status": "repairing",
        "version": 4,
        "object_path": "private/secret/path"
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(201, unknown_field);
    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded unknown-field response");
    server.join().expect("join unknown-field server");
    assert_eq!(disposition, RepairAttachmentDisposition::MalformedResponse);

    let oversized = "x".repeat(MAX_REPAIR_RESPONSE_BYTES + 1);
    let (url, _, server) = spawn_single_http_response(201, oversized);
    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded oversized response");
    server.join().expect("join oversized server");
    assert_eq!(disposition, RepairAttachmentDisposition::MalformedResponse);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_raw_uploader_projects_non_201_errors_without_echoing_body() {
    let bytes = b"safe-error-response".to_vec();
    let upload = RepairRawAttachmentUpload {
        repair_id: REPAIR_ID.to_string(),
        metadata: attachment_metadata(&bytes),
        bytes: Zeroizing::new(bytes),
    };
    let secret = "PRIVATE_DIAGNOSIS_MUST_NOT_ESCAPE";
    let body = serde_json::json!({
        "code": "REPAIR_ATTACHMENT_POLICY_DENIED",
        "message": secret
    })
    .to_string();
    let (url, _, server) = spawn_single_http_response(422, body);
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated attachment session");

    let disposition = send_repair_raw_attachment(&url, "native-api-key", &session, &upload)
        .await
        .expect("bounded permanent response");
    server.join().expect("join permanent response server");
    assert!(matches!(
        disposition,
        RepairAttachmentDisposition::PermanentFailure(ref error)
            if error.code == "REPAIR_ATTACHMENT_POLICY_DENIED"
    ));
    assert!(!format!("{disposition:?}").contains(secret));
}

#[test]
fn repair_typed_online_requests_compile_only_fixed_allowlisted_routes() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated online session");
    let cases = vec![
        (
            RepairJsonRequest::List {
                status: Some("ready".to_string()),
                search: Some("R-ATH-26".to_string()),
                limit: 25,
                offset: 0,
            },
            "GET",
            "/api/pos/repairs?status=ready&search=R-ATH-26&limit=25&offset=0",
        ),
        (
            RepairJsonRequest::Workspace {
                repair_id: REPAIR_ID.to_string(),
            },
            "GET",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888",
        ),
        (
            RepairJsonRequest::Settings,
            "GET",
            "/api/pos/repairs/settings",
        ),
        (
            RepairJsonRequest::Customers {
                search: "Ada Lovelace".to_string(),
                limit: 20,
                offset: 0,
            },
            "GET",
            "/api/pos/repairs/customers?search=Ada+Lovelace&limit=20&offset=0",
        ),
        (
            RepairJsonRequest::CustomerDevices {
                customer_id: STAFF_ID.to_string(),
            },
            "GET",
            "/api/pos/repairs/customers/22222222-2222-4222-8222-222222222222/devices",
        ),
        (
            RepairJsonRequest::CreateCustomerDevice {
                customer_id: STAFF_ID.to_string(),
                device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                label: Some("Front desk phone".to_string()),
                device_type: "smartphone".to_string(),
                manufacturer: Some("Example".to_string()),
                model: Some("Model 1".to_string()),
                variant: None,
                storage_capacity: None,
                color: Some("black".to_string()),
            },
            "POST",
            "/api/pos/repairs/customers/22222222-2222-4222-8222-222222222222/devices",
        ),
        (
            RepairJsonRequest::Attachments {
                repair_id: REPAIR_ID.to_string(),
            },
            "GET",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/attachments",
        ),
        (
            RepairJsonRequest::PrintProjection {
                repair_id: REPAIR_ID.to_string(),
            },
            "GET",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/print-projection",
        ),
        (
            RepairJsonRequest::Command {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
                command: RepairTypedCommand::TransitionStatus {
                    target_status: "quality_check".to_string(),
                    reason: None,
                    remain_consumed: false,
                },
            },
            "POST",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/commands",
        ),
        (
            RepairJsonRequest::Settlement {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
            },
            "POST",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/settlement",
        ),
        (
            RepairJsonRequest::Payment {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
                amount_minor: 5_000,
                payment_method: "card".to_string(),
                provider_reference: Some("terminal:txn-1".to_string()),
            },
            "POST",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/payments",
        ),
        (
            RepairJsonRequest::Refund {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
                payment_id: STAFF_ID.to_string(),
                amount_minor: 500,
                refund_method: "card".to_string(),
                reason: "Customer-approved correction".to_string(),
            },
            "POST",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/refunds",
        ),
        (
            RepairJsonRequest::Fiscalize {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
            },
            "POST",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/fiscalize",
        ),
        (
            RepairJsonRequest::Delivery {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
                reason: None,
            },
            "POST",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/delivery",
        ),
    ];
    for (request, expected_method, expected_path) in cases {
        let prepared =
            prepare_repair_json_request(&session, &request).expect("allowlisted typed request");
        assert_eq!(prepared.method, expected_method);
        assert_eq!(prepared.path, expected_path);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn repair_offline_bootstrap_posts_native_empty_body_and_accepts_authoritative_token() {
    let _keyring = install_empty_repair_keyring();
    let response_body = serde_json::json!({
        "actor_attestation": repair_actor_attestation(),
        "numbering_lease": {
            "kind": "sequence",
            "offline_terminal_token": "A9F0",
            "offline_sequence_lease_start": 1201,
            "offline_sequence_lease_end": 1300
        }
    })
    .to_string();
    let (url, recorded, server) = spawn_single_http_response(200, response_body);

    let bootstrap = send_repair_actor_bootstrap_request(
        &url,
        "native-api-key",
        Some(&complete_session_blob()),
        &native_scope(),
        SESSION_ID,
    )
    .await
    .expect("offline bootstrap request");
    server.join().expect("join offline bootstrap server");
    assert_eq!(
        bootstrap.numbering_lease.as_sequence(),
        Some(("A9F0", 1201, 1300))
    );
    assert_ne!(&TERMINAL_ID[TERMINAL_ID.len() - 4..], "A9F0");
    assert!(
        crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1).is_some()
    );

    let request = recorded.lock().expect("lock bootstrap request").clone();
    let (headers, body) = split_recorded_request(&request);
    let lower_headers = headers.to_ascii_lowercase();
    assert!(headers.starts_with("POST /api/pos/repairs/offline-bootstrap HTTP/1.1"));
    assert!(lower_headers.contains("content-type: application/json"));
    assert!(lower_headers.contains("x-pos-api-key: native-api-key"));
    assert!(lower_headers.contains(&format!("x-terminal-id: {TERMINAL_ID}")));
    assert!(lower_headers.contains(&format!("x-staff-session-id: {SESSION_ID}")));
    assert_eq!(body, b"{}");
}

#[test]
fn repair_offline_bootstrap_rejects_renderer_fields_and_generic_transport() {
    for field in ["offline_terminal_token", "terminal_id", "organization_id"] {
        let mut request = serde_json::json!({ "action": "offline_bootstrap" });
        request[field] = serde_json::json!("DEAD");
        assert!(
            serde_json::from_value::<RepairJsonTransportInput>(serde_json::json!({
                "staffSessionId": SESSION_ID,
                "request": request
            }))
            .is_err(),
            "renderer field {field} must be rejected"
        );
    }

    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated bootstrap session");
    let error = match prepare_repair_json_request(&session, &RepairJsonRequest::OfflineBootstrap {})
    {
        Ok(_) => panic!("generic JSON transport must reject offline bootstrap"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "REPAIR_OFFLINE_BOOTSTRAP_NATIVE_ONLY");
}

#[tokio::test(flavor = "current_thread")]
async fn repair_offline_bootstrap_requires_native_session_before_network() {
    let server = MockServer::new(
        r#"{"offline_terminal_token":"A9F0","offline_sequence_lease_start":1,"offline_sequence_lease_end":100}"#,
    );
    let error = match send_repair_actor_bootstrap_request(
        &server.url,
        "native-api-key",
        None,
        &native_scope(),
        SESSION_ID,
    )
    .await
    {
        Ok(_) => panic!("missing native session must fail before bootstrap request"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "REPAIR_STAFF_SESSION_REQUIRED");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_typed_payment_uses_native_headers_and_preserves_reporting_projection() {
    let _keyring = install_repair_identity();
    let response_body = serde_json::json!({
        "repair_id": REPAIR_ID,
        "order_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "payment_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "amount_minor": 5000,
        "balance_minor": 2500,
        "payment_status": "partially_paid",
        "fiscal_purpose": null,
        "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "resulting_version": 4,
        "was_replay": false,
        "reporting_shift_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "reporting_projection": {
            "source": "repair_canonical_tender_projection_v1",
            "staff_shift_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "projection_version": 7,
            "projected_at": "2026-08-26T10:00:01.000Z",
            "overall_tender": 100.0,
            "overall_cash": 40.0,
            "overall_card": 60.0,
            "overall_orders_count": 4,
            "repair_tender": 50.0,
            "repair_cash": 0.0,
            "repair_card": 50.0,
            "repair_orders_count": 1
        },
        "repair": { "repair_id": REPAIR_ID, "status": "repairing", "version": 4 }
    })
    .to_string();
    let (url, recorded, server) = spawn_single_http_response(200, response_body);
    let input = RepairJsonTransportInput {
        staff_session_id: SESSION_ID.to_string(),
        request: RepairJsonRequest::Payment {
            repair_id: REPAIR_ID.to_string(),
            operation_id: OPERATION_ID.to_string(),
            expected_version: 3,
            occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
            amount_minor: 5_000,
            payment_method: "card".to_string(),
            provider_reference: Some("terminal:txn-1".to_string()),
        },
    };
    let disposition =
        send_repair_json_request(&url, "native-api-key", None, &native_scope(), &input)
            .await
            .expect("typed payment request");
    server.join().expect("join typed payment server");
    let RepairJsonDisposition::Success { data, .. } = disposition else {
        panic!("expected typed success")
    };
    assert_eq!(
        data.pointer("/reporting_projection/projection_version"),
        Some(&serde_json::json!(7))
    );
    let request = recorded.lock().expect("lock typed request").clone();
    let (headers, body) = split_recorded_request(&request);
    let lower_headers = headers.to_ascii_lowercase();
    assert!(headers.starts_with(&format!(
        "POST /api/pos/repairs/{REPAIR_ID}/payments HTTP/1.1"
    )));
    assert!(lower_headers.contains(&format!("x-terminal-id: {TERMINAL_ID}")));
    assert!(lower_headers.contains(&format!("x-staff-session-id: {SESSION_ID}")));
    assert!(lower_headers.contains("x-pos-api-key: native-api-key"));
    let json: serde_json::Value = serde_json::from_slice(&body).expect("payment body JSON");
    assert_eq!(json["staff_session_id"], SESSION_ID);
    assert_eq!(json["repair_id"], REPAIR_ID);
    assert_eq!(json["payload"]["amount_minor"], 5_000);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_typed_online_session_mismatch_performs_no_request() {
    let _keyring = install_repair_identity();
    let server = MockServer::new(r#"{"unexpected":true}"#);
    let input = RepairJsonTransportInput {
        staff_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
        request: RepairJsonRequest::Workspace {
            repair_id: REPAIR_ID.to_string(),
        },
    };
    let error =
        send_repair_json_request(&server.url, "native-api-key", None, &native_scope(), &input)
            .await
            .expect_err("attested and claimed online sessions must match");
    assert_eq!(error.code(), "REPAIR_ACTOR_MISMATCH");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

#[test]
fn repair_typed_create_and_reopen_use_root_route_and_expect_201() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated create session");
    let create = RepairJsonRequest::Command {
        repair_id: REPAIR_ID.to_string(),
        operation_id: OPERATION_ID.to_string(),
        expected_version: 0,
        occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
        command: RepairTypedCommand::CreateIntake {
            intake_mode: "standard".to_string(),
            is_anonymous: false,
            customer_id: Some(STAFF_ID.to_string()),
            customer_device_id: Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string()),
            priority: "normal".to_string(),
            currency: "EUR".to_string(),
            title: Some("Screen repair".to_string()),
            intake_notes: None,
            due_at: None,
            offline_alias: None,
            offline_sequence: None,
        },
    };
    let prepared = prepare_repair_json_request(&session, &create).expect("create spec");
    assert_eq!(prepared.method, "POST");
    assert_eq!(prepared.path, "/api/pos/repairs");
    assert_eq!(prepared.expected_success_status, 201);

    let reopen = RepairJsonRequest::Command {
        repair_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
        operation_id: OPERATION_ID.to_string(),
        expected_version: 0,
        occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
        command: RepairTypedCommand::ReopenRepair {
            source_repair_id: REPAIR_ID.to_string(),
        },
    };
    let prepared = prepare_repair_json_request(&session, &reopen).expect("reopen spec");
    assert_eq!(prepared.path, "/api/pos/repairs");
    assert_eq!(prepared.expected_success_status, 201);
}

#[tokio::test(flavor = "current_thread")]
async fn repair_typed_command_payloads_fail_closed_before_network() {
    let _keyring = install_repair_identity();
    let server = MockServer::new(r#"{"unexpected":true}"#);
    let invalid = vec![
        RepairTypedCommand::CreateIntake {
            intake_mode: "standard".to_string(),
            is_anonymous: true,
            customer_id: None,
            customer_device_id: None,
            priority: "normal".to_string(),
            currency: "EUR".to_string(),
            title: None,
            intake_notes: None,
            due_at: None,
            offline_alias: None,
            offline_sequence: None,
        },
        RepairTypedCommand::RecordApproval {
            approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            estimate_id: None,
            decision: "accepted".to_string(),
            decision_source: "not_required".to_string(),
            reason: None,
        },
        RepairTypedCommand::TransitionStatus {
            target_status: "paid".to_string(),
            reason: None,
            remain_consumed: false,
        },
        RepairTypedCommand::PlanLine {
            line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            line_type: "part".to_string(),
            name_snapshot: "Display".to_string(),
            sku_snapshot: None,
            description: None,
            quantity: "NaN".to_string(),
            unit_cost_snapshot: None,
            unit_price_snapshot: "100.00".to_string(),
            vat_rate_snapshot: "24".to_string(),
            retail_product_id: None,
            retail_variant_id: None,
            service_id: None,
            display_order: 0,
        },
    ];
    for command in invalid {
        let input = RepairJsonTransportInput {
            staff_session_id: SESSION_ID.to_string(),
            request: RepairJsonRequest::Command {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
                command,
            },
        };
        let error =
            send_repair_json_request(&server.url, "native-api-key", None, &native_scope(), &input)
                .await
                .expect_err("invalid command payload must not reach the network");
        assert_eq!(error.code(), "REPAIR_ONLINE_INPUT_INVALID");
    }

    let unknown_payload_field = serde_json::json!({
        "staffSessionId": SESSION_ID,
        "request": {
            "action": "command",
            "repair_id": REPAIR_ID,
            "operation_id": OPERATION_ID,
            "expected_version": 3,
            "occurred_at": "2026-08-26T10:00:00.000Z",
            "command": {
                "command": "transition_status",
                "payload": {
                    "target_status": "quality_check",
                    "reason": null,
                    "remain_consumed": false,
                    "private_note": "must not pass"
                }
            }
        }
    });
    assert!(serde_json::from_value::<RepairJsonTransportInput>(unknown_payload_field).is_err());
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.count(), 0);
}

fn repair_capabilities() -> serde_json::Value {
    serde_json::json!({
        "read": true, "create": true, "update": true, "assign": true,
        "approve": true, "overrideApproval": false, "planParts": true,
        "consumeParts": false, "transfer": false, "cancel": true,
        "manageAttachments": true, "collectPayments": true,
        "refundPayments": true, "fiscalize": true,
        "overrideDeliveryBalance": false
    })
}

fn minimal_workspace() -> serde_json::Value {
    serde_json::json!({
        "repair": {
            "id": REPAIR_ID, "display_number": "R-ATH-26-000001",
            "status": "repairing", "priority": "normal", "title": "Screen repair",
            "intake_mode": "standard", "is_anonymous": false,
            "assigned_staff_id": STAFF_ID, "due_at": null, "completed_at": null,
            "delivered_at": null, "version": 5,
            "created_at": "2026-08-26T09:00:00.000Z",
            "updated_at": "2026-08-26T10:00:00.000Z",
            "customer_id": STAFF_ID,
            "customer_device_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "intake_notes": "Cracked screen", "diagnosis": null,
            "currency": "EUR", "origin_branch_id": BRANCH_ID,
            "reopened_from_repair_id": null
        },
        "aliases": [],
        "customer": { "id": STAFF_ID, "display_name": "Ada Lovelace" },
        "device": null, "lines": [], "events": [], "estimates": [],
        "estimate_lines": [], "approvals": [],
        "capabilities": repair_capabilities(),
        "allowed_transitions": ["quality_check"]
    })
}

#[test]
fn repair_typed_read_responses_are_strict_and_attachment_metadata_is_minimized() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated read session");
    let cases = vec![
        (
            RepairJsonRequest::List {
                status: None,
                search: None,
                limit: 25,
                offset: 0,
            },
            serde_json::json!({
                "repairs": [{
                    "id": REPAIR_ID, "display_number": "R-ATH-26-000001",
                    "status": "repairing", "priority": "normal", "title": "Screen repair",
                    "intake_mode": "standard", "is_anonymous": false,
                    "assigned_staff_id": STAFF_ID, "due_at": null, "completed_at": null,
                    "version": 3, "created_at": "2026-08-26T09:00:00.000Z",
                    "updated_at": "2026-08-26T10:00:00.000Z"
                }],
                "pagination": { "count": 1, "limit": 25, "offset": 0 }
            }),
        ),
        (
            RepairJsonRequest::Workspace {
                repair_id: REPAIR_ID.to_string(),
            },
            minimal_workspace(),
        ),
        (
            RepairJsonRequest::Settings,
            serde_json::json!({
                "settings": {
                    "source": "branch", "number_prefix": "R", "currency": "EUR",
                    "quick_service_enabled": true, "default_priority": "normal",
                    "default_sla_hours": 48, "ready_collection_days": 14,
                    "delivery_balance_policy": "require_zero_balance",
                    "repair_deposit_supported": false,
                    "attachment_policy": {
                        "max_bytes": 15728640,
                        "allowed_mime_types": ["image/jpeg", "image/png"]
                    },
                    "updated_at": null
                },
                "capabilities": repair_capabilities()
            }),
        ),
        (
            RepairJsonRequest::Customers {
                search: "".to_string(),
                limit: 20,
                offset: 0,
            },
            serde_json::json!({
                "customers": [{ "id": STAFF_ID, "name": "Ada Lovelace" }],
                "pagination": { "count": 1, "limit": 20, "offset": 0 }
            }),
        ),
        (
            RepairJsonRequest::CustomerDevices {
                customer_id: STAFF_ID.to_string(),
            },
            serde_json::json!({ "devices": [] }),
        ),
        (
            RepairJsonRequest::PrintProjection {
                repair_id: REPAIR_ID.to_string(),
            },
            serde_json::json!({
                "projection": {
                    "projectionSource": "repair_authorized_projection_v1",
                    "projectionVersion": 3,
                    "projectedAt": "2026-08-26T10:00:00.000Z",
                    "repairId": REPAIR_ID, "repairNumber": "R-ATH-26-000001",
                    "customerDisplayName": "Ada Lovelace",
                    "safeDeviceLabel": "Example Model 1",
                    "maskedIdentifier": "IMEI •••• 12",
                    "receivedAt": "2026-08-26T09:00:00.000Z",
                    "branchName": "Athens", "branchContact": "+302100000000"
                }
            }),
        ),
    ];
    for (request, body) in cases {
        let prepared = prepare_repair_json_request(&session, &request).expect("typed read spec");
        let disposition =
            classify_repair_json_response_body(200, body.to_string().as_bytes(), None, &prepared);
        assert!(
            matches!(disposition, RepairJsonDisposition::Success { .. }),
            "valid typed read response was rejected: {disposition:?}"
        );
    }

    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Attachments {
            repair_id: REPAIR_ID.to_string(),
        },
    )
    .expect("attachment list spec");
    let body = serde_json::json!({
        "attachments": [{
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "attachment_type": "diagnostic", "retention_state": "active",
            "mime_type": "image/png", "byte_size": 1234,
            "created_at": "2026-08-26T10:00:00.000Z"
        }]
    });
    let disposition =
        classify_repair_json_response_body(200, body.to_string().as_bytes(), None, &prepared);
    let RepairJsonDisposition::Success { data, .. } = disposition else {
        panic!("safe attachment list must succeed")
    };
    assert!(data.pointer("/attachments/0/original_filename").is_none());
    assert!(data.pointer("/attachments/0/caption").is_none());
    assert_eq!(
        data.pointer("/attachments/0/byte_size"),
        Some(&serde_json::json!(1234))
    );

    let unsafe_body = serde_json::json!({
        "attachments": [{
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "attachment_type": "diagnostic", "retention_state": "active",
            "mime_type": "image/png", "byte_size": 1234,
            "original_filename": "private-customer-name.png",
            "created_at": "2026-08-26T10:00:00.000Z"
        }]
    });
    assert!(matches!(
        classify_repair_json_response_body(
            200,
            unsafe_body.to_string().as_bytes(),
            None,
            &prepared,
        ),
        RepairJsonDisposition::MalformedResponse
    ));
}

#[test]
fn repair_collection_responses_keep_hard_byte_caps_and_bounded_attachment_count() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated large collection session");

    let workspace_request = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Workspace {
            repair_id: REPAIR_ID.to_string(),
        },
    )
    .expect("workspace request");
    let events: Vec<_> = (0..2_001)
        .map(|index| {
            serde_json::json!({
                "id": format!("aaaaaaaa-aaaa-4aaa-8aaa-{index:012x}"),
                "aggregate_version": index + 1,
                "event_type": "assignment_changed",
                "payload": {},
                "occurred_at": "2026-08-26T10:00:00.000Z",
                "created_at": "2026-08-26T10:00:00.000Z"
            })
        })
        .collect();
    let mut workspace = minimal_workspace();
    workspace["repair"]["version"] = serde_json::json!(2_001);
    workspace["events"] = serde_json::json!(events);
    let workspace_bytes = workspace.to_string();
    assert!(workspace_bytes.len() > MAX_REPAIR_RESPONSE_BYTES);
    assert!(workspace_bytes.len() < MAX_REPAIR_COLLECTION_RESPONSE_BYTES);
    assert!(matches!(
        classify_repair_json_response_body(
            200,
            workspace_bytes.as_bytes(),
            None,
            &workspace_request,
        ),
        RepairJsonDisposition::Success { .. }
    ));

    let attachments_request = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Attachments {
            repair_id: REPAIR_ID.to_string(),
        },
    )
    .expect("attachments request");
    let mut attachments: Vec<_> = (0..250)
        .map(|index| {
            serde_json::json!({
                "id": format!("bbbbbbbb-bbbb-4bbb-8bbb-{index:012x}"),
                "attachment_type": "diagnostic",
                "retention_state": "active",
                "mime_type": "image/png",
                "byte_size": 1234,
                "created_at": "2026-08-26T10:00:00.000Z"
            })
        })
        .collect();
    let attachment_bytes = serde_json::json!({ "attachments": &attachments }).to_string();
    assert!(attachment_bytes.len() < MAX_REPAIR_COLLECTION_RESPONSE_BYTES);
    assert!(matches!(
        classify_repair_json_response_body(
            200,
            attachment_bytes.as_bytes(),
            None,
            &attachments_request,
        ),
        RepairJsonDisposition::Success { .. }
    ));
    attachments.push(serde_json::json!({
        "id": "bbbbbbbb-bbbb-4bbb-8bbb-0000000000fa",
        "attachment_type": "diagnostic",
        "retention_state": "active",
        "mime_type": "image/png",
        "byte_size": 1234,
        "created_at": "2026-08-26T10:00:00.000Z"
    }));
    let too_many_attachment_bytes = serde_json::json!({ "attachments": attachments }).to_string();
    assert_eq!(
        classify_repair_json_response_body(
            200,
            too_many_attachment_bytes.as_bytes(),
            None,
            &attachments_request,
        ),
        RepairJsonDisposition::MalformedResponse
    );

    let devices_request = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::CustomerDevices {
            customer_id: STAFF_ID.to_string(),
        },
    )
    .expect("devices request");
    let devices: Vec<_> = (0..1_001)
        .map(|index| {
            serde_json::json!({
                "id": format!("cccccccc-cccc-4ccc-8ccc-{index:012x}"),
                "organization_id": ORGANIZATION_ID,
                "customer_id": STAFF_ID,
                "label": format!("Device {index}"),
                "device_type": "smartphone",
                "manufacturer": null,
                "model": null,
                "variant": null,
                "storage_capacity": null,
                "color": null,
                "serial_masked": null,
                "imei_masked": null,
                "created_at": "2026-08-26T10:00:00.000Z",
                "updated_at": "2026-08-26T10:00:00.000Z"
            })
        })
        .collect();
    let device_bytes = serde_json::json!({ "devices": devices }).to_string();
    assert!(device_bytes.len() > MAX_REPAIR_RESPONSE_BYTES);
    assert!(matches!(
        classify_repair_json_response_body(200, device_bytes.as_bytes(), None, &devices_request,),
        RepairJsonDisposition::Success { .. }
    ));

    let oversized = vec![b'x'; MAX_REPAIR_COLLECTION_RESPONSE_BYTES + 1];
    for prepared in [workspace_request, attachments_request, devices_request] {
        assert_eq!(
            classify_repair_json_response_body(200, &oversized, None, &prepared),
            RepairJsonDisposition::MalformedResponse
        );
    }
}

#[test]
fn repair_typed_response_rejects_unknown_fields_oversize_and_identity_mismatch() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated response session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Workspace {
            repair_id: REPAIR_ID.to_string(),
        },
    )
    .expect("workspace request");
    let mut unknown = minimal_workspace();
    unknown["repair"]["object_path"] = serde_json::json!("private/secret");
    assert_eq!(
        classify_repair_json_response_body(200, unknown.to_string().as_bytes(), None, &prepared),
        RepairJsonDisposition::MalformedResponse
    );
    let oversized = vec![b'x'; MAX_REPAIR_RESPONSE_BYTES + 1];
    assert_eq!(
        classify_repair_json_response_body(200, &oversized, None, &prepared),
        RepairJsonDisposition::MalformedResponse
    );
    let mut mismatch = minimal_workspace();
    mismatch["repair"]["id"] = serde_json::json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert_eq!(
        classify_repair_json_response_body(200, mismatch.to_string().as_bytes(), None, &prepared),
        RepairJsonDisposition::MalformedResponse
    );
}

#[test]
fn repair_workspace_events_enforce_event_specific_payload_types_and_identities() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated workspace event session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Workspace {
            repair_id: REPAIR_ID.to_string(),
        },
    )
    .expect("workspace request");
    let event = serde_json::json!({
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "aggregate_version": 4,
        "event_type": "status_changed",
        "payload": {
            "from_status": "repairing",
            "to_status": "quality_check",
            "remain_consumed": false,
            "consumed_line_ids": ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
            "consumed_line_count": 1
        },
        "occurred_at": "2026-08-26T10:00:00.000Z",
        "created_at": "2026-08-26T10:00:00.000Z"
    });
    let mut valid = minimal_workspace();
    valid["events"] = serde_json::json!([event]);
    assert!(matches!(
        classify_repair_json_response_body(200, valid.to_string().as_bytes(), None, &prepared),
        RepairJsonDisposition::Success { .. }
    ));

    let consumed_line_ids: Vec<_> = (0..101)
        .map(|index| format!("bbbbbbbb-bbbb-4bbb-8bbb-{index:012x}"))
        .collect();
    let mut valid_large_status_event = minimal_workspace();
    valid_large_status_event["events"] = serde_json::json!([{
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "aggregate_version": 4,
        "event_type": "status_changed",
        "payload": {
            "from_status": "repairing",
            "to_status": "quality_check",
            "consumed_line_ids": consumed_line_ids,
            "consumed_line_count": 101
        },
        "occurred_at": "2026-08-26T10:00:00.000Z",
        "created_at": "2026-08-26T10:00:00.000Z"
    }, {
        "id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "aggregate_version": 5,
        "event_type": "approval_recorded",
        "payload": {
            "approval_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "estimate_id": null,
            "estimate_version": null,
            "decision": "accepted",
            "decision_source": "email",
            "currency": "EUR",
            "approved_total_amount": 0
        },
        "occurred_at": "2026-08-26T10:00:00.000Z",
        "created_at": "2026-08-26T10:00:00.000Z"
    }]);
    assert!(matches!(
        classify_repair_json_response_body(
            200,
            valid_large_status_event.to_string().as_bytes(),
            None,
            &prepared,
        ),
        RepairJsonDisposition::Success { .. }
    ));

    let invalid_events = [
        serde_json::json!({
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "aggregate_version": 4,
            "event_type": "diagnosis_updated",
            "payload": { "diagnosis": "bounded", "draft": "false" },
            "occurred_at": "2026-08-26T10:00:00.000Z",
            "created_at": "2026-08-26T10:00:00.000Z"
        }),
        serde_json::json!({
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "aggregate_version": 4,
            "event_type": "status_changed",
            "payload": {
                "from_status": "repairing",
                "to_status": "quality_check",
                "consumed_line_ids": ["not-a-repair-line-id"]
            },
            "occurred_at": "2026-08-26T10:00:00.000Z",
            "created_at": "2026-08-26T10:00:00.000Z"
        }),
        serde_json::json!({
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "aggregate_version": 4,
            "event_type": "part_consumed",
            "payload": {
                "repair_line_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "movement_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "diagnosis": "private field must not cross event boundary"
            },
            "occurred_at": "2026-08-26T10:00:00.000Z",
            "created_at": "2026-08-26T10:00:00.000Z"
        }),
    ];
    for invalid_event in invalid_events {
        let mut invalid = minimal_workspace();
        invalid["events"] = serde_json::json!([invalid_event]);
        assert_eq!(
            classify_repair_json_response_body(
                200,
                invalid.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse
        );
    }

    let mut mixed_snapshot = minimal_workspace();
    mixed_snapshot["events"] = serde_json::json!([{
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "aggregate_version": 6,
        "event_type": "assignment_changed",
        "payload": {},
        "occurred_at": "2026-08-26T10:00:00.000Z",
        "created_at": "2026-08-26T10:00:00.000Z"
    }]);
    assert_eq!(
        classify_repair_json_response_body(
            200,
            mixed_snapshot.to_string().as_bytes(),
            None,
            &prepared,
        ),
        RepairJsonDisposition::MalformedResponse,
        "child aggregate versions newer than the workspace header must refetch"
    );
}

#[test]
fn repair_device_create_normalizes_shared_optional_empty_metadata_to_null() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated device metadata session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::CreateCustomerDevice {
            customer_id: STAFF_ID.to_string(),
            device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            label: Some(" Front desk phone ".to_string()),
            device_type: " smartphone ".to_string(),
            manufacturer: Some("".to_string()),
            model: Some("   ".to_string()),
            variant: None,
            storage_capacity: Some(" 128 GB ".to_string()),
            color: Some(" black ".to_string()),
        },
    )
    .expect("shared device metadata normalization");
    let body: serde_json::Value =
        serde_json::from_str(prepared.body.as_deref().expect("device create body"))
            .expect("JSON device body");
    assert_eq!(body["label"], "Front desk phone");
    assert_eq!(body["device_type"], "smartphone");
    assert!(body["manufacturer"].is_null());
    assert!(body["model"].is_null());
    assert_eq!(body["storage_capacity"], "128 GB");
    assert_eq!(body["color"], "black");

    let invalid_label = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::CreateCustomerDevice {
            customer_id: STAFF_ID.to_string(),
            device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            label: Some("   ".to_string()),
            device_type: "smartphone".to_string(),
            manufacturer: None,
            model: None,
            variant: None,
            storage_capacity: None,
            color: None,
        },
    );
    assert!(invalid_label.is_err());

    let requested_device_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let response = serde_json::json!({
        "device": {
            "id": requested_device_id,
            "organization_id": ORGANIZATION_ID,
            "customer_id": STAFF_ID,
            "label": "Front desk phone",
            "device_type": "smartphone",
            "manufacturer": null,
            "model": null,
            "variant": null,
            "storage_capacity": null,
            "color": null,
            "serial_masked": null,
            "imei_masked": null,
            "created_at": "2026-08-26T10:00:00.000Z",
            "updated_at": "2026-08-26T10:00:00.000Z"
        }
    });
    assert!(matches!(
        classify_repair_json_response_body(201, response.to_string().as_bytes(), None, &prepared,),
        RepairJsonDisposition::Success { .. }
    ));
    let mut mismatched = response;
    mismatched["device"]["id"] = serde_json::json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(
        classify_repair_json_response_body(201, mismatched.to_string().as_bytes(), None, &prepared,),
        RepairJsonDisposition::MalformedResponse
    );
}

#[test]
fn repair_print_projection_rejects_raw_or_noncanonical_device_identifiers() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated print session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::PrintProjection {
            repair_id: REPAIR_ID.to_string(),
        },
    )
    .expect("print projection request");
    let base = serde_json::json!({
        "projection": {
            "projectionSource": "repair_authorized_projection_v1",
            "projectionVersion": 3,
            "projectedAt": "2026-08-26T10:00:00.000Z",
            "repairId": REPAIR_ID,
            "repairNumber": "R-ATH-26-000001",
            "safeDeviceLabel": "Example Model 1",
            "maskedIdentifier": "SERIAL •••• A1B2",
            "receivedAt": "2026-08-26T09:00:00.000Z",
            "branchName": "Athens"
        }
    });
    assert!(matches!(
        classify_repair_json_response_body(200, base.to_string().as_bytes(), None, &prepared),
        RepairJsonDisposition::Success { .. }
    ));

    for unsafe_identifier in [
        "123456789012345",
        "IMEI 123456789012345",
        "IMEI ••• 12",
        "IMEI •••• 1",
        "SERIAL •••• A1B2C",
        "SERIAL •••• A-1",
    ] {
        let mut unsafe_body = base.clone();
        unsafe_body["projection"]["maskedIdentifier"] = serde_json::json!(unsafe_identifier);
        assert_eq!(
            classify_repair_json_response_body(
                200,
                unsafe_body.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse,
            "unsafe identifier escaped projection: {unsafe_identifier}"
        );
    }

    for unsafe_number in [
        "repair-123",
        "R-ath-26-000001",
        "R-ATH-2026-000001",
        "R-OFF-A1B2-12345",
        "R-ATH-26-000001-extra",
    ] {
        let mut unsafe_body = base.clone();
        unsafe_body["projection"]["repairNumber"] = serde_json::json!(unsafe_number);
        assert_eq!(
            classify_repair_json_response_body(
                200,
                unsafe_body.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse,
            "unsafe repair number escaped projection: {unsafe_number}"
        );
    }
}

#[test]
fn repair_typed_command_conflict_is_bounded_and_identity_checked() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated command session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Command {
            repair_id: REPAIR_ID.to_string(),
            operation_id: OPERATION_ID.to_string(),
            expected_version: 3,
            occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
            command: RepairTypedCommand::TransitionStatus {
                target_status: "quality_check".to_string(),
                reason: None,
                remain_consumed: false,
            },
        },
    )
    .expect("command spec");
    let conflict = serde_json::json!({
        "code": "REPAIR_VERSION_CONFLICT",
        "message": "Repair changed",
        "operation_id": OPERATION_ID,
        "repair_id": REPAIR_ID,
        "expected_version": 3,
        "current_version": 4,
        "allowed_transitions": ["repairing", "quality_check"],
        "summary": {
            "display_number": "R-ATH-26-000001",
            "status": "repairing",
            "version": 4,
            "updated_at": "2026-08-26T10:00:00.000Z"
        }
    })
    .to_string();
    let disposition = classify_repair_json_response_body(409, conflict.as_bytes(), None, &prepared);
    assert!(matches!(
        disposition,
        RepairJsonDisposition::Conflict { ref conflict }
            if conflict.operation_id == OPERATION_ID && conflict.current_version == 4
    ));
}

fn reporting_projection() -> serde_json::Value {
    serde_json::json!({
        "source": "repair_canonical_tender_projection_v1",
        "staff_shift_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "projection_version": 7,
        "projected_at": "2026-08-26T10:00:01.000Z",
        "overall_tender": 100.0, "overall_cash": 40.0, "overall_card": 60.0,
        "overall_orders_count": 4, "repair_tender": 50.0,
        "repair_cash": 0.0, "repair_card": 50.0, "repair_orders_count": 1
    })
}

#[test]
fn repair_typed_money_success_shapes_are_exact_and_version_bound() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated money session");
    let occurred_at = "2026-08-26T10:00:00.000Z".to_string();
    let cases = vec![
        (
            RepairJsonRequest::Settlement {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: occurred_at.clone(),
            },
            serde_json::json!({
                "repair_id": REPAIR_ID,
                "order_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "settlement_role": "primary",
                "estimate_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "estimate_version": 2, "total_minor": 7500, "currency": "EUR",
                "fiscal_state": "deferred",
                "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "resulting_version": 4, "was_replay": false,
                "repair": { "repair_id": REPAIR_ID, "status": "repairing", "version": 4 }
            }),
        ),
        (
            RepairJsonRequest::Refund {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: occurred_at.clone(),
                payment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                amount_minor: 500,
                refund_method: "card".to_string(),
                reason: "Correction".to_string(),
            },
            serde_json::json!({
                "repair_id": REPAIR_ID,
                "order_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "payment_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "adjustment_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                "amount_minor": 500, "balance_minor": 2000, "fiscal_purpose": "credit",
                "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "resulting_version": 4, "was_replay": false,
                "reporting_shift_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                "reporting_projection": reporting_projection(),
                "repair": { "repair_id": REPAIR_ID, "status": "repairing", "version": 4 }
            }),
        ),
        (
            RepairJsonRequest::Fiscalize {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at: occurred_at.clone(),
            },
            serde_json::json!({
                "repair_id": REPAIR_ID,
                "order_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "fiscal_command_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "fiscal_state": "issue_pending",
                "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "resulting_version": 4, "was_replay": false,
                "repair": { "repair_id": REPAIR_ID, "status": "repairing", "version": 4 }
            }),
        ),
        (
            RepairJsonRequest::Delivery {
                repair_id: REPAIR_ID.to_string(),
                operation_id: OPERATION_ID.to_string(),
                expected_version: 3,
                occurred_at,
                reason: None,
            },
            serde_json::json!({
                "repair_id": REPAIR_ID, "status": "delivered", "balance_minor": 0,
                "override": false,
                "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "resulting_version": 4, "was_replay": false,
                "repair": { "repair_id": REPAIR_ID, "status": "delivered", "version": 4 }
            }),
        ),
    ];
    for (request, response) in cases {
        let prepared = prepare_repair_json_request(&session, &request).expect("money request");
        let disposition = classify_repair_json_response_body(
            200,
            response.to_string().as_bytes(),
            None,
            &prepared,
        );
        assert!(
            matches!(disposition, RepairJsonDisposition::Success { .. }),
            "valid typed money response rejected: {disposition:?}"
        );

        let mut later_current_projection = response.clone();
        later_current_projection["repair"]["version"] = serde_json::json!(5);
        assert!(
            matches!(
                classify_repair_json_response_body(
                    200,
                    later_current_projection.to_string().as_bytes(),
                    None,
                    &prepared,
                ),
                RepairJsonDisposition::Success { .. }
            ),
            "a later authoritative repair projection must remain valid"
        );
        let mut older_projection = response.clone();
        older_projection["repair"]["version"] = serde_json::json!(3);
        assert_eq!(
            classify_repair_json_response_body(
                200,
                older_projection.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse
        );

        if response.get("reporting_shift_id").is_some() {
            let mut corrective_without_projection = response.clone();
            corrective_without_projection["reporting_projection"] = serde_json::Value::Null;
            let disposition = classify_repair_json_response_body(
                200,
                corrective_without_projection.to_string().as_bytes(),
                None,
                &prepared,
            );
            let RepairJsonDisposition::Success { data, .. } = disposition else {
                panic!("shift-scoped corrective response must remain usable")
            };
            assert_eq!(
                data["reporting_shift_id"],
                serde_json::json!("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
            );

            let mut projection_without_shift = response.clone();
            projection_without_shift["reporting_shift_id"] = serde_json::Value::Null;
            assert_eq!(
                classify_repair_json_response_body(
                    200,
                    projection_without_shift.to_string().as_bytes(),
                    None,
                    &prepared,
                ),
                RepairJsonDisposition::MalformedResponse
            );
        }

        if response.get("settlement_role").is_some() {
            let mut zero_total = response.clone();
            zero_total["total_minor"] = serde_json::json!(0);
            assert!(matches!(
                classify_repair_json_response_body(
                    200,
                    zero_total.to_string().as_bytes(),
                    None,
                    &prepared,
                ),
                RepairJsonDisposition::Success { .. }
            ));
            let mut invalid_negative_primary = response.clone();
            invalid_negative_primary["total_minor"] = serde_json::json!(-1);
            assert_eq!(
                classify_repair_json_response_body(
                    200,
                    invalid_negative_primary.to_string().as_bytes(),
                    None,
                    &prepared,
                ),
                RepairJsonDisposition::MalformedResponse
            );
        }

        let mut wrong_version = response;
        wrong_version["resulting_version"] = serde_json::json!(5);
        assert_eq!(
            classify_repair_json_response_body(
                200,
                wrong_version.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse
        );
    }
}

#[test]
fn repair_typed_money_errors_are_operation_scoped_and_require_authorized_refetch() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated money error session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Settlement {
            repair_id: REPAIR_ID.to_string(),
            operation_id: OPERATION_ID.to_string(),
            expected_version: 3,
            occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
        },
    )
    .expect("settlement request");

    for (status, code) in [
        (422, "REPAIR_SETTLEMENT_INVALID"),
        (409, "REPAIR_VERSION_CONFLICT"),
    ] {
        let body = serde_json::json!({
            "code": code,
            "message": "Bounded repair money error",
            "operation_id": OPERATION_ID,
            "repair_id": REPAIR_ID
        });
        assert!(matches!(
            classify_repair_json_response_body(
                status,
                body.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::PermanentFailure {
                status: actual_status,
                ref error,
            } if actual_status == status && error.code == code
        ));

        for field in ["operation_id", "repair_id"] {
            let mut mismatch = body.clone();
            mismatch[field] = serde_json::json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            assert_eq!(
                classify_repair_json_response_body(
                    status,
                    mismatch.to_string().as_bytes(),
                    None,
                    &prepared,
                ),
                RepairJsonDisposition::MalformedResponse
            );
        }
        let mut unknown = body;
        unknown["private_note"] = serde_json::json!("must never cross native boundary");
        assert_eq!(
            classify_repair_json_response_body(
                status,
                unknown.to_string().as_bytes(),
                None,
                &prepared,
            ),
            RepairJsonDisposition::MalformedResponse
        );
    }

    let expired = serde_json::json!({
        "code": "REPAIR_EXPIRED_SESSION",
        "message": "Staff session expired",
        "operation_id": OPERATION_ID,
        "repair_id": REPAIR_ID
    });
    assert!(matches!(
        classify_repair_json_response_body(
            409,
            expired.to_string().as_bytes(),
            None,
            &prepared,
        ),
        RepairJsonDisposition::SessionRequired { ref error }
            if error.code == "REPAIR_EXPIRED_SESSION"
    ));
}

#[test]
fn repair_typed_money_success_is_bound_to_requested_amount_and_payment() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated money association session");
    let occurred_at = "2026-08-26T10:00:00.000Z".to_string();
    let payment = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Payment {
            repair_id: REPAIR_ID.to_string(),
            operation_id: OPERATION_ID.to_string(),
            expected_version: 3,
            occurred_at: occurred_at.clone(),
            amount_minor: 500,
            payment_method: "card".to_string(),
            provider_reference: None,
        },
    )
    .expect("payment request");
    let payment_body = serde_json::json!({
        "repair_id": REPAIR_ID,
        "order_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "payment_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "amount_minor": 500,
        "balance_minor": 2000,
        "payment_status": "partially_paid",
        "fiscal_purpose": null,
        "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "resulting_version": 4,
        "was_replay": false,
        "reporting_shift_id": null,
        "reporting_projection": null,
        "repair": { "repair_id": REPAIR_ID, "status": "repairing", "version": 4 }
    });
    assert!(matches!(
        classify_repair_json_response_body(
            200,
            payment_body.to_string().as_bytes(),
            None,
            &payment,
        ),
        RepairJsonDisposition::Success { .. }
    ));
    let mut wrong_payment_amount = payment_body;
    wrong_payment_amount["amount_minor"] = serde_json::json!(501);
    assert_eq!(
        classify_repair_json_response_body(
            200,
            wrong_payment_amount.to_string().as_bytes(),
            None,
            &payment,
        ),
        RepairJsonDisposition::MalformedResponse
    );

    let expected_payment_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let refund = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Refund {
            repair_id: REPAIR_ID.to_string(),
            operation_id: OPERATION_ID.to_string(),
            expected_version: 3,
            occurred_at,
            payment_id: expected_payment_id.to_string(),
            amount_minor: 200,
            refund_method: "card".to_string(),
            reason: "Correction".to_string(),
        },
    )
    .expect("refund request");
    let refund_body = serde_json::json!({
        "repair_id": REPAIR_ID,
        "order_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "payment_id": expected_payment_id,
        "adjustment_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "amount_minor": 200,
        "balance_minor": 2200,
        "fiscal_purpose": "credit",
        "event_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "resulting_version": 4,
        "was_replay": false,
        "reporting_shift_id": null,
        "reporting_projection": null,
        "repair": { "repair_id": REPAIR_ID, "status": "repairing", "version": 4 }
    });
    assert!(matches!(
        classify_repair_json_response_body(200, refund_body.to_string().as_bytes(), None, &refund,),
        RepairJsonDisposition::Success { .. }
    ));
    let mut missing_fiscal_purpose = refund_body.clone();
    missing_fiscal_purpose
        .as_object_mut()
        .expect("refund response object")
        .remove("fiscal_purpose");
    assert_eq!(
        classify_repair_json_response_body(
            200,
            missing_fiscal_purpose.to_string().as_bytes(),
            None,
            &refund,
        ),
        RepairJsonDisposition::MalformedResponse,
        "refund responses must preserve the explicit nullable fiscal purpose field"
    );
    for (field, value) in [
        ("amount_minor", serde_json::json!(201)),
        (
            "payment_id",
            serde_json::json!("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
        ),
    ] {
        let mut mismatched = refund_body.clone();
        mismatched[field] = value;
        assert_eq!(
            classify_repair_json_response_body(
                200,
                mismatched.to_string().as_bytes(),
                None,
                &refund,
            ),
            RepairJsonDisposition::MalformedResponse
        );
    }
}

#[test]
fn repair_typed_command_success_requires_exact_status_and_newer_current_version() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated command session");
    let create = RepairJsonRequest::Command {
        repair_id: REPAIR_ID.to_string(),
        operation_id: OPERATION_ID.to_string(),
        expected_version: 0,
        occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
        command: RepairTypedCommand::CreateIntake {
            intake_mode: "quick_service".to_string(),
            is_anonymous: true,
            customer_id: None,
            customer_device_id: None,
            priority: "normal".to_string(),
            currency: "EUR".to_string(),
            title: None,
            intake_notes: None,
            due_at: None,
            offline_alias: None,
            offline_sequence: None,
        },
    };
    let prepared = prepare_repair_json_request(&session, &create).expect("create command");
    let signal = serde_json::json!({
        "repair_id": REPAIR_ID, "status": "received", "version": 2
    })
    .to_string();
    assert!(matches!(
        classify_repair_json_response_body(201, signal.as_bytes(), None, &prepared),
        RepairJsonDisposition::Success { status: 201, .. }
    ));
    assert_eq!(
        classify_repair_json_response_body(200, signal.as_bytes(), None, &prepared),
        RepairJsonDisposition::MalformedResponse
    );
    let stale = serde_json::json!({
        "repair_id": REPAIR_ID, "status": "received", "version": 0
    })
    .to_string();
    assert_eq!(
        classify_repair_json_response_body(201, stale.as_bytes(), None, &prepared),
        RepairJsonDisposition::MalformedResponse
    );
}

#[test]
fn repair_typed_409_distinguishes_expired_session_from_version_conflict() {
    let session = resolve_repair_session(
        Some(&complete_session_blob()),
        SESSION_ID,
        SESSION_ID,
        ORGANIZATION_ID,
        &native_scope(),
    )
    .expect("validated command session");
    let prepared = prepare_repair_json_request(
        &session,
        &RepairJsonRequest::Command {
            repair_id: REPAIR_ID.to_string(),
            operation_id: OPERATION_ID.to_string(),
            expected_version: 3,
            occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
            command: RepairTypedCommand::TransitionStatus {
                target_status: "quality_check".to_string(),
                reason: None,
                remain_consumed: false,
            },
        },
    )
    .expect("command request");
    let expired = br#"{"code":"REPAIR_EXPIRED_SESSION","message":"Staff session expired"}"#;
    assert!(matches!(
        classify_repair_json_response_body(409, expired, None, &prepared),
        RepairJsonDisposition::SessionRequired { .. }
    ));
}
