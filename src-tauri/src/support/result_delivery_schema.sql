-- Delivery scheduling survives process loss; no result payload in refusal evidence.
CREATE TABLE IF NOT EXISTS support_result_delivery (
  command_id TEXT PRIMARY KEY REFERENCES support_result_outbox(command_id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL,
  last_attempt_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_result_refusals (
  command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  server_code TEXT NOT NULL, refused_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_result_refusals_time ON support_result_refusals(refused_at);
