//! Frozen renderer-safe repair IPC contracts.
//!
//! Tenant scope, credentials, queue envelopes, ciphertext, native paths and
//! signed URLs are intentionally absent from every serializable type here.

use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairListInput {
    pub(crate) staff_session_id: String,
    pub(crate) status: Option<String>,
    pub(crate) search: Option<String>,
    pub(crate) limit: u16,
    pub(crate) offset: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairDeviceSnapshot {
    pub(crate) id: String,
    pub(crate) label: Option<String>,
    pub(crate) device_type: String,
    pub(crate) manufacturer: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) variant: Option<String>,
    pub(crate) storage_capacity: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) serial_masked: Option<String>,
    pub(crate) imei_masked: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairCustomerDevicesSnapshot {
    pub(crate) scope_token: String,
    pub(crate) devices: Vec<RepairDeviceSnapshot>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairListItemSnapshot {
    pub(crate) id: String,
    pub(crate) display_number: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) status: String,
    pub(crate) priority: String,
    pub(crate) intake_mode: String,
    pub(crate) safe_device_label: Option<String>,
    pub(crate) due_at: Option<String>,
    pub(crate) ready_at: Option<String>,
    pub(crate) authoritative_version: u64,
    pub(crate) optimistic_version: u64,
    pub(crate) sync_state: &'static str,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairPaginationSnapshot {
    pub(crate) count: u64,
    pub(crate) limit: u16,
    pub(crate) offset: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairListSnapshot {
    pub(crate) scope_token: String,
    pub(crate) source: &'static str,
    pub(crate) repairs: Vec<RepairListItemSnapshot>,
    pub(crate) pagination: RepairPaginationSnapshot,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairWorkspaceInput {
    pub(crate) staff_session_id: String,
    pub(crate) repair_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairSettingsInput {
    pub(crate) staff_session_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairCustomerSearchInput {
    pub(crate) staff_session_id: String,
    pub(crate) search: String,
    pub(crate) limit: u16,
    pub(crate) offset: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairCustomerDevicesInput {
    pub(crate) staff_session_id: String,
    pub(crate) customer_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairCreateCustomerDeviceInput {
    pub(crate) staff_session_id: String,
    pub(crate) customer_id: String,
    pub(crate) device_id: String,
    pub(crate) label: Option<String>,
    pub(crate) device_type: String,
    pub(crate) manufacturer: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) variant: Option<String>,
    pub(crate) storage_capacity: Option<String>,
    pub(crate) color: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairCustomerSnapshot {
    pub(crate) id: String,
    pub(crate) display_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairCustomerSearchSnapshot {
    pub(crate) scope_token: String,
    pub(crate) customers: Vec<RepairCustomerSnapshot>,
    pub(crate) pagination: RepairPaginationSnapshot,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairCapabilitiesSnapshot {
    pub(crate) read: bool,
    pub(crate) create: bool,
    pub(crate) update: bool,
    pub(crate) assign: bool,
    pub(crate) approve: bool,
    pub(crate) override_approval: bool,
    pub(crate) plan_parts: bool,
    pub(crate) consume_parts: bool,
    pub(crate) transfer: bool,
    pub(crate) cancel: bool,
    pub(crate) manage_attachments: bool,
    pub(crate) collect_payments: bool,
    pub(crate) refund_payments: bool,
    pub(crate) fiscalize: bool,
    pub(crate) override_delivery_balance: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairAttachmentPolicySnapshot {
    pub(crate) max_bytes: u64,
    pub(crate) allowed_mime_types: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairSettingsProjection {
    pub(crate) source: String,
    pub(crate) number_prefix: String,
    pub(crate) currency: String,
    pub(crate) quick_service_enabled: bool,
    pub(crate) default_priority: String,
    pub(crate) default_sla_hours: Option<u64>,
    pub(crate) ready_collection_days: u64,
    pub(crate) delivery_balance_policy: String,
    pub(crate) repair_deposit_supported: bool,
    pub(crate) attachment_policy: RepairAttachmentPolicySnapshot,
    pub(crate) updated_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairSettingsSnapshot {
    pub(crate) scope_token: String,
    pub(crate) source: &'static str,
    pub(crate) settings: RepairSettingsProjection,
    pub(crate) capabilities: RepairCapabilitiesSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairWorkspaceHeaderSnapshot {
    pub(crate) id: String,
    pub(crate) display_number: String,
    pub(crate) status: String,
    pub(crate) priority: String,
    pub(crate) title: Option<String>,
    pub(crate) intake_mode: String,
    pub(crate) is_anonymous: bool,
    pub(crate) assigned_staff_id: Option<String>,
    pub(crate) due_at: Option<String>,
    pub(crate) completed_at: Option<String>,
    pub(crate) delivered_at: Option<String>,
    pub(crate) version: u64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) customer_id: Option<String>,
    pub(crate) customer_device_id: Option<String>,
    pub(crate) intake_notes: Option<String>,
    pub(crate) diagnosis: Option<String>,
    pub(crate) currency: String,
    pub(crate) reopened_from_repair_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairLineSnapshot {
    pub(crate) id: String,
    pub(crate) line_type: String,
    pub(crate) name_snapshot: String,
    pub(crate) sku_snapshot: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) quantity: f64,
    pub(crate) unit_price_snapshot: f64,
    pub(crate) vat_rate_snapshot: f64,
    pub(crate) retail_product_id: Option<String>,
    pub(crate) retail_variant_id: Option<String>,
    pub(crate) service_id: Option<String>,
    pub(crate) part_state: Option<String>,
    pub(crate) display_order: u64,
    pub(crate) aggregate_version: u64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairTimelineEventSnapshot {
    pub(crate) id: String,
    pub(crate) aggregate_version: u64,
    pub(crate) event_type: String,
    pub(crate) repair_line_id: Option<String>,
    pub(crate) movement_id: Option<String>,
    pub(crate) occurred_at: String,
    pub(crate) created_at: String,
}

fn safe_consumption_references(
    event_type: &str,
    payload: &serde_json::Value,
) -> (Option<String>, Option<String>) {
    if event_type != "part_consumed" {
        return (None, None);
    }
    let canonical = |key: &str| {
        payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .and_then(|value| {
                uuid::Uuid::parse_str(value)
                    .ok()
                    .map(|parsed| parsed.hyphenated().to_string())
                    .filter(|normalized| normalized == value)
            })
    };
    match (canonical("repair_line_id"), canonical("movement_id")) {
        (Some(line_id), Some(movement_id)) => (Some(line_id), Some(movement_id)),
        _ => (None, None),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairEstimateSnapshot {
    pub(crate) id: String,
    pub(crate) version: u64,
    pub(crate) supersedes_estimate_id: Option<String>,
    pub(crate) currency: String,
    pub(crate) subtotal_amount: f64,
    pub(crate) discount_amount: f64,
    pub(crate) tax_amount: f64,
    pub(crate) total_amount: f64,
    pub(crate) valid_until: Option<String>,
    pub(crate) note: Option<String>,
    pub(crate) aggregate_version: u64,
    pub(crate) issued_at: String,
    pub(crate) created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairEstimateLineSnapshot {
    pub(crate) id: String,
    pub(crate) estimate_id: String,
    pub(crate) estimate_version: u64,
    pub(crate) repair_line_id: Option<String>,
    pub(crate) line_type: String,
    pub(crate) description: String,
    pub(crate) quantity: f64,
    pub(crate) unit_price: f64,
    pub(crate) tax_rate: f64,
    pub(crate) subtotal_amount: f64,
    pub(crate) tax_amount: f64,
    pub(crate) total_amount: f64,
    pub(crate) display_order: u64,
    pub(crate) aggregate_version: u64,
    pub(crate) created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairApprovalSnapshot {
    pub(crate) id: String,
    pub(crate) estimate_id: Option<String>,
    pub(crate) estimate_version: Option<u64>,
    pub(crate) decision: String,
    pub(crate) decision_source: String,
    pub(crate) currency: String,
    pub(crate) approved_total_amount: f64,
    pub(crate) note: Option<String>,
    pub(crate) decided_at: String,
    pub(crate) aggregate_version: u64,
    pub(crate) created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairPendingChangeSnapshot {
    pub(crate) kind: String,
    pub(crate) occurred_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairWorkspaceSnapshot {
    pub(crate) scope_token: String,
    pub(crate) source: &'static str,
    pub(crate) repair: RepairWorkspaceHeaderSnapshot,
    pub(crate) aliases: Vec<String>,
    pub(crate) customer: Option<RepairCustomerSnapshot>,
    pub(crate) device: Option<RepairDeviceSnapshot>,
    pub(crate) lines: Vec<RepairLineSnapshot>,
    pub(crate) timeline: Vec<RepairTimelineEventSnapshot>,
    pub(crate) estimates: Vec<RepairEstimateSnapshot>,
    pub(crate) estimate_lines: Vec<RepairEstimateLineSnapshot>,
    pub(crate) approvals: Vec<RepairApprovalSnapshot>,
    pub(crate) capabilities: RepairCapabilitiesSnapshot,
    pub(crate) allowed_transitions: Vec<String>,
    pub(crate) pending_changes: Vec<RepairPendingChangeSnapshot>,
    pub(crate) sync_state: &'static str,
    pub(crate) needs_refetch: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairEstimateLineCommandInput {
    pub(crate) id: String,
    pub(crate) repair_line_id: Option<String>,
    pub(crate) line_type: String,
    pub(crate) description: String,
    pub(crate) quantity: String,
    pub(crate) unit_price: String,
    pub(crate) tax_rate: String,
    pub(crate) display_order: u32,
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "command",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum RepairCommand {
    CreateIntake {
        intake_mode: String,
        is_anonymous: bool,
        customer_id: Option<String>,
        customer_device_id: Option<String>,
        priority: String,
        currency: String,
        title: Option<String>,
        intake_notes: Option<String>,
        due_at: Option<String>,
    },
    ReopenRepair {
        source_repair_id: String,
    },
    AddNote {
        note: String,
        visibility: String,
    },
    AssignRepair {
        assigned_staff_id: Option<String>,
    },
    UpdateDiagnosis {
        diagnosis: Option<String>,
        draft: bool,
    },
    PlanLine {
        line_id: String,
        line_type: String,
        name_snapshot: String,
        sku_snapshot: Option<String>,
        description: Option<String>,
        quantity: String,
        unit_cost_snapshot: Option<String>,
        unit_price_snapshot: String,
        vat_rate_snapshot: String,
        retail_product_id: Option<String>,
        retail_variant_id: Option<String>,
        service_id: Option<String>,
        display_order: u32,
    },
    ConsumeNonstockPart {
        line_id: String,
    },
    ReverseNonstockPart {
        line_id: String,
        reason: String,
    },
    ConsumeRepairPart {
        line_id: String,
    },
    ReverseRepairPart {
        line_id: String,
        original_movement_id: String,
    },
    CreateEstimate {
        estimate_id: String,
        currency: String,
        discount_amount: String,
        valid_until: Option<String>,
        note: Option<String>,
        lines: Vec<RepairEstimateLineCommandInput>,
    },
    RecordApproval {
        approval_id: String,
        estimate_id: Option<String>,
        decision: String,
        decision_source: String,
        reason: Option<String>,
    },
    TransitionStatus {
        target_status: String,
        reason: Option<String>,
        remain_consumed: bool,
    },
    TransferBranch {
        destination_branch_id: String,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairExecuteCommandInput {
    pub(crate) staff_session_id: String,
    pub(crate) operation_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) occurred_at: String,
    pub(crate) command: RepairCommand,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairConflictSnapshot {
    pub(crate) conflict_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) current_version: u64,
    pub(crate) display_number: Option<String>,
    pub(crate) status: String,
    pub(crate) updated_at: String,
    pub(crate) allowed_transitions: Vec<String>,
    pub(crate) created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum RepairCommandSnapshot {
    Applied {
        scope_token: String,
        repair_id: String,
        display_number: Option<String>,
        status: String,
        version: u64,
        queued_for_sync: bool,
        customer_notification_state: &'static str,
    },
    Conflict {
        scope_token: String,
        conflict: RepairConflictSnapshot,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairStageAttachmentInput {
    pub(crate) staff_session_id: String,
    pub(crate) attachment_id: String,
    pub(crate) operation_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) occurred_at: String,
    pub(crate) attachment_type: String,
    pub(crate) filename: String,
    pub(crate) caption: Option<String>,
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairStageAttachmentSnapshot {
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) attachment_id: String,
    pub(crate) optimistic_version: u64,
    pub(crate) queued_for_sync: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairListAttachmentsInput {
    pub(crate) staff_session_id: String,
    pub(crate) repair_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairAttachmentSnapshot {
    pub(crate) id: String,
    pub(crate) attachment_type: String,
    pub(crate) retention_state: String,
    pub(crate) mime_type: String,
    pub(crate) byte_size: u64,
    pub(crate) created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairAttachmentsSnapshot {
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) attachments: Vec<RepairAttachmentSnapshot>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairOpenAttachmentInput {
    pub(crate) staff_session_id: String,
    pub(crate) repair_id: String,
    pub(crate) attachment_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairOpenAttachmentSnapshot {
    pub(crate) scope_token: String,
    pub(crate) attachment_id: String,
    pub(crate) opened: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairListConflictsInput {
    pub(crate) staff_session_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairConflictsSnapshot {
    pub(crate) scope_token: String,
    pub(crate) conflicts: Vec<RepairConflictSnapshot>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RepairConflictResolution {
    AcceptServer,
    Rebase,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairResolveConflictInput {
    pub(crate) staff_session_id: String,
    pub(crate) conflict_id: String,
    pub(crate) resolution: RepairConflictResolution,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairConflictResolutionSnapshot {
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) state: &'static str,
    pub(crate) optimistic_version: u64,
    pub(crate) needs_refetch: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RepairPrintKind {
    RepairIntake,
    RepairLabel,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairPrintInput {
    pub(crate) staff_session_id: String,
    pub(crate) repair_id: String,
    pub(crate) kind: RepairPrintKind,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairPrintProjectionSnapshot {
    pub(crate) projection_source: String,
    pub(crate) projection_version: u64,
    pub(crate) projected_at: String,
    pub(crate) repair_id: String,
    pub(crate) repair_number: String,
    pub(crate) safe_device_label: String,
    pub(crate) received_at: String,
    pub(crate) branch_name: String,
    pub(crate) customer_display_name: Option<String>,
    pub(crate) masked_identifier: Option<String>,
    pub(crate) due_at: Option<String>,
    pub(crate) branch_contact: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairPrintSnapshot {
    pub(crate) scope_token: String,
    pub(crate) kind: RepairPrintKind,
    pub(crate) projection: RepairPrintProjectionSnapshot,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairEnqueuePrintInput {
    pub(crate) staff_session_id: String,
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) kind: RepairPrintKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairEnqueuePrintSnapshot {
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) kind: RepairPrintKind,
    pub(crate) job_id: String,
    pub(crate) queued: bool,
}

fn build_safe_repair_print_payload(
    kind: RepairPrintKind,
    projection: &RepairPrintProjectionSnapshot,
) -> Result<(&'static str, serde_json::Value), String> {
    let projection_version = i64::try_from(projection.projection_version)
        .map_err(|_| "repair print projection version is invalid".to_string())?;
    let intake = crate::receipt_renderer::RepairIntakeDoc {
        projection_source: projection.projection_source.clone(),
        projection_version,
        projected_at: projection.projected_at.clone(),
        repair_id: projection.repair_id.clone(),
        repair_number: projection.repair_number.clone(),
        customer_display_name: projection.customer_display_name.clone(),
        safe_device_label: projection.safe_device_label.clone(),
        masked_identifier: projection.masked_identifier.clone(),
        received_at: projection.received_at.clone(),
        due_at: projection.due_at.clone(),
        branch_name: projection.branch_name.clone(),
        branch_contact: projection.branch_contact.clone(),
    };
    match kind {
        RepairPrintKind::RepairIntake => {
            let normalized = crate::receipt_renderer::normalize_repair_intake_doc(&intake)?;
            serde_json::to_value(normalized)
                .map(|payload| ("repair_intake", payload))
                .map_err(|_| "REPAIR_PRINT_PAYLOAD_INVALID".to_string())
        }
        RepairPrintKind::RepairLabel => {
            let label = crate::receipt_renderer::RepairLabelDoc {
                projection_source: intake.projection_source,
                projection_version: intake.projection_version,
                projected_at: intake.projected_at,
                repair_id: intake.repair_id,
                repair_number: intake.repair_number,
                customer_display_name: intake.customer_display_name,
                safe_device_label: intake.safe_device_label,
                masked_identifier: intake.masked_identifier,
                received_at: intake.received_at,
                due_at: intake.due_at,
                branch_name: intake.branch_name,
                branch_contact: intake.branch_contact,
            };
            let normalized = crate::receipt_renderer::normalize_repair_label_doc(&label)?;
            serde_json::to_value(normalized)
                .map(|payload| ("repair_label", payload))
                .map_err(|_| "REPAIR_PRINT_PAYLOAD_INVALID".to_string())
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairCacheChangedEvent {
    scope_token: String,
    repair_id: Option<String>,
    reason: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairConflictEvent {
    scope_token: String,
    conflict: RepairConflictSnapshot,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteDevice {
    id: String,
    organization_id: String,
    customer_id: String,
    label: Option<String>,
    device_type: String,
    manufacturer: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    storage_capacity: Option<String>,
    color: Option<String>,
    serial_masked: Option<String>,
    imei_masked: Option<String>,
    created_at: String,
    updated_at: String,
}

impl From<RemoteDevice> for RepairDeviceSnapshot {
    fn from(remote: RemoteDevice) -> Self {
        let _ = (remote.organization_id, remote.customer_id);
        Self {
            id: remote.id,
            label: remote.label,
            device_type: remote.device_type,
            manufacturer: remote.manufacturer,
            model: remote.model,
            variant: remote.variant,
            storage_capacity: remote.storage_capacity,
            color: remote.color,
            serial_masked: remote.serial_masked,
            imei_masked: remote.imei_masked,
            created_at: remote.created_at,
            updated_at: remote.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemotePagination {
    count: u64,
    limit: u16,
    offset: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteCustomerSearchItem {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteCustomerSearchResponse {
    customers: Vec<RemoteCustomerSearchItem>,
    pagination: RemotePagination,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteDevicesResponse {
    devices: Vec<RemoteDevice>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteDeviceResponse {
    device: RemoteDevice,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteSettingsProjection {
    source: String,
    number_prefix: String,
    currency: String,
    quick_service_enabled: bool,
    default_priority: String,
    default_sla_hours: Option<u64>,
    ready_collection_days: u64,
    delivery_balance_policy: String,
    repair_deposit_supported: bool,
    attachment_policy: RemoteAttachmentPolicy,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteAttachmentPolicy {
    max_bytes: u64,
    allowed_mime_types: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteSettingsResponse {
    settings: RemoteSettingsProjection,
    capabilities: RepairCapabilitiesSnapshot,
}

impl From<RemoteSettingsProjection> for RepairSettingsProjection {
    fn from(remote: RemoteSettingsProjection) -> Self {
        Self {
            source: remote.source,
            number_prefix: remote.number_prefix,
            currency: remote.currency,
            quick_service_enabled: remote.quick_service_enabled,
            default_priority: remote.default_priority,
            default_sla_hours: remote.default_sla_hours,
            ready_collection_days: remote.ready_collection_days,
            delivery_balance_policy: remote.delivery_balance_policy,
            repair_deposit_supported: remote.repair_deposit_supported,
            attachment_policy: RepairAttachmentPolicySnapshot {
                max_bytes: remote.attachment_policy.max_bytes,
                allowed_mime_types: remote.attachment_policy.allowed_mime_types,
            },
            updated_at: remote.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspaceHeader {
    id: String,
    display_number: Option<String>,
    status: String,
    priority: String,
    title: Option<String>,
    intake_mode: String,
    is_anonymous: bool,
    assigned_staff_id: Option<String>,
    due_at: Option<String>,
    completed_at: Option<String>,
    delivered_at: Option<String>,
    version: u64,
    created_at: String,
    updated_at: String,
    customer_id: Option<String>,
    customer_device_id: Option<String>,
    intake_notes: Option<String>,
    diagnosis: Option<String>,
    currency: String,
    origin_branch_id: String,
    reopened_from_repair_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspaceCustomer {
    id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspaceLine {
    id: String,
    line_type: String,
    name_snapshot: String,
    sku_snapshot: Option<String>,
    description: Option<String>,
    quantity: f64,
    unit_price_snapshot: f64,
    vat_rate_snapshot: f64,
    retail_product_id: Option<String>,
    retail_variant_id: Option<String>,
    service_id: Option<String>,
    part_state: Option<String>,
    display_order: u64,
    aggregate_version: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspaceEvent {
    id: String,
    aggregate_version: u64,
    event_type: String,
    payload: serde_json::Value,
    occurred_at: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteEstimate {
    id: String,
    version: u64,
    supersedes_estimate_id: Option<String>,
    currency: String,
    subtotal_amount: f64,
    discount_amount: f64,
    tax_amount: f64,
    total_amount: f64,
    valid_until: Option<String>,
    note: Option<String>,
    aggregate_version: u64,
    issued_at: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteEstimateLine {
    id: String,
    estimate_id: String,
    estimate_version: u64,
    repair_line_id: Option<String>,
    line_type: String,
    description: String,
    quantity: f64,
    unit_price: f64,
    tax_rate: f64,
    subtotal_amount: f64,
    tax_amount: f64,
    total_amount: f64,
    display_order: u64,
    aggregate_version: u64,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteApproval {
    id: String,
    estimate_id: Option<String>,
    estimate_version: Option<u64>,
    decision: String,
    decision_source: String,
    customer_id: Option<String>,
    currency: String,
    approved_total_amount: f64,
    note: Option<String>,
    decided_at: String,
    aggregate_version: u64,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteWorkspace {
    repair: RemoteWorkspaceHeader,
    aliases: Vec<String>,
    customer: Option<RemoteWorkspaceCustomer>,
    device: Option<RemoteDevice>,
    lines: Vec<RemoteWorkspaceLine>,
    events: Vec<RemoteWorkspaceEvent>,
    estimates: Vec<RemoteEstimate>,
    estimate_lines: Vec<RemoteEstimateLine>,
    approvals: Vec<RemoteApproval>,
    capabilities: RepairCapabilitiesSnapshot,
    allowed_transitions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteAttachmentsResponse {
    attachments: Vec<RemoteAttachment>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteAttachment {
    id: String,
    attachment_type: String,
    retention_state: String,
    mime_type: String,
    byte_size: u64,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemotePrintResponse {
    projection: RepairPrintProjectionSnapshot,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteCommandSignal {
    repair_id: String,
    status: String,
    version: u64,
}

fn sync_state(row: &crate::repairs::RepairCachedListRow) -> &'static str {
    if row.has_conflict {
        "conflict"
    } else if row.dirty {
        "queued"
    } else if row.needs_refetch {
        "needs_refetch"
    } else {
        "synced"
    }
}

fn project_list_row(row: crate::repairs::RepairCachedListRow) -> RepairListItemSnapshot {
    let row_sync_state = sync_state(&row);
    RepairListItemSnapshot {
        id: row.repair_id,
        display_number: row.display_number,
        aliases: row.aliases,
        status: row.status,
        priority: row.priority,
        intake_mode: row.intake_mode,
        safe_device_label: row.safe_device_label,
        due_at: row.due_at,
        ready_at: row.ready_at,
        authoritative_version: row.authoritative_version,
        optimistic_version: row.optimistic_version,
        sync_state: row_sync_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn project_conflict_record(
    conflict: crate::repairs::RepairConflictRecord,
) -> RepairConflictSnapshot {
    RepairConflictSnapshot {
        conflict_id: conflict.conflict_id,
        repair_id: conflict.repair_id,
        expected_version: conflict.expected_version,
        current_version: conflict.current_version,
        display_number: conflict.display_number,
        status: conflict.status,
        updated_at: conflict.updated_at,
        allowed_transitions: conflict.allowed_transitions,
        created_at: conflict.created_at,
    }
}

fn project_transport_conflict(
    conflict: crate::repair_transport::RepairConflictProjection,
) -> RepairConflictSnapshot {
    RepairConflictSnapshot {
        conflict_id: conflict.operation_id,
        repair_id: conflict.repair_id,
        expected_version: conflict.expected_version,
        current_version: conflict.current_version,
        display_number: conflict.summary.display_number,
        status: conflict.summary.status.as_str().to_string(),
        updated_at: conflict.summary.updated_at.clone(),
        allowed_transitions: conflict.allowed_transitions,
        created_at: conflict.summary.updated_at,
    }
}

fn pending_changes(
    operations: &[serde_json::Value],
) -> Result<Vec<RepairPendingChangeSnapshot>, String> {
    if operations.len() > 256 {
        return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
    }
    operations
        .iter()
        .map(|operation| {
            let kind = operation
                .get("command")
                .and_then(serde_json::Value::as_str)
                .filter(|value| {
                    matches!(
                        *value,
                        "create_intake"
                            | "add_note"
                            | "assign_repair"
                            | "update_diagnosis"
                            | "plan_line"
                            | "transition_status"
                            | "stage_attachment"
                    )
                })
                .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
            let occurred_at = operation
                .get("occurred_at")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
            Ok(RepairPendingChangeSnapshot {
                kind: kind.to_string(),
                occurred_at: occurred_at.to_string(),
            })
        })
        .collect()
}

fn fail_closed_capabilities() -> RepairCapabilitiesSnapshot {
    RepairCapabilitiesSnapshot {
        read: true,
        create: false,
        update: false,
        assign: false,
        approve: false,
        override_approval: false,
        plan_parts: false,
        consume_parts: false,
        transfer: false,
        cancel: false,
        manage_attachments: false,
        collect_payments: false,
        refund_payments: false,
        fiscalize: false,
        override_delivery_balance: false,
    }
}

fn offline_header(
    cached: &crate::repairs::RepairCachedWorkspace,
) -> Result<RepairWorkspaceHeaderSnapshot, String> {
    let create = cached
        .pending_operations
        .iter()
        .find(|operation| {
            operation.get("command").and_then(serde_json::Value::as_str) == Some("create_intake")
        })
        .and_then(|operation| operation.get("payload"))
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_WORKSPACE_REQUIRED".to_string())?;
    let optional_string = |key: &str| -> Result<Option<String>, String> {
        match create.get(key) {
            Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
            Some(serde_json::Value::Null) | None => Ok(None),
            _ => Err("REPAIR_CACHE_DECRYPT_FAILED".to_string()),
        }
    };
    Ok(RepairWorkspaceHeaderSnapshot {
        id: cached.row.repair_id.clone(),
        display_number: cached.row.display_number.clone(),
        status: cached.row.status.clone(),
        priority: cached.row.priority.clone(),
        title: optional_string("title")?,
        intake_mode: cached.row.intake_mode.clone(),
        is_anonymous: create
            .get("is_anonymous")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?,
        assigned_staff_id: None,
        due_at: cached.row.due_at.clone(),
        completed_at: None,
        delivered_at: None,
        version: cached.row.optimistic_version,
        created_at: cached.row.created_at.clone(),
        updated_at: cached.row.updated_at.clone(),
        customer_id: optional_string("customer_id")?,
        customer_device_id: optional_string("customer_device_id")?,
        intake_notes: optional_string("intake_notes")?,
        diagnosis: None,
        currency: create
            .get("currency")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?
            .to_string(),
        reopened_from_repair_id: None,
    })
}

fn pending_payload(
    operation: &serde_json::Value,
) -> Result<&serde_json::Map<String, serde_json::Value>, String> {
    operation
        .get("payload")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())
}

fn pending_string(
    payload: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    maximum_bytes: usize,
) -> Result<String, String> {
    payload
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= maximum_bytes)
        .map(str::to_string)
        .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())
}

fn pending_optional_string(
    payload: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    maximum_bytes: usize,
) -> Result<Option<String>, String> {
    match payload.get(key) {
        Some(serde_json::Value::String(value))
            if !value.is_empty() && value.len() <= maximum_bytes =>
        {
            Ok(Some(value.clone()))
        }
        Some(serde_json::Value::Null) | None => Ok(None),
        _ => Err("REPAIR_CACHE_DECRYPT_FAILED".to_string()),
    }
}

fn pending_decimal(
    payload: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<f64, String> {
    let value = pending_string(payload, key, 64)?
        .parse::<f64>()
        .map_err(|_| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
    if !value.is_finite() || value < 0.0 {
        return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
    }
    Ok(value)
}

fn reduce_pending_workspace(
    workspace: &mut RepairWorkspaceSnapshot,
    operations: &[serde_json::Value],
) -> Result<(), String> {
    if operations.len() > 256 {
        return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
    }
    let mut previous_expected_version = None;
    for operation in operations {
        let operation_id = operation
            .get("operation_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
        let repair_id = operation
            .get("repair_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
        if uuid::Uuid::parse_str(operation_id)
            .ok()
            .map(|value| value.hyphenated().to_string())
            .as_deref()
            != Some(operation_id)
            || repair_id != workspace.repair.id
        {
            return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
        }
        let command = operation
            .get("command")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
        let occurred_at = operation
            .get("occurred_at")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 64)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
        let expected_version = operation
            .get("expected_version")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| *value < 9_007_199_254_740_991)
            .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
        if previous_expected_version.is_some_and(|previous: u64| expected_version != previous + 1) {
            return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
        }
        previous_expected_version = Some(expected_version);
        workspace.repair.version = expected_version + 1;
        match command {
            "create_intake" => {
                let payload = pending_payload(operation)?;
                workspace.repair.title = pending_optional_string(payload, "title", 500)?;
                workspace.repair.intake_mode = pending_string(payload, "intake_mode", 32)?;
                workspace.repair.is_anonymous = payload
                    .get("is_anonymous")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
                workspace.repair.customer_id = pending_optional_string(payload, "customer_id", 36)?;
                workspace.repair.customer_device_id =
                    pending_optional_string(payload, "customer_device_id", 36)?;
                workspace.repair.priority = pending_string(payload, "priority", 32)?;
                workspace.repair.currency = pending_string(payload, "currency", 3)?;
                workspace.repair.intake_notes =
                    pending_optional_string(payload, "intake_notes", 4_000)?;
                workspace.repair.due_at = pending_optional_string(payload, "due_at", 64)?;
                workspace.repair.status = "received".to_string();
                workspace.repair.updated_at = occurred_at.to_string();
            }
            "assign_repair" => {
                let payload = pending_payload(operation)?;
                workspace.repair.assigned_staff_id =
                    pending_optional_string(payload, "assigned_staff_id", 36)?;
                workspace.repair.updated_at = occurred_at.to_string();
            }
            "update_diagnosis" => {
                let payload = pending_payload(operation)?;
                if payload.get("draft").and_then(serde_json::Value::as_bool) != Some(true) {
                    return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
                }
                workspace.repair.diagnosis = pending_optional_string(payload, "diagnosis", 8_000)?;
                workspace.repair.updated_at = occurred_at.to_string();
            }
            "plan_line" => {
                let payload = pending_payload(operation)?;
                let line_type = pending_string(payload, "line_type", 16)?;
                if !matches!(line_type.as_str(), "part" | "labour" | "charge") {
                    return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
                }
                let line_id = pending_string(payload, "line_id", 36)?;
                let display_order = payload
                    .get("display_order")
                    .and_then(serde_json::Value::as_u64)
                    .filter(|value| *value <= u64::from(u32::MAX))
                    .ok_or_else(|| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?;
                let quantity = pending_decimal(payload, "quantity")?;
                let unit_price_snapshot = pending_decimal(payload, "unit_price_snapshot")?;
                let vat_rate_snapshot = pending_decimal(payload, "vat_rate_snapshot")?;
                if quantity <= 0.0 || vat_rate_snapshot > 100.0 {
                    return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
                }
                let line = RepairLineSnapshot {
                    id: line_id.clone(),
                    line_type: line_type.clone(),
                    name_snapshot: pending_string(payload, "name_snapshot", 500)?,
                    sku_snapshot: pending_optional_string(payload, "sku_snapshot", 255)?,
                    description: pending_optional_string(payload, "description", 2_000)?,
                    quantity,
                    unit_price_snapshot,
                    vat_rate_snapshot,
                    retail_product_id: pending_optional_string(payload, "retail_product_id", 36)?,
                    retail_variant_id: pending_optional_string(payload, "retail_variant_id", 36)?,
                    service_id: pending_optional_string(payload, "service_id", 36)?,
                    part_state: (line_type == "part").then(|| "planned".to_string()),
                    display_order,
                    aggregate_version: expected_version + 1,
                    created_at: occurred_at.to_string(),
                    updated_at: occurred_at.to_string(),
                };
                if let Some(existing) = workspace.lines.iter_mut().find(|line| line.id == line_id) {
                    *existing = line;
                } else {
                    workspace.lines.push(line);
                    workspace.lines.sort_by(|left, right| {
                        left.display_order
                            .cmp(&right.display_order)
                            .then_with(|| left.id.cmp(&right.id))
                    });
                }
                workspace.repair.updated_at = occurred_at.to_string();
            }
            "transition_status" => {
                let payload = pending_payload(operation)?;
                let target = pending_string(payload, "target_status", 64)?;
                if !matches!(
                    target.as_str(),
                    "diagnosing"
                        | "waiting_customer_approval"
                        | "waiting_parts"
                        | "repairing"
                        | "quality_check"
                        | "ready"
                ) {
                    return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string());
                }
                workspace.repair.status = target;
                workspace.repair.updated_at = occurred_at.to_string();
            }
            // Notes and staged attachment metadata remain encrypted native
            // state. The renderer receives only their bounded pending marker.
            "add_note" | "stage_attachment" => {}
            _ => return Err("REPAIR_CACHE_DECRYPT_FAILED".to_string()),
        }
    }
    Ok(())
}

fn project_workspace(
    scope_token: &str,
    mut cached: crate::repairs::RepairCachedWorkspace,
) -> Result<RepairWorkspaceSnapshot, String> {
    let pending = pending_changes(&cached.pending_operations)?;
    let state = sync_state(&cached.row);
    let needs_refetch = cached.row.needs_refetch;
    if let Some(authoritative) = cached.authoritative.take() {
        let remote: RemoteWorkspace = serde_json::from_value(authoritative)
            .map_err(|_| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())?;
        let _ = remote.repair.origin_branch_id;
        let _ = &remote.aliases;
        let mut header = RepairWorkspaceHeaderSnapshot {
            id: remote.repair.id,
            display_number: remote
                .repair
                .display_number
                .unwrap_or_else(|| cached.row.display_number.clone()),
            status: cached.row.status.clone(),
            priority: cached.row.priority.clone(),
            title: remote.repair.title,
            intake_mode: cached.row.intake_mode.clone(),
            is_anonymous: remote.repair.is_anonymous,
            assigned_staff_id: remote.repair.assigned_staff_id,
            due_at: cached.row.due_at.clone(),
            completed_at: remote.repair.completed_at,
            delivered_at: remote.repair.delivered_at,
            version: cached.row.optimistic_version,
            created_at: remote.repair.created_at,
            updated_at: cached.row.updated_at.clone(),
            customer_id: remote.repair.customer_id,
            customer_device_id: remote.repair.customer_device_id,
            intake_notes: remote.repair.intake_notes,
            diagnosis: remote.repair.diagnosis,
            currency: remote.repair.currency,
            reopened_from_repair_id: remote.repair.reopened_from_repair_id,
        };
        let _ = (
            remote.repair.status,
            remote.repair.priority,
            remote.repair.intake_mode,
            remote.repair.due_at,
            remote.repair.version,
            remote.repair.updated_at,
        );
        header.display_number = cached.row.display_number.clone();
        let mut projection = RepairWorkspaceSnapshot {
            scope_token: scope_token.to_string(),
            source: if cached.row.dirty {
                "authoritative_with_local_changes"
            } else {
                "authoritative_cache"
            },
            repair: header,
            aliases: cached.row.aliases.clone(),
            customer: remote.customer.map(|customer| RepairCustomerSnapshot {
                id: customer.id,
                display_name: customer.display_name,
            }),
            device: remote.device.map(RepairDeviceSnapshot::from),
            lines: remote
                .lines
                .into_iter()
                .map(|line| RepairLineSnapshot {
                    id: line.id,
                    line_type: line.line_type,
                    name_snapshot: line.name_snapshot,
                    sku_snapshot: line.sku_snapshot,
                    description: line.description,
                    quantity: line.quantity,
                    unit_price_snapshot: line.unit_price_snapshot,
                    vat_rate_snapshot: line.vat_rate_snapshot,
                    retail_product_id: line.retail_product_id,
                    retail_variant_id: line.retail_variant_id,
                    service_id: line.service_id,
                    part_state: line.part_state,
                    display_order: line.display_order,
                    aggregate_version: line.aggregate_version,
                    created_at: line.created_at,
                    updated_at: line.updated_at,
                })
                .collect(),
            timeline: remote
                .events
                .into_iter()
                .map(|event| {
                    let (repair_line_id, movement_id) =
                        safe_consumption_references(&event.event_type, &event.payload);
                    RepairTimelineEventSnapshot {
                        id: event.id,
                        aggregate_version: event.aggregate_version,
                        event_type: event.event_type,
                        repair_line_id,
                        movement_id,
                        occurred_at: event.occurred_at,
                        created_at: event.created_at,
                    }
                })
                .collect(),
            estimates: remote
                .estimates
                .into_iter()
                .map(|estimate| RepairEstimateSnapshot {
                    id: estimate.id,
                    version: estimate.version,
                    supersedes_estimate_id: estimate.supersedes_estimate_id,
                    currency: estimate.currency,
                    subtotal_amount: estimate.subtotal_amount,
                    discount_amount: estimate.discount_amount,
                    tax_amount: estimate.tax_amount,
                    total_amount: estimate.total_amount,
                    valid_until: estimate.valid_until,
                    note: estimate.note,
                    aggregate_version: estimate.aggregate_version,
                    issued_at: estimate.issued_at,
                    created_at: estimate.created_at,
                })
                .collect(),
            estimate_lines: remote
                .estimate_lines
                .into_iter()
                .map(|line| RepairEstimateLineSnapshot {
                    id: line.id,
                    estimate_id: line.estimate_id,
                    estimate_version: line.estimate_version,
                    repair_line_id: line.repair_line_id,
                    line_type: line.line_type,
                    description: line.description,
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    tax_rate: line.tax_rate,
                    subtotal_amount: line.subtotal_amount,
                    tax_amount: line.tax_amount,
                    total_amount: line.total_amount,
                    display_order: line.display_order,
                    aggregate_version: line.aggregate_version,
                    created_at: line.created_at,
                })
                .collect(),
            approvals: remote
                .approvals
                .into_iter()
                .map(|approval| {
                    let _ = approval.customer_id;
                    RepairApprovalSnapshot {
                        id: approval.id,
                        estimate_id: approval.estimate_id,
                        estimate_version: approval.estimate_version,
                        decision: approval.decision,
                        decision_source: approval.decision_source,
                        currency: approval.currency,
                        approved_total_amount: approval.approved_total_amount,
                        note: approval.note,
                        decided_at: approval.decided_at,
                        aggregate_version: approval.aggregate_version,
                        created_at: approval.created_at,
                    }
                })
                .collect(),
            capabilities: remote.capabilities,
            allowed_transitions: remote.allowed_transitions,
            pending_changes: pending,
            sync_state: state,
            needs_refetch,
        };
        reduce_pending_workspace(&mut projection, &cached.pending_operations)?;
        return Ok(projection);
    }
    let mut projection = RepairWorkspaceSnapshot {
        scope_token: scope_token.to_string(),
        source: "local_offline",
        repair: offline_header(&cached)?,
        aliases: cached.row.aliases.clone(),
        customer: None,
        device: None,
        lines: Vec::new(),
        timeline: Vec::new(),
        estimates: Vec::new(),
        estimate_lines: Vec::new(),
        approvals: Vec::new(),
        capabilities: fail_closed_capabilities(),
        allowed_transitions: Vec::new(),
        pending_changes: pending,
        sync_state: state,
        needs_refetch,
    };
    reduce_pending_workspace(&mut projection, &cached.pending_operations)?;
    Ok(projection)
}

fn online_command(command: RepairCommand) -> crate::repair_transport::RepairTypedCommand {
    use crate::repair_transport::{RepairEstimateLineInput, RepairTypedCommand};
    match command {
        RepairCommand::CreateIntake {
            intake_mode,
            is_anonymous,
            customer_id,
            customer_device_id,
            priority,
            currency,
            title,
            intake_notes,
            due_at,
        } => RepairTypedCommand::CreateIntake {
            intake_mode,
            is_anonymous,
            customer_id,
            customer_device_id,
            priority,
            currency,
            title,
            intake_notes,
            due_at,
            offline_alias: None,
            offline_sequence: None,
        },
        RepairCommand::ReopenRepair { source_repair_id } => {
            RepairTypedCommand::ReopenRepair { source_repair_id }
        }
        RepairCommand::AddNote { note, visibility } => {
            RepairTypedCommand::AddNote { note, visibility }
        }
        RepairCommand::AssignRepair { assigned_staff_id } => {
            RepairTypedCommand::AssignRepair { assigned_staff_id }
        }
        RepairCommand::UpdateDiagnosis { diagnosis, draft } => {
            RepairTypedCommand::UpdateDiagnosis { diagnosis, draft }
        }
        RepairCommand::PlanLine {
            line_id,
            line_type,
            name_snapshot,
            sku_snapshot,
            description,
            quantity,
            unit_cost_snapshot,
            unit_price_snapshot,
            vat_rate_snapshot,
            retail_product_id,
            retail_variant_id,
            service_id,
            display_order,
        } => RepairTypedCommand::PlanLine {
            line_id,
            line_type,
            name_snapshot,
            sku_snapshot,
            description,
            quantity,
            unit_cost_snapshot,
            unit_price_snapshot,
            vat_rate_snapshot,
            retail_product_id,
            retail_variant_id,
            service_id,
            display_order,
        },
        RepairCommand::ConsumeNonstockPart { line_id } => {
            RepairTypedCommand::ConsumeNonstockPart { line_id }
        }
        RepairCommand::ReverseNonstockPart { line_id, reason } => {
            RepairTypedCommand::ReverseNonstockPart { line_id, reason }
        }
        RepairCommand::ConsumeRepairPart { line_id } => {
            RepairTypedCommand::ConsumeRepairPart { line_id }
        }
        RepairCommand::ReverseRepairPart {
            line_id,
            original_movement_id,
        } => RepairTypedCommand::ReverseRepairPart {
            line_id,
            original_movement_id,
        },
        RepairCommand::CreateEstimate {
            estimate_id,
            currency,
            discount_amount,
            valid_until,
            note,
            lines,
        } => RepairTypedCommand::CreateEstimate {
            estimate_id,
            currency,
            discount_amount,
            valid_until,
            note,
            lines: lines
                .into_iter()
                .map(|line| RepairEstimateLineInput {
                    id: line.id,
                    repair_line_id: line.repair_line_id,
                    line_type: line.line_type,
                    description: line.description,
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    tax_rate: line.tax_rate,
                    display_order: line.display_order,
                })
                .collect(),
        },
        RepairCommand::RecordApproval {
            approval_id,
            estimate_id,
            decision,
            decision_source,
            reason,
        } => RepairTypedCommand::RecordApproval {
            approval_id,
            estimate_id,
            decision,
            decision_source,
            reason,
        },
        RepairCommand::TransitionStatus {
            target_status,
            reason,
            remain_consumed,
        } => RepairTypedCommand::TransitionStatus {
            target_status,
            reason,
            remain_consumed,
        },
        RepairCommand::TransferBranch {
            destination_branch_id,
        } => RepairTypedCommand::TransferBranch {
            destination_branch_id,
        },
    }
}

fn required_permission_for_command(command: &RepairCommand) -> &'static str {
    match command {
        RepairCommand::CreateIntake { .. } | RepairCommand::ReopenRepair { .. } => "repairs.create",
        RepairCommand::RecordApproval { .. } => "repairs.approve",
        RepairCommand::ConsumeNonstockPart { .. }
        | RepairCommand::ReverseNonstockPart { .. }
        | RepairCommand::ConsumeRepairPart { .. }
        | RepairCommand::ReverseRepairPart { .. } => "repairs.stock",
        RepairCommand::TransitionStatus { target_status, .. } if target_status == "cancelled" => {
            "repairs.cancel"
        }
        RepairCommand::TransferBranch { .. } => "repairs.transfer",
        RepairCommand::AddNote { .. }
        | RepairCommand::AssignRepair { .. }
        | RepairCommand::UpdateDiagnosis { .. }
        | RepairCommand::PlanLine { .. }
        | RepairCommand::CreateEstimate { .. }
        | RepairCommand::TransitionStatus { .. } => "repairs.update",
    }
}

fn offline_command(command: RepairCommand) -> Option<crate::repairs::RepairOfflineCommand> {
    use crate::repairs::RepairOfflineCommand;
    match command {
        RepairCommand::CreateIntake {
            intake_mode,
            is_anonymous,
            customer_id,
            customer_device_id,
            priority,
            currency,
            title,
            intake_notes,
            due_at,
        } => Some(RepairOfflineCommand::CreateIntake {
            intake_mode,
            is_anonymous,
            customer_id,
            customer_device_id,
            priority,
            currency,
            title,
            intake_notes,
            due_at,
            offline_alias: None,
            offline_sequence: None,
        }),
        RepairCommand::AddNote { note, visibility } => {
            Some(RepairOfflineCommand::AddNote { note, visibility })
        }
        RepairCommand::AssignRepair { assigned_staff_id } => {
            Some(RepairOfflineCommand::AssignRepair { assigned_staff_id })
        }
        RepairCommand::UpdateDiagnosis { diagnosis, draft } if draft => {
            Some(RepairOfflineCommand::UpdateDiagnosis { diagnosis, draft })
        }
        RepairCommand::PlanLine {
            line_id,
            line_type,
            name_snapshot,
            sku_snapshot,
            description,
            quantity,
            unit_cost_snapshot,
            unit_price_snapshot,
            vat_rate_snapshot,
            retail_product_id,
            retail_variant_id,
            service_id,
            display_order,
        } => Some(RepairOfflineCommand::PlanLine {
            line_id,
            line_type,
            name_snapshot,
            sku_snapshot,
            description,
            quantity,
            unit_cost_snapshot,
            unit_price_snapshot,
            vat_rate_snapshot,
            retail_product_id,
            retail_variant_id,
            service_id,
            display_order: u64::from(display_order),
        }),
        RepairCommand::TransitionStatus {
            target_status,
            reason,
            remain_consumed,
        } if matches!(
            target_status.as_str(),
            "diagnosing"
                | "waiting_customer_approval"
                | "waiting_parts"
                | "repairing"
                | "quality_check"
                | "ready"
        ) =>
        {
            Some(RepairOfflineCommand::TransitionStatus {
                target_status,
                reason,
                remain_consumed,
            })
        }
        RepairCommand::ReopenRepair { .. }
        | RepairCommand::ConsumeNonstockPart { .. }
        | RepairCommand::ReverseNonstockPart { .. }
        | RepairCommand::ConsumeRepairPart { .. }
        | RepairCommand::ReverseRepairPart { .. }
        | RepairCommand::CreateEstimate { .. }
        | RepairCommand::RecordApproval { .. }
        | RepairCommand::TransferBranch { .. }
        | RepairCommand::UpdateDiagnosis { .. }
        | RepairCommand::TransitionStatus { .. } => None,
    }
}

fn acquire_access(
    db: &crate::db::DbState,
    staff_session_id: &str,
    required_permission: &str,
) -> Result<crate::repairs::RepairRendererAccess, String> {
    let connection = db
        .conn
        .lock()
        .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
    let access = crate::repairs::acquire_renderer_access(&connection)?;
    crate::repairs::validate_renderer_staff_session(
        &connection,
        &access,
        staff_session_id,
        required_permission,
    )?;
    Ok(access)
}

fn emit_cache_changed(
    app: &tauri::AppHandle,
    scope_token: &str,
    repair_id: Option<String>,
    reason: &'static str,
) {
    let _ = app.emit(
        "repairs:cache-changed",
        RepairCacheChangedEvent {
            scope_token: scope_token.to_string(),
            repair_id,
            reason,
        },
    );
}

fn emit_conflict(app: &tauri::AppHandle, scope_token: &str, conflict: RepairConflictSnapshot) {
    let _ = app.emit(
        "repairs:conflict",
        RepairConflictEvent {
            scope_token: scope_token.to_string(),
            conflict,
        },
    );
}

fn can_fallback_to_local(error: &str) -> bool {
    matches!(
        error,
        "REPAIR_ONLINE_REQUEST_FAILED"
            | "REPAIR_NATIVE_ENDPOINT_UNAVAILABLE"
            | "REPAIR_NATIVE_API_KEY_UNAVAILABLE"
            | "REPAIR_HTTP_CLIENT_UNAVAILABLE"
    )
}

enum ReadDisposition {
    Authoritative(serde_json::Value),
    LocalFallback,
}

async fn read_disposition(
    db: tauri::State<'_, crate::db::DbState>,
    staff_session_id: String,
    request: crate::repair_transport::RepairJsonRequest,
) -> Result<ReadDisposition, String> {
    use crate::repair_transport::RepairJsonDisposition;
    let response = crate::repair_transport::repair_json_request(
        db,
        crate::repair_transport::RepairJsonTransportInput {
            staff_session_id,
            request,
        },
    )
    .await;
    match response {
        Ok(RepairJsonDisposition::Success { data, .. }) => Ok(ReadDisposition::Authoritative(data)),
        Ok(RepairJsonDisposition::RetryableFailure { .. })
        | Ok(RepairJsonDisposition::RateLimited { .. }) => Ok(ReadDisposition::LocalFallback),
        Ok(RepairJsonDisposition::SessionRequired { error })
        | Ok(RepairJsonDisposition::ModuleRequired { error })
        | Ok(RepairJsonDisposition::PermanentFailure { error, .. }) => Err(error.code),
        Ok(RepairJsonDisposition::Conflict { .. }) => Err("REPAIR_UNEXPECTED_CONFLICT".to_string()),
        Ok(RepairJsonDisposition::MalformedResponse) => {
            Err("REPAIR_MALFORMED_RESPONSE".to_string())
        }
        Err(error) if can_fallback_to_local(&error) => Ok(ReadDisposition::LocalFallback),
        Err(error) => Err(error),
    }
}

async fn required_online_data(
    db: tauri::State<'_, crate::db::DbState>,
    staff_session_id: String,
    request: crate::repair_transport::RepairJsonRequest,
) -> Result<serde_json::Value, String> {
    use crate::repair_transport::RepairJsonDisposition;
    match crate::repair_transport::repair_json_request(
        db,
        crate::repair_transport::RepairJsonTransportInput {
            staff_session_id,
            request,
        },
    )
    .await?
    {
        RepairJsonDisposition::Success { data, .. } => Ok(data),
        RepairJsonDisposition::SessionRequired { error }
        | RepairJsonDisposition::ModuleRequired { error }
        | RepairJsonDisposition::PermanentFailure { error, .. }
        | RepairJsonDisposition::RetryableFailure { error, .. } => Err(error.code),
        RepairJsonDisposition::RateLimited { .. } => Err("REPAIR_RATE_LIMITED".to_string()),
        RepairJsonDisposition::Conflict { .. } => Err("REPAIR_UNEXPECTED_CONFLICT".to_string()),
        RepairJsonDisposition::MalformedResponse => Err("REPAIR_MALFORMED_RESPONSE".to_string()),
    }
}

/// Online-only repair money boundary. The native request enum owns the exact
/// route, body, staff-session attribution, permission and response projection;
/// the renderer cannot turn this command into a generic POS proxy.
fn is_money_request(request: &crate::repair_transport::RepairJsonRequest) -> bool {
    matches!(
        request,
        crate::repair_transport::RepairJsonRequest::FinancialProjection { .. }
            | crate::repair_transport::RepairJsonRequest::Settlement { .. }
            | crate::repair_transport::RepairJsonRequest::Payment { .. }
            | crate::repair_transport::RepairJsonRequest::Refund { .. }
            | crate::repair_transport::RepairJsonRequest::Fiscalize { .. }
            | crate::repair_transport::RepairJsonRequest::Delivery { .. }
    )
}

#[tauri::command]
pub(crate) async fn repairs_money_request(
    db: tauri::State<'_, crate::db::DbState>,
    input: crate::repair_transport::RepairJsonTransportInput,
) -> Result<serde_json::Value, String> {
    if !is_money_request(&input.request) {
        return Err("REPAIR_MONEY_REQUEST_INVALID".to_string());
    }
    required_online_data(db, input.staff_session_id, input.request).await
}

#[tauri::command]
pub(crate) async fn repairs_list(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairListInput,
) -> Result<RepairListSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    let source = match read_disposition(
        db.clone(),
        input.staff_session_id.clone(),
        crate::repair_transport::RepairJsonRequest::List {
            status: input.status.clone(),
            search: input.search.clone(),
            limit: input.limit,
            offset: input.offset,
        },
    )
    .await?
    {
        ReadDisposition::Authoritative(value) => {
            let connection = db
                .conn
                .lock()
                .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
            crate::repairs::cache_authoritative_list(&connection, &access, &value)?;
            emit_cache_changed(&app, access.scope_token(), None, "authoritative_list");
            "authoritative_cache"
        }
        ReadDisposition::LocalFallback => "local_cache",
    };
    let (rows, count) = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::read_cached_list(
            &connection,
            &access,
            input.status.as_deref(),
            input.search.as_deref(),
            input.limit,
            input.offset,
        )?
    };
    Ok(RepairListSnapshot {
        scope_token: access.scope_token().to_string(),
        source,
        repairs: rows.into_iter().map(project_list_row).collect(),
        pagination: RepairPaginationSnapshot {
            count,
            limit: input.limit,
            offset: input.offset,
        },
    })
}

#[tauri::command]
pub(crate) async fn repairs_workspace(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairWorkspaceInput,
) -> Result<RepairWorkspaceSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    if let ReadDisposition::Authoritative(value) = read_disposition(
        db.clone(),
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::Workspace {
            repair_id: input.repair_id.clone(),
        },
    )
    .await?
    {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::cache_authoritative_workspace(
            &connection,
            &access,
            &input.repair_id,
            &value,
        )?;
        emit_cache_changed(
            &app,
            access.scope_token(),
            Some(input.repair_id.clone()),
            "authoritative_workspace",
        );
    }
    let cached = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::read_cached_workspace(&connection, &access, &input.repair_id)?
    };
    project_workspace(access.scope_token(), cached)
}

#[tauri::command]
pub(crate) async fn repairs_settings(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairSettingsInput,
) -> Result<RepairSettingsSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    let source = match read_disposition(
        db.clone(),
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::Settings,
    )
    .await?
    {
        ReadDisposition::Authoritative(value) => {
            let connection = db
                .conn
                .lock()
                .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
            crate::repairs::cache_authoritative_settings(&connection, &access, &value)?;
            "authoritative_cache"
        }
        ReadDisposition::LocalFallback => "local_cache",
    };
    let value = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::read_authoritative_settings(&connection, &access)?
    };
    let remote: RemoteSettingsResponse =
        serde_json::from_value(value).map_err(|_| "REPAIR_SETTINGS_CACHE_CORRUPT".to_string())?;
    Ok(RepairSettingsSnapshot {
        scope_token: access.scope_token().to_string(),
        source,
        settings: remote.settings.into(),
        capabilities: remote.capabilities,
    })
}

#[tauri::command]
pub(crate) async fn repairs_search_customers(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairCustomerSearchInput,
) -> Result<RepairCustomerSearchSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    let data = required_online_data(
        db,
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::Customers {
            search: input.search,
            limit: input.limit,
            offset: input.offset,
        },
    )
    .await?;
    let remote: RemoteCustomerSearchResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
    Ok(RepairCustomerSearchSnapshot {
        scope_token: access.scope_token().to_string(),
        customers: remote
            .customers
            .into_iter()
            .map(|customer| RepairCustomerSnapshot {
                id: customer.id,
                display_name: customer.name,
            })
            .collect(),
        pagination: RepairPaginationSnapshot {
            count: remote.pagination.count,
            limit: remote.pagination.limit,
            offset: remote.pagination.offset,
        },
    })
}

#[tauri::command]
pub(crate) async fn repairs_customer_devices(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairCustomerDevicesInput,
) -> Result<RepairCustomerDevicesSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    let data = required_online_data(
        db,
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::CustomerDevices {
            customer_id: input.customer_id,
        },
    )
    .await?;
    let remote: RemoteDevicesResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
    Ok(RepairCustomerDevicesSnapshot {
        scope_token: access.scope_token().to_string(),
        devices: remote.devices.into_iter().map(Into::into).collect(),
    })
}

#[tauri::command]
pub(crate) async fn repairs_create_customer_device(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairCreateCustomerDeviceInput,
) -> Result<RepairCustomerDevicesSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.create")?;
    let data = required_online_data(
        db,
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::CreateCustomerDevice {
            customer_id: input.customer_id,
            device_id: input.device_id,
            label: input.label,
            device_type: input.device_type,
            manufacturer: input.manufacturer,
            model: input.model,
            variant: input.variant,
            storage_capacity: input.storage_capacity,
            color: input.color,
        },
    )
    .await?;
    let remote: RemoteDeviceResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
    Ok(RepairCustomerDevicesSnapshot {
        scope_token: access.scope_token().to_string(),
        devices: vec![remote.device.into()],
    })
}

enum CommandDisposition {
    Authoritative(serde_json::Value),
    Conflict(crate::repair_transport::RepairConflictProjection),
    OfflineFallback,
}

async fn command_disposition(
    db: tauri::State<'_, crate::db::DbState>,
    staff_session_id: String,
    request: crate::repair_transport::RepairJsonRequest,
) -> Result<CommandDisposition, String> {
    use crate::repair_transport::RepairJsonDisposition;
    let response = crate::repair_transport::repair_json_request(
        db,
        crate::repair_transport::RepairJsonTransportInput {
            staff_session_id,
            request,
        },
    )
    .await;
    match response {
        Ok(RepairJsonDisposition::Success { data, .. }) => {
            Ok(CommandDisposition::Authoritative(data))
        }
        Ok(RepairJsonDisposition::Conflict { conflict }) => {
            Ok(CommandDisposition::Conflict(conflict))
        }
        Ok(RepairJsonDisposition::RetryableFailure { .. })
        | Ok(RepairJsonDisposition::RateLimited { .. }) => Ok(CommandDisposition::OfflineFallback),
        Ok(RepairJsonDisposition::SessionRequired { error })
        | Ok(RepairJsonDisposition::ModuleRequired { error })
        | Ok(RepairJsonDisposition::PermanentFailure { error, .. }) => Err(error.code),
        Ok(RepairJsonDisposition::MalformedResponse) => {
            Err("REPAIR_MALFORMED_RESPONSE".to_string())
        }
        Err(error) if can_fallback_to_local(&error) => Ok(CommandDisposition::OfflineFallback),
        Err(error) => Err(error),
    }
}

fn apply_offline_renderer_command(
    app: &tauri::AppHandle,
    db: &crate::db::DbState,
    access: &crate::repairs::RepairRendererAccess,
    input: &RepairExecuteCommandInput,
    command: crate::repairs::RepairOfflineCommand,
) -> Result<RepairCommandSnapshot, String> {
    let snapshot = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::apply_offline_mutation(
            &connection,
            &crate::repairs::RepairOfflineMutationInput {
                operation_id: input.operation_id.clone(),
                repair_id: input.repair_id.clone(),
                expected_version: input.expected_version,
                staff_session_id: input.staff_session_id.clone(),
                occurred_at: input.occurred_at.clone(),
                command,
            },
        )?
    };
    if snapshot.scope_token != access.scope_token() {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    emit_cache_changed(
        app,
        &snapshot.scope_token,
        Some(snapshot.repair_id.clone()),
        "offline_command_queued",
    );
    Ok(RepairCommandSnapshot::Applied {
        scope_token: snapshot.scope_token,
        repair_id: snapshot.repair_id,
        display_number: Some(snapshot.display_number),
        status: snapshot.status,
        version: snapshot.optimistic_version,
        queued_for_sync: snapshot.queued_for_sync,
        customer_notification_state: snapshot.customer_notification_state,
    })
}

#[tauri::command]
pub(crate) async fn repairs_execute_command(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairExecuteCommandInput,
) -> Result<RepairCommandSnapshot, String> {
    let _producer_guard = crate::repairs::acquire_renderer_producer_guard().await;
    let required_permission = required_permission_for_command(&input.command);
    let access = acquire_access(&db, &input.staff_session_id, required_permission)?;
    let offline_candidate = offline_command(input.command.clone());
    let preflight = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::repair_command_preflight(
            &connection,
            &access,
            &input.repair_id,
            input.expected_version,
        )?
    };
    if preflight == crate::repairs::RepairCommandPreflight::PendingPredecessor {
        let command = offline_candidate
            .clone()
            .ok_or_else(|| "REPAIR_COMMAND_PENDING_SYNC".to_string())?;
        return apply_offline_renderer_command(&app, &db, &access, &input, command);
    }
    let response = command_disposition(
        db.clone(),
        input.staff_session_id.clone(),
        crate::repair_transport::RepairJsonRequest::Command {
            repair_id: input.repair_id.clone(),
            operation_id: input.operation_id.clone(),
            expected_version: input.expected_version,
            occurred_at: input.occurred_at.clone(),
            command: online_command(input.command.clone()),
        },
    )
    .await?;
    match response {
        CommandDisposition::Authoritative(data) => {
            let signal: RemoteCommandSignal = serde_json::from_value(data)
                .map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
            {
                let connection = db
                    .conn
                    .lock()
                    .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
                crate::repairs::apply_authoritative_command_signal(
                    &connection,
                    &access,
                    &signal.repair_id,
                    input.expected_version,
                    &signal.status,
                    signal.version,
                )?;
            }
            emit_cache_changed(
                &app,
                access.scope_token(),
                Some(signal.repair_id.clone()),
                "authoritative_command",
            );
            let notification_state = if signal.status == "ready" {
                "server_event_pending"
            } else {
                "not_requested"
            };
            Ok(RepairCommandSnapshot::Applied {
                scope_token: access.scope_token().to_string(),
                repair_id: signal.repair_id,
                display_number: None,
                status: signal.status,
                version: signal.version,
                queued_for_sync: false,
                customer_notification_state: notification_state,
            })
        }
        CommandDisposition::Conflict(conflict) => {
            let conflict = if let Some(command) = offline_candidate {
                let record = {
                    let connection = db
                        .conn
                        .lock()
                        .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
                    crate::repairs::park_direct_command_conflict(
                        &connection,
                        &access,
                        &crate::repairs::RepairOfflineMutationInput {
                            operation_id: input.operation_id.clone(),
                            repair_id: input.repair_id.clone(),
                            expected_version: input.expected_version,
                            staff_session_id: input.staff_session_id.clone(),
                            occurred_at: input.occurred_at.clone(),
                            command,
                        },
                        &conflict,
                    )?
                };
                project_conflict_record(record)
            } else {
                project_transport_conflict(conflict)
            };
            emit_conflict(&app, access.scope_token(), conflict.clone());
            Ok(RepairCommandSnapshot::Conflict {
                scope_token: access.scope_token().to_string(),
                conflict,
            })
        }
        CommandDisposition::OfflineFallback => {
            let command =
                offline_candidate.ok_or_else(|| "REPAIR_COMMAND_ONLINE_REQUIRED".to_string())?;
            apply_offline_renderer_command(&app, &db, &access, &input, command)
        }
    }
}

#[tauri::command]
pub(crate) async fn repairs_stage_attachment(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairStageAttachmentInput,
) -> Result<RepairStageAttachmentSnapshot, String> {
    let _producer_guard = crate::repairs::acquire_renderer_producer_guard().await;
    let access = acquire_access(&db, &input.staff_session_id, "repairs.attachments")?;
    let native_input = crate::repairs::RepairAttachmentStageInput {
        attachment_id: input.attachment_id,
        operation_id: input.operation_id,
        repair_id: input.repair_id,
        expected_version: input.expected_version,
        staff_session_id: input.staff_session_id,
        occurred_at: input.occurred_at,
        attachment_type: input.attachment_type,
        filename: input.filename,
        caption: input.caption,
        mime_type: input.mime_type,
        bytes: input.bytes,
    };
    let snapshot = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::stage_attachment(&connection, &native_input)?
    };
    if snapshot.scope_token != access.scope_token() {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    emit_cache_changed(
        &app,
        &snapshot.scope_token,
        Some(snapshot.repair_id.clone()),
        "attachment_queued",
    );
    Ok(RepairStageAttachmentSnapshot {
        scope_token: snapshot.scope_token,
        repair_id: snapshot.repair_id,
        attachment_id: snapshot.attachment_id,
        optimistic_version: snapshot.optimistic_version,
        queued_for_sync: snapshot.queued_for_sync,
    })
}

#[tauri::command]
pub(crate) async fn repairs_list_attachments(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairListAttachmentsInput,
) -> Result<RepairAttachmentsSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.attachments")?;
    let data = required_online_data(
        db,
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::Attachments {
            repair_id: input.repair_id.clone(),
        },
    )
    .await?;
    let remote: RemoteAttachmentsResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
    Ok(RepairAttachmentsSnapshot {
        scope_token: access.scope_token().to_string(),
        repair_id: input.repair_id,
        attachments: remote
            .attachments
            .into_iter()
            .map(|attachment| RepairAttachmentSnapshot {
                id: attachment.id,
                attachment_type: attachment.attachment_type,
                retention_state: attachment.retention_state,
                mime_type: attachment.mime_type,
                byte_size: attachment.byte_size,
                created_at: attachment.created_at,
            })
            .collect(),
    })
}

#[tauri::command]
pub(crate) async fn repairs_open_attachment(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairOpenAttachmentInput,
) -> Result<RepairOpenAttachmentSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.attachments")?;
    let attachment_cache_generation = crate::repair_attachment_cache::generation();
    let data = required_online_data(
        db.clone(),
        input.staff_session_id.clone(),
        crate::repair_transport::RepairJsonRequest::Attachments {
            repair_id: input.repair_id.clone(),
        },
    )
    .await?;
    let remote: RemoteAttachmentsResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
    let mut matching = remote
        .attachments
        .into_iter()
        .filter(|attachment| attachment.id == input.attachment_id);
    let attachment = matching
        .next()
        .ok_or_else(|| "REPAIR_ATTACHMENT_NOT_FOUND".to_string())?;
    if matching.next().is_some() {
        return Err("REPAIR_MALFORMED_RESPONSE".to_string());
    }
    let downloaded = crate::repair_transport::repair_binary_request(
        db,
        crate::repair_transport::RepairBinaryTransportInput {
            staff_session_id: input.staff_session_id,
            request: crate::repair_transport::RepairBinaryRequest::Attachment {
                repair_id: input.repair_id,
                attachment_id: input.attachment_id.clone(),
                mime_type: attachment.mime_type,
                byte_size: attachment.byte_size,
            },
        },
    )
    .await?;
    let opened = crate::repair_attachment_cache::store_and_open(
        attachment_cache_generation,
        access.scope_token(),
        &input.attachment_id,
        &downloaded.mime_type,
        &downloaded.bytes,
    )?;
    Ok(RepairOpenAttachmentSnapshot {
        scope_token: access.scope_token().to_string(),
        attachment_id: input.attachment_id,
        opened,
    })
}

#[tauri::command]
pub(crate) async fn repairs_list_conflicts(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairListConflictsInput,
) -> Result<RepairConflictsSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    let conflicts = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::list_open_conflicts(&connection, &access)?
    };
    Ok(RepairConflictsSnapshot {
        scope_token: access.scope_token().to_string(),
        conflicts: conflicts.into_iter().map(project_conflict_record).collect(),
    })
}

#[tauri::command]
pub(crate) async fn repairs_resolve_conflict(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairResolveConflictInput,
) -> Result<RepairConflictResolutionSnapshot, String> {
    let _producer_guard = crate::repairs::acquire_renderer_producer_guard().await;
    let access = acquire_access(&db, &input.staff_session_id, "repairs.update")?;
    let resolved = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        match input.resolution {
            RepairConflictResolution::AcceptServer => {
                crate::repairs::accept_server_conflict(&connection, &access, &input.conflict_id)?
            }
            RepairConflictResolution::Rebase => {
                crate::repairs::rebase_repair_conflict(&connection, &access, &input.conflict_id)?
            }
        }
    };
    emit_cache_changed(
        &app,
        access.scope_token(),
        Some(resolved.repair_id.clone()),
        "conflict_resolved",
    );
    Ok(RepairConflictResolutionSnapshot {
        scope_token: access.scope_token().to_string(),
        repair_id: resolved.repair_id,
        state: resolved.state,
        optimistic_version: resolved.optimistic_version,
        needs_refetch: resolved.needs_refetch,
    })
}

#[tauri::command]
pub(crate) async fn repairs_print_projection(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairPrintInput,
) -> Result<RepairPrintSnapshot, String> {
    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    let data = required_online_data(
        db,
        input.staff_session_id,
        crate::repair_transport::RepairJsonRequest::PrintProjection {
            repair_id: input.repair_id,
        },
    )
    .await?;
    let remote: RemotePrintResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;
    Ok(RepairPrintSnapshot {
        scope_token: access.scope_token().to_string(),
        kind: input.kind,
        projection: remote.projection,
    })
}

#[tauri::command]
pub(crate) async fn repairs_enqueue_print(
    db: tauri::State<'_, crate::db::DbState>,
    app: tauri::AppHandle,
    input: RepairEnqueuePrintInput,
) -> Result<RepairEnqueuePrintSnapshot, String> {
    use tauri::Manager;

    let access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    if input.scope_token != access.scope_token() {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }

    // Fetch inside the native boundary so the renderer can never author or
    // alter customer/device content placed in the managed print queue.
    let data = required_online_data(
        db.clone(),
        input.staff_session_id.clone(),
        crate::repair_transport::RepairJsonRequest::PrintProjection {
            repair_id: input.repair_id.clone(),
        },
    )
    .await?;
    let remote: RemotePrintResponse =
        serde_json::from_value(data).map_err(|_| "REPAIR_MALFORMED_RESPONSE".to_string())?;

    // A terminal/org/branch rebind can happen while the HTTP request is in
    // flight. Re-acquire access before touching local state or the print queue.
    let current_access = acquire_access(&db, &input.staff_session_id, "repairs.read")?;
    if input.scope_token != current_access.scope_token()
        || access.scope_token() != current_access.scope_token()
    {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        crate::repairs::read_cached_workspace(&connection, &current_access, &input.repair_id)?;
    }
    let (entity_type, payload) = build_safe_repair_print_payload(input.kind, &remote.projection)?;
    let result = crate::print::enqueue_print_job_with_payload(
        &db,
        entity_type,
        &input.repair_id,
        None,
        Some(&payload),
        &app,
    )?;
    let job_id = result
        .get("jobId")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| {
            uuid::Uuid::parse_str(value)
                .ok()
                .map(|parsed| parsed.hyphenated().to_string())
                .filter(|normalized| normalized == value)
        })
        .ok_or_else(|| "REPAIR_PRINT_QUEUE_FAILED".to_string())?;
    if let Ok(data_dir) = app.path().app_data_dir() {
        crate::print::spawn_pending_job_processing(
            app.clone(),
            data_dir,
            format!("repair print job {job_id}"),
        );
    }
    Ok(RepairEnqueuePrintSnapshot {
        scope_token: access.scope_token().to_string(),
        repair_id: input.repair_id,
        kind: input.kind,
        job_id,
        queued: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_REPAIR_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TEST_CUSTOMER_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const TEST_DEVICE_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const TEST_STAFF_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const TEST_LINE_ID: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    fn pending_operation(
        operation_id: &str,
        expected_version: u64,
        command: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "operation_id": operation_id,
            "repair_id": TEST_REPAIR_ID,
            "expected_version": expected_version,
            "staff_session_id": "11111111-1111-4111-8111-111111111111",
            "command": command,
            "payload": payload,
            "occurred_at": format!("2026-08-26T10:00:0{expected_version}.000Z"),
        })
    }

    fn cached_workspace(
        authoritative: Option<serde_json::Value>,
        pending_operations: Vec<serde_json::Value>,
        has_conflict: bool,
    ) -> crate::repairs::RepairCachedWorkspace {
        crate::repairs::RepairCachedWorkspace {
            row: crate::repairs::RepairCachedListRow {
                repair_id: TEST_REPAIR_ID.to_string(),
                display_number: "R-OFF-A9F0-000001".to_string(),
                aliases: vec!["R-OFF-A9F0-000001".to_string()],
                status: "ready".to_string(),
                priority: "urgent".to_string(),
                intake_mode: "standard".to_string(),
                safe_device_label: Some("Phone".to_string()),
                due_at: None,
                ready_at: Some("2026-08-26T10:00:04.000Z".to_string()),
                authoritative_version: if authoritative.is_some() { 2 } else { 0 },
                optimistic_version: pending_operations.len() as u64,
                dirty: !pending_operations.is_empty(),
                has_conflict,
                needs_refetch: has_conflict,
                created_at: "2026-08-26T10:00:00.000Z".to_string(),
                updated_at: "2026-08-26T10:00:05.000Z".to_string(),
            },
            authoritative,
            pending_operations,
        }
    }

    fn complete_pending_sequence() -> Vec<serde_json::Value> {
        vec![
            pending_operation(
                "10000000-0000-4000-8000-000000000000",
                0,
                "create_intake",
                serde_json::json!({
                    "intake_mode": "standard",
                    "is_anonymous": false,
                    "customer_id": TEST_CUSTOMER_ID,
                    "customer_device_id": TEST_DEVICE_ID,
                    "priority": "normal",
                    "currency": "EUR",
                    "title": "Screen replacement",
                    "intake_notes": "Visible authorized intake note",
                    "due_at": null,
                    "offline_alias": "R-OFF-A9F0-000001",
                    "offline_sequence": 1
                }),
            ),
            pending_operation(
                "20000000-0000-4000-8000-000000000000",
                1,
                "assign_repair",
                serde_json::json!({ "assigned_staff_id": TEST_STAFF_ID }),
            ),
            pending_operation(
                "30000000-0000-4000-8000-000000000000",
                2,
                "update_diagnosis",
                serde_json::json!({ "diagnosis": "Display cable", "draft": true }),
            ),
            pending_operation(
                "40000000-0000-4000-8000-000000000000",
                3,
                "plan_line",
                serde_json::json!({
                    "line_id": TEST_LINE_ID,
                    "line_type": "part",
                    "name_snapshot": "Display assembly",
                    "sku_snapshot": "DISPLAY-1",
                    "description": null,
                    "quantity": "1.5",
                    "unit_cost_snapshot": "10.00",
                    "unit_price_snapshot": "20.00",
                    "vat_rate_snapshot": "24",
                    "retail_product_id": null,
                    "retail_variant_id": null,
                    "service_id": null,
                    "display_order": 0
                }),
            ),
            pending_operation(
                "50000000-0000-4000-8000-000000000000",
                4,
                "transition_status",
                serde_json::json!({
                    "target_status": "ready",
                    "reason": null,
                    "remain_consumed": false
                }),
            ),
        ]
    }

    fn plan_line() -> RepairCommand {
        RepairCommand::PlanLine {
            line_id: "11111111-1111-4111-8111-111111111111".to_string(),
            line_type: "part".to_string(),
            name_snapshot: "Display assembly".to_string(),
            sku_snapshot: Some("DISPLAY-1".to_string()),
            description: None,
            quantity: "1".to_string(),
            unit_cost_snapshot: Some("10.00".to_string()),
            unit_price_snapshot: "20.00".to_string(),
            vat_rate_snapshot: "24".to_string(),
            retail_product_id: Some("22222222-2222-4222-8222-222222222222".to_string()),
            retail_variant_id: None,
            service_id: None,
            display_order: 0,
        }
    }

    #[test]
    fn timeline_projection_exposes_only_canonical_part_consumption_references() {
        let payload = serde_json::json!({
            "repair_line_id": TEST_LINE_ID,
            "movement_id": "99999999-9999-4999-8999-999999999999"
        });
        assert_eq!(
            safe_consumption_references("part_consumed", &payload),
            (
                Some(TEST_LINE_ID.to_string()),
                Some("99999999-9999-4999-8999-999999999999".to_string())
            )
        );
        assert_eq!(
            safe_consumption_references("note_added", &payload),
            (None, None)
        );
        assert_eq!(
            safe_consumption_references(
                "part_consumed",
                &serde_json::json!({
                    "repair_line_id": TEST_LINE_ID,
                    "movement_id": "not-a-movement-id"
                }),
            ),
            (None, None)
        );
    }

    #[test]
    fn repair_print_payload_is_normalized_and_amount_free() {
        let projection = RepairPrintProjectionSnapshot {
            projection_source: "repair_authorized_projection_v1".to_string(),
            projection_version: 1,
            projected_at: "2026-08-27T08:00:00.000Z".to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            repair_number: "R-ATH-26-000001".to_string(),
            safe_device_label: " Phone\n ".to_string(),
            received_at: "2026-08-27T08:00:00.000Z".to_string(),
            branch_name: "Athens".to_string(),
            customer_display_name: Some("Alex".to_string()),
            masked_identifier: Some("**** 1234".to_string()),
            due_at: None,
            branch_contact: Some("+30 210 000 0000".to_string()),
        };

        let (entity_type, payload) =
            build_safe_repair_print_payload(RepairPrintKind::RepairIntake, &projection)
                .expect("valid safe projection");
        assert_eq!(entity_type, "repair_intake");
        assert_eq!(payload["safe_device_label"], "Phone");
        assert!(payload.get("amount").is_none());
        assert!(payload.get("diagnosis").is_none());

        let mut invalid = projection;
        invalid.masked_identifier = Some("123456789012345".to_string());
        assert!(build_safe_repair_print_payload(RepairPrintKind::RepairLabel, &invalid).is_err());
    }

    #[test]
    fn offline_mapper_is_an_exact_fail_closed_allowlist() {
        let allowed = vec![
            RepairCommand::CreateIntake {
                intake_mode: "standard".to_string(),
                is_anonymous: false,
                customer_id: Some("33333333-3333-4333-8333-333333333333".to_string()),
                customer_device_id: Some("44444444-4444-4444-8444-444444444444".to_string()),
                priority: "normal".to_string(),
                currency: "EUR".to_string(),
                title: None,
                intake_notes: None,
                due_at: None,
            },
            RepairCommand::AddNote {
                note: "Internal note".to_string(),
                visibility: "internal".to_string(),
            },
            RepairCommand::AssignRepair {
                assigned_staff_id: None,
            },
            RepairCommand::UpdateDiagnosis {
                diagnosis: Some("Draft".to_string()),
                draft: true,
            },
            plan_line(),
        ];
        for command in allowed {
            assert!(offline_command(command).is_some());
        }
        for status in [
            "diagnosing",
            "waiting_customer_approval",
            "waiting_parts",
            "repairing",
            "quality_check",
            "ready",
        ] {
            assert!(offline_command(RepairCommand::TransitionStatus {
                target_status: status.to_string(),
                reason: None,
                remain_consumed: false,
            })
            .is_some());
        }

        let denied = vec![
            RepairCommand::ReopenRepair {
                source_repair_id: "55555555-5555-4555-8555-555555555555".to_string(),
            },
            RepairCommand::UpdateDiagnosis {
                diagnosis: Some("Final".to_string()),
                draft: false,
            },
            RepairCommand::ConsumeNonstockPart {
                line_id: "66666666-6666-4666-8666-666666666666".to_string(),
            },
            RepairCommand::ReverseNonstockPart {
                line_id: "66666666-6666-4666-8666-666666666666".to_string(),
                reason: "Correction".to_string(),
            },
            RepairCommand::ConsumeRepairPart {
                line_id: "66666666-6666-4666-8666-666666666666".to_string(),
            },
            RepairCommand::ReverseRepairPart {
                line_id: "66666666-6666-4666-8666-666666666666".to_string(),
                original_movement_id: "77777777-7777-4777-8777-777777777777".to_string(),
            },
            RepairCommand::CreateEstimate {
                estimate_id: "88888888-8888-4888-8888-888888888888".to_string(),
                currency: "EUR".to_string(),
                discount_amount: "0".to_string(),
                valid_until: None,
                note: None,
                lines: Vec::new(),
            },
            RepairCommand::RecordApproval {
                approval_id: "99999999-9999-4999-8999-999999999999".to_string(),
                estimate_id: None,
                decision: "accepted".to_string(),
                decision_source: "in_person".to_string(),
                reason: None,
            },
        ];
        for command in denied {
            assert!(offline_command(command).is_none());
        }
        for status in [
            "received",
            "approved",
            "delivered",
            "cancelled",
            "unrepairable",
        ] {
            assert!(offline_command(RepairCommand::TransitionStatus {
                target_status: status.to_string(),
                reason: None,
                remain_consumed: false,
            })
            .is_none());
        }
    }

    #[test]
    fn nested_command_payload_rejects_unknown_renderer_fields() {
        let mut value = serde_json::json!({
            "staffSessionId": "11111111-1111-4111-8111-111111111111",
            "operationId": "22222222-2222-4222-8222-222222222222",
            "repairId": "33333333-3333-4333-8333-333333333333",
            "expectedVersion": 1,
            "occurredAt": "2026-08-26T10:00:00Z",
            "command": {
                "command": "add_note",
                "payload": {
                    "note": "Safe note",
                    "visibility": "internal"
                }
            }
        });
        serde_json::from_value::<RepairExecuteCommandInput>(value.clone())
            .expect("valid strict command envelope");
        value["command"]["payload"]["organizationId"] =
            serde_json::Value::String("forbidden".to_string());
        assert!(serde_json::from_value::<RepairExecuteCommandInput>(value).is_err());
    }

    #[test]
    fn transfer_branch_renderer_contract_is_typed_and_online_only() {
        let value = serde_json::json!({
            "staffSessionId": "11111111-1111-4111-8111-111111111111",
            "operationId": "22222222-2222-4222-8222-222222222222",
            "repairId": TEST_REPAIR_ID,
            "expectedVersion": 7,
            "occurredAt": "2026-08-26T10:00:00.000Z",
            "command": {
                "command": "transfer_branch",
                "payload": {
                    "destination_branch_id": "33333333-3333-4333-8333-333333333333"
                }
            }
        });
        let input: RepairExecuteCommandInput =
            serde_json::from_value(value.clone()).expect("typed transfer command");
        assert_eq!(
            required_permission_for_command(&input.command),
            "repairs.transfer"
        );
        assert!(offline_command(input.command.clone()).is_none());
        assert!(matches!(
            online_command(input.command),
            crate::repair_transport::RepairTypedCommand::TransferBranch {
                destination_branch_id
            } if destination_branch_id == "33333333-3333-4333-8333-333333333333"
        ));

        let mut unknown = value.clone();
        unknown["command"]["payload"]["organization_id"] =
            serde_json::json!("44444444-4444-4444-8444-444444444444");
        assert!(serde_json::from_value::<RepairExecuteCommandInput>(unknown).is_err());
        let mut missing = value;
        missing["command"]["payload"] = serde_json::json!({});
        assert!(serde_json::from_value::<RepairExecuteCommandInput>(missing).is_err());
    }

    #[test]
    fn pending_attachment_projection_is_bounded_and_redacted() {
        let sentinel = "PRIVATE_FILENAME_CAPTION_PATH_BYTES";
        let operations = vec![pending_operation(
            "60000000-0000-4000-8000-000000000000",
            0,
            "stage_attachment",
            serde_json::json!({
                "attachment_id": "77777777-7777-4777-8777-777777777777",
                "filename": sentinel,
                "caption": sentinel,
                "local_path": sentinel,
                "bytes": sentinel
            }),
        )];
        let changes = pending_changes(&operations).expect("safe pending attachment marker");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "stage_attachment");
        let public = serde_json::to_string(&changes).expect("renderer-safe projection");
        assert!(!public.contains(sentinel));
        assert!(!public.contains("attachment_id"));
    }

    #[test]
    fn offline_workspace_reducer_is_deterministic_across_restart_and_conflict() {
        let operations = complete_pending_sequence();
        let first = project_workspace(
            "99999999-9999-4999-8999-999999999999",
            cached_workspace(None, operations.clone(), false),
        )
        .expect("pure local optimistic workspace");
        let restarted = project_workspace(
            "99999999-9999-4999-8999-999999999999",
            cached_workspace(None, operations.clone(), false),
        )
        .expect("restart must replay the same reducer");
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&restarted).unwrap()
        );
        assert_eq!(
            first.repair.assigned_staff_id.as_deref(),
            Some(TEST_STAFF_ID)
        );
        assert_eq!(first.repair.diagnosis.as_deref(), Some("Display cable"));
        assert_eq!(first.repair.status, "ready");
        assert_eq!(first.lines.len(), 1);
        assert_eq!(first.lines[0].id, TEST_LINE_ID);
        assert_eq!(first.lines[0].quantity, 1.5);

        let conflict = project_workspace(
            "99999999-9999-4999-8999-999999999999",
            cached_workspace(None, operations, true),
        )
        .expect("conflict workspace retains the deterministic local projection");
        assert_eq!(conflict.sync_state, "conflict");
        assert_eq!(
            conflict.repair.assigned_staff_id.as_deref(),
            Some(TEST_STAFF_ID)
        );
        assert_eq!(conflict.lines.len(), 1);
    }

    #[test]
    fn authoritative_workspace_reduces_later_optimistic_operations_without_private_leakage() {
        let sentinel = "PRIVATE_PENDING_NOTE_OR_ATTACHMENT_DATA";
        let authoritative = serde_json::json!({
            "repair": {
                "id": TEST_REPAIR_ID,
                "display_number": "R-ATH-26-000001",
                "status": "diagnosing",
                "priority": "normal",
                "title": "Authoritative title",
                "intake_mode": "standard",
                "is_anonymous": false,
                "assigned_staff_id": null,
                "due_at": null,
                "completed_at": null,
                "delivered_at": null,
                "version": 2,
                "created_at": "2026-08-26T09:00:00.000Z",
                "updated_at": "2026-08-26T09:30:00.000Z",
                "customer_id": TEST_CUSTOMER_ID,
                "customer_device_id": TEST_DEVICE_ID,
                "intake_notes": null,
                "diagnosis": "Old diagnosis",
                "currency": "EUR",
                "origin_branch_id": "12121212-1212-4212-8212-121212121212",
                "reopened_from_repair_id": null
            },
            "aliases": [],
            "customer": { "id": TEST_CUSTOMER_ID, "display_name": "Safe customer" },
            "device": null,
            "lines": [],
            "events": [],
            "estimates": [],
            "estimate_lines": [],
            "approvals": [],
            "capabilities": fail_closed_capabilities(),
            "allowed_transitions": ["repairing"]
        });
        let operations = vec![
            pending_operation(
                "70000000-0000-4000-8000-000000000000",
                2,
                "assign_repair",
                serde_json::json!({ "assigned_staff_id": TEST_STAFF_ID }),
            ),
            pending_operation(
                "80000000-0000-4000-8000-000000000000",
                3,
                "update_diagnosis",
                serde_json::json!({ "diagnosis": "New draft", "draft": true }),
            ),
            pending_operation(
                "90000000-0000-4000-8000-000000000000",
                4,
                "add_note",
                serde_json::json!({ "note": sentinel, "visibility": "internal" }),
            ),
            pending_operation(
                "91000000-0000-4000-8000-000000000000",
                5,
                "stage_attachment",
                serde_json::json!({ "filename": sentinel, "bytes": sentinel }),
            ),
        ];
        let projected = project_workspace(
            "99999999-9999-4999-8999-999999999999",
            cached_workspace(Some(authoritative), operations, false),
        )
        .expect("authoritative base plus later optimistic operations");
        assert_eq!(
            projected.repair.assigned_staff_id.as_deref(),
            Some(TEST_STAFF_ID)
        );
        assert_eq!(projected.repair.diagnosis.as_deref(), Some("New draft"));
        let public = serde_json::to_string(&projected).unwrap();
        assert!(!public.contains(sentinel));
        assert!(!public.contains("filename"));
        assert!(!public.contains("bytes"));
    }

    #[test]
    fn money_ipc_allowlist_rejects_non_money_transport_actions() {
        assert!(is_money_request(
            &crate::repair_transport::RepairJsonRequest::FinancialProjection {
                repair_id: TEST_REPAIR_ID.to_string(),
            }
        ));
        assert!(is_money_request(
            &crate::repair_transport::RepairJsonRequest::Settlement {
                repair_id: TEST_REPAIR_ID.to_string(),
                operation_id: "11111111-1111-4111-8111-111111111111".to_string(),
                expected_version: 1,
                occurred_at: "2026-08-31T10:00:00.000Z".to_string(),
            }
        ));
        assert!(!is_money_request(
            &crate::repair_transport::RepairJsonRequest::List {
                status: None,
                search: None,
                limit: 10,
                offset: 0,
            }
        ));
    }
}
