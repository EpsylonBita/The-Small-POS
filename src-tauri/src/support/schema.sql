CREATE TABLE support_session_state (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('code_pending','pending_ack','active','ended')),
  tier_ceiling INTEGER NOT NULL CHECK (tier_ceiling BETWEEN 1 AND 3),
  attended INTEGER NOT NULL DEFAULT 1,
  unattended_record_json TEXT, unattended_assertion_json TEXT, unattended_verified_at TEXT,
  max_expires_at TEXT NOT NULL, absolute_cap_at TEXT NOT NULL,
  last_server_time TEXT, monotonic_at_server_time INTEGER,
  last_seq INTEGER NOT NULL DEFAULT 0, kill_epoch INTEGER NOT NULL DEFAULT 0,
  result_bytes INTEGER NOT NULL DEFAULT 0,
  resume_token TEXT, end_reason TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE support_pending_notices (                
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('end','cancel_code','consent_decline')),
  body_json TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE support_accepted_commands (
  command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  kind TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  accepted_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, outcome TEXT,
  result_json TEXT, result_bytes INTEGER, delivered INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'accepted', envelope_json TEXT,
  UNIQUE (session_id, sequence)
);
CREATE TABLE support_consumed_approvals (
  approval_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, kind TEXT NOT NULL,
  dry_run_or_validation_id TEXT, payload_sha256 TEXT NOT NULL,
  credential_id TEXT NOT NULL, sign_count INTEGER, consumed_at TEXT NOT NULL, outcome TEXT
);
CREATE TABLE support_key_signcounts (credential_id TEXT PRIMARY KEY, sign_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE support_revoked_keys (credential_id TEXT PRIMARY KEY, revoked_at TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE support_dry_runs (
  dry_run_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  target_key_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE support_validations (
  validation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  device_kind TEXT NOT NULL CHECK (device_kind IN ('printer','card_terminal','cash_register')),
  device_ref_json TEXT NOT NULL, record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL,
  previous_config_json TEXT, identification_json TEXT, admission_json TEXT,
  expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE support_device_applies (
  id TEXT PRIMARY KEY, validation_id TEXT NOT NULL, device_kind TEXT NOT NULL, device_id TEXT NOT NULL,
  previous_config_json TEXT, applied_at TEXT NOT NULL, undone_at TEXT,
  state TEXT NOT NULL DEFAULT 'unknown', applied_config_json TEXT, admission_json TEXT
);
CREATE TABLE support_audit_local (
  terminal_seq INTEGER PRIMARY KEY,                    
  session_id TEXT, command_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('accepted','started','finished','refused')),
  status TEXT, outcome TEXT, input_sha256 TEXT, result_sha256 TEXT,
  created_at TEXT NOT NULL, synced_at TEXT
);
CREATE TABLE support_snapshots (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, approval_id TEXT, taken_at TEXT NOT NULL, path TEXT NOT NULL,
  app_version TEXT NOT NULL, schema_versions_json TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  integrity_hash TEXT NOT NULL, full_watermark_json TEXT NOT NULL, cheap_watermark_json TEXT NOT NULL,
  post_change_watermark_json TEXT, superseded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE support_quarantine (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, session_id TEXT NOT NULL, approval_id TEXT,
  source_db TEXT NOT NULL CHECK (source_db IN ('main','printers')), source_table TEXT NOT NULL,
  source_pk_json TEXT NOT NULL, row_json TEXT NOT NULL, row_sha256 TEXT NOT NULL, reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged','quarantined','restored','expired','discarded')),
  created_at TEXT NOT NULL, restored_at TEXT
);
CREATE INDEX support_quarantine_group ON support_quarantine (group_id);
CREATE TABLE support_audit_sequence (id INTEGER PRIMARY KEY CHECK(id=1), last_seq INTEGER NOT NULL);
INSERT INTO support_audit_sequence VALUES (1,0);
CREATE TABLE support_result_outbox (
  command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, result_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE support_command_refusals (
  command_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Exact native discovery inputs and admitted adapter/port parameters; no bodies.
CREATE TABLE IF NOT EXISTS support_network_evidence (
  command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
  parameters_json TEXT NOT NULL, created_at TEXT NOT NULL
);
