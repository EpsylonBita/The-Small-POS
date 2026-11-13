//! Native support policy and durable state. Business connections never attach support.db.
pub mod approval_verify;
pub mod audit_local;
pub mod authorizer;
pub mod breakglass;
pub mod catalogue;
pub mod clock;
pub mod confirmed;
pub mod confirmed_actions;
pub mod confirmed_hash;
pub mod confirmed_restore;
pub mod confirmed_sql;
pub mod contracts;
pub mod critical_op;
pub mod db;
pub mod delivery;
pub mod device_apply;
pub mod dispatch;
pub mod dry_run;
pub mod dry_run_groups;
pub mod evidence;
pub mod executor;
pub mod guards;
pub mod identity;
pub mod key_rotation;
pub mod screenshot;
// Standalone blocks for the terminal-command runner (tasks 21.3/21.4).
#[cfg_attr(not(test), allow(dead_code))]
pub mod protected_digest;
pub mod quarantine;
#[cfg_attr(not(test), allow(dead_code))]
pub mod quiet_window;
pub mod restore;
pub mod session;
pub mod snapshot;
pub mod terminal_cmd;
pub mod transport;

#[cfg(test)]
mod tests;

pub mod collectors;
pub mod matcher;
pub mod network;
pub mod onsite;
pub mod redaction;
pub mod remedies;
pub mod remedy_run;
pub mod replica;
pub mod sql_query;
pub mod tools;
