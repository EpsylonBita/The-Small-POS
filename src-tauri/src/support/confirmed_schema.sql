CREATE TABLE IF NOT EXISTS support_confirmed_events (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, command_id TEXT NOT NULL,
  event TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_confirmed_history ON support_confirmed_events(session_id,id);
CREATE INDEX IF NOT EXISTS support_confirmed_command_history ON support_confirmed_events(command_id,id);
CREATE TABLE IF NOT EXISTS support_confirmed_groups (
  root_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command_id TEXT NOT NULL,
  members_json TEXT NOT NULL, returned_at TEXT
);

CREATE TABLE IF NOT EXISTS support_confirmed_restores(command_id TEXT PRIMARY KEY,target_snapshot_id TEXT NOT NULL,changed_rows INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS support_confirmed_sessions(session_id TEXT PRIMARY KEY,consent_version TEXT NOT NULL,mode TEXT NOT NULL);
