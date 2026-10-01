//! Release-safety check: can the branch's active fiscal plugin accept the
//! currency its receipts carry?
//!
//! Since the 29/09/2026 currency fix (`payload_builder::resolve_store_currency_code`)
//! a fiscal receipt carries the store's configured currency instead of a
//! hard-coded EUR. That is right for a Swiss store, but a fiscally active
//! store whose currency setting is wrong now has its receipts refused by the
//! server adapter: the Greek adapter (and the Spanish, Italian, Montenegrin,
//! Portuguese and Slovenian ones) accepts EUR only and answers
//! `currency_unsupported`, a terminal failure.
//!
//! Which branches are configured that way cannot be known from a terminal.
//! What a terminal can do, and does here, is make the refusal visible: a
//! clear warning in the log (never a failure; the receipt is still queued and
//! the server stays the authority) whenever the plugin named by the last
//! fresh `GET /api/pos/fiscal/status` answer cannot accept the store's
//! currency, and the same check in the Z-closeout support evidence
//! (`closeout_readiness.json` → `fiscalQueueBlockers.currencyCheck`). The
//! refused rows themselves keep the server's `CURRENCY_UNSUPPORTED` code in
//! their queue error (see `sync_queue::parity_client_error_code`).
//!
//! The table mirrors the server adapters' own currency guards
//! (`admin-dashboard/src/services/fiscal/adapters/<cc>`). A plugin missing
//! from it is not checked.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use tracing::warn;

use super::active_cache;
use super::payload_builder::{resolve_store_currency_code, DEFAULT_FISCAL_CURRENCY};

/// Currencies a server fiscal adapter accepts from a POS receipt. Adapters
/// that accept a foreign currency only with exchange-rate metadata (Albania,
/// Romania, Serbia) are listed with their local currency: the POS payload
/// never carries that metadata.
pub fn supported_fiscal_currencies(plugin_id: &str) -> Option<&'static [&'static str]> {
    match plugin_id.trim() {
        "fiscalization_gr" | "fiscalization_es" | "fiscalization_it" | "fiscalization_me"
        | "fiscalization_pt" | "fiscalization_si" => Some(&["EUR"]),
        "fiscalization_hr" => Some(&["EUR", "HRK"]),
        "fiscalization_al" => Some(&["ALL"]),
        "fiscalization_ro" => Some(&["RON"]),
        "fiscalization_rs" => Some(&["RSD"]),
        _ => None,
    }
}

/// The check for one branch: the plugin the server named, the currency the
/// receipts carry, and whether the plugin accepts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiscalCurrencyCheck {
    pub branch_id: String,
    pub plugin_id: String,
    /// The currency the receipts carry (the store's setting, EUR when none).
    pub receipt_currency: String,
    /// Whether the currency came from a store setting or the EUR fallback.
    pub currency_configured: bool,
    pub supported_currencies: Vec<String>,
    pub accepted: bool,
}

/// Check a branch whose fresh verdict is active with a known plugin; `None`
/// when there is nothing to check (inactive or unknown verdict, no plugin
/// named, or a plugin without a known currency rule).
pub fn check_branch_currency(conn: &Connection, branch_id: &str) -> Option<FiscalCurrencyCheck> {
    let branch_id = branch_id.trim();
    if branch_id.is_empty() {
        return None;
    }
    let plugin_id = active_cache::fresh_active_plugin_id(branch_id)?;
    let supported = supported_fiscal_currencies(&plugin_id)?;
    let configured = resolve_store_currency_code(conn);
    let currency_configured = configured.is_some();
    let receipt_currency = configured.unwrap_or_else(|| DEFAULT_FISCAL_CURRENCY.to_string());
    Some(FiscalCurrencyCheck {
        branch_id: branch_id.to_string(),
        accepted: supported.contains(&receipt_currency.as_str()),
        plugin_id,
        receipt_currency,
        currency_configured,
        supported_currencies: supported.iter().map(|code| (*code).to_string()).collect(),
    })
}

/// The last mismatch warned about per branch, so the log says it once per
/// change instead of on every receipt.
fn warned_mismatches() -> &'static Mutex<HashMap<String, String>> {
    static WARNED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    WARNED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Log a clear warning (never a failure) when the branch's active plugin
/// cannot accept the currency its receipts carry. Returns the check when it
/// found a mismatch.
pub fn warn_if_currency_unsupported(
    conn: &Connection,
    branch_id: &str,
) -> Option<FiscalCurrencyCheck> {
    let check = check_branch_currency(conn, branch_id)?;
    let Ok(mut warned) = warned_mismatches().lock() else {
        return (!check.accepted).then_some(check);
    };
    if check.accepted {
        warned.remove(&check.branch_id);
        return None;
    }
    let key = format!("{}|{}", check.plugin_id, check.receipt_currency);
    if warned.get(&check.branch_id) != Some(&key) {
        warn!(
            branch_id = %check.branch_id,
            plugin_id = %check.plugin_id,
            receipt_currency = %check.receipt_currency,
            currency_configured = check.currency_configured,
            supported = %check.supported_currencies.join(","),
            "Fiscal receipts of this branch will be refused by the tax plugin: it accepts {} only, but the store currency resolves to {}. Receipts stay queued; fix the store's currency setting.",
            check.supported_currencies.join("/"),
            check.receipt_currency,
        );
        warned.insert(check.branch_id.clone(), key);
    }
    Some(check)
}

/// The check as support evidence (`fiscalQueueBlockers.currencyCheck`).
pub fn currency_check_evidence(conn: &Connection, branch_id: &str) -> Value {
    match check_branch_currency(conn, branch_id) {
        Some(check) => serde_json::to_value(check).unwrap_or(Value::Null),
        None => json!({
            "status": "not_checked",
            "reason": "no fresh active fiscal plugin with a known currency rule",
        }),
    }
}

#[cfg(test)]
pub(crate) fn reset_warnings_for_tests() {
    if let Ok(mut warned) = warned_mismatches().lock() {
        warned.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn conn_with_settings() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE local_settings (
                 setting_category TEXT NOT NULL,
                 setting_key TEXT NOT NULL,
                 setting_value TEXT,
                 PRIMARY KEY (setting_category, setting_key)
             );",
        )
        .expect("create local_settings");
        conn
    }

    fn set_currency(conn: &Connection, value: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value)
             VALUES ('organization', 'currency', ?1)",
            params![value],
        )
        .expect("set currency");
    }

    #[test]
    fn the_table_mirrors_the_server_adapters() {
        assert_eq!(
            supported_fiscal_currencies("fiscalization_gr"),
            Some(&["EUR"][..])
        );
        assert_eq!(
            supported_fiscal_currencies("fiscalization_hr"),
            Some(&["EUR", "HRK"][..])
        );
        assert_eq!(
            supported_fiscal_currencies("fiscalization_al"),
            Some(&["ALL"][..])
        );
        assert_eq!(supported_fiscal_currencies("fiscalization_bg"), None);
        assert_eq!(supported_fiscal_currencies(""), None);
    }

    #[test]
    #[serial_test::serial]
    fn a_greek_plugin_with_a_non_euro_store_currency_is_reported_not_failed() {
        active_cache::reset_for_tests();
        reset_warnings_for_tests();
        let conn = conn_with_settings();

        // Unknown verdict or an inactive branch: nothing to check.
        assert_eq!(check_branch_currency(&conn, "branch-gr"), None);
        active_cache::update_with_plugin("branch-gr", false, Some("fiscalization_gr".into()));
        assert_eq!(check_branch_currency(&conn, "branch-gr"), None);
        assert_eq!(
            currency_check_evidence(&conn, "branch-gr")["status"],
            "not_checked"
        );

        // Active Greek plugin, no currency configured: receipts carry EUR.
        active_cache::update_with_plugin("branch-gr", true, Some("fiscalization_gr".into()));
        let euro = check_branch_currency(&conn, "branch-gr").expect("checked");
        assert!(euro.accepted);
        assert!(!euro.currency_configured);
        assert_eq!(warn_if_currency_unsupported(&conn, "branch-gr"), None);

        // A store configured in CHF: the Greek adapter would refuse.
        set_currency(&conn, "CHF");
        let refused = warn_if_currency_unsupported(&conn, "branch-gr").expect("mismatch");
        assert!(!refused.accepted);
        assert_eq!(refused.receipt_currency, "CHF");
        assert_eq!(refused.supported_currencies, vec!["EUR".to_string()]);
        let evidence = currency_check_evidence(&conn, "branch-gr");
        assert_eq!(evidence["accepted"], false);
        assert_eq!(evidence["pluginId"], "fiscalization_gr");
        assert_eq!(evidence["receiptCurrency"], "CHF");

        // A plugin without a known rule is not checked.
        active_cache::update_with_plugin("branch-bg", true, Some("fiscalization_bg".into()));
        assert_eq!(check_branch_currency(&conn, "branch-bg"), None);
        active_cache::reset_for_tests();
        reset_warnings_for_tests();
    }
}
