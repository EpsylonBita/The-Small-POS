//! The VAT a slip prints: the desktop port of `shared/services/ReceiptVat.ts`
//! (`resolvePrintedVat`).
//!
//! Founder rule (07/10/2026): with an active fiscal plugin (a connected server
//! fiscal plugin, or a myDATA fiscal device set up on this till) the slip
//! prints the order's computed VAT, the canonical `orders.tax_amount`.
//! Without one it prints the VAT of the rate the owner set in Admin → POS
//! settings → Taxes (`tax.default_tax_rate`): one rate for the branch, always
//! included in the prices in this release. No rate, or 0%, prints no VAT
//! line, exactly as a tax-0 order always printed. A tip never carries VAT.
//! `shared/services/__fixtures__/receipt-vat-vectors.json` pins the results.

use rusqlite::Connection;

use super::greece_vat::js_round;

/// Local setting (category `tax`) holding the owner's VAT rate in percent.
/// The server feed sends it as `tax.default_tax_rate`; an explicit `null`
/// clears it (see `terminal_helpers::cache_terminal_settings_snapshot`).
pub const OWNER_VAT_RATE_SETTING_CATEGORY: &str = "tax";
pub const OWNER_VAT_RATE_SETTING_KEY: &str = "default_tax_rate";

/// The managed myDATA fiscal cashier the integrations page saves.
pub const MYDATA_FISCAL_DEVICE_ID: &str = "mydata-fiscal-device";

/// `reason` of a fiscal-status answer whose plugin dispatches receipts.
pub const FISCAL_STATUS_ACTIVE_REASON: &str = "active";

fn finite_or_zero(value: Option<f64>) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(0.0)
}

/// `computeOwnerConfiguredVat`, in cents: the VAT included in the owner's
/// prices, or `None` when no VAT line is printed.
pub fn compute_owner_configured_vat_cents(
    total_amount: f64,
    tip_amount: Option<f64>,
    rate_percent: Option<f64>,
) -> Option<i64> {
    let rate = rate_percent.filter(|rate| rate.is_finite() && *rate > 0.0 && *rate <= 100.0)?;
    let base_cents = f64::max(
        0.0,
        js_round(finite_or_zero(Some(total_amount)) * 100.0)
            - js_round(f64::max(0.0, finite_or_zero(tip_amount)) * 100.0),
    );
    let vat_cents = js_round((base_cents * rate) / (100.0 + rate)) as i64;
    (vat_cents > 0).then_some(vat_cents)
}

/// `resolvePrintedVat`, in cents: the VAT to print for an order, or `None`
/// when the slip has no VAT line.
pub fn resolve_printed_vat_cents(
    fiscal_active: bool,
    computed_vat_amount: Option<f64>,
    total_amount: f64,
    tip_amount: Option<f64>,
    rate_percent: Option<f64>,
) -> Option<i64> {
    if fiscal_active {
        let vat_cents = js_round(finite_or_zero(computed_vat_amount) * 100.0) as i64;
        return (vat_cents > 0).then_some(vat_cents);
    }
    compute_owner_configured_vat_cents(total_amount, tip_amount, rate_percent)
}

/// What decides a till's printed VAT, read once per slip or order list.
#[derive(Debug, Clone, PartialEq)]
pub struct PrintedVatContext {
    /// A myDATA fiscal device is set up on this till.
    pub mydata_fiscal_device: bool,
    /// The owner's configured VAT rate in percent, when set.
    pub owner_rate_percent: Option<f64>,
    /// The terminal's branch, for an order that names none.
    pub terminal_branch_id: Option<String>,
}

impl PrintedVatContext {
    /// Read the till's printed-VAT inputs (no keyring access).
    pub fn load(conn: &Connection) -> Self {
        Self {
            mydata_fiscal_device: mydata_fiscal_device_configured(conn),
            owner_rate_percent: owner_vat_rate_percent(conn),
            terminal_branch_id: crate::db::get_setting(conn, "terminal", "branch_id")
                .map(|branch| branch.trim().to_string())
                .filter(|branch| !branch.is_empty()),
        }
    }

    /// An active fiscal plugin for an order of `branch_id`: a myDATA fiscal
    /// device on this till, or a connected server plugin for the branch.
    pub fn fiscal_active(&self, branch_id: Option<&str>) -> bool {
        if self.mydata_fiscal_device {
            return true;
        }
        let branch = branch_id
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .or(self.terminal_branch_id.as_deref());
        branch.is_some_and(fiscal_plugin_connected)
    }

    /// The printed VAT of one order, in cents (`None`: no VAT line).
    pub fn order_vat_cents(
        &self,
        branch_id: Option<&str>,
        total_amount: f64,
        tip_amount: f64,
        computed_vat_amount: Option<f64>,
    ) -> Option<i64> {
        resolve_printed_vat_cents(
            self.fiscal_active(branch_id),
            computed_vat_amount,
            total_amount,
            Some(tip_amount),
            self.owner_rate_percent,
        )
    }

    /// The printed VAT of one order as an amount (`None`: no VAT line).
    pub fn order_vat_amount(
        &self,
        branch_id: Option<&str>,
        total_amount: f64,
        tip_amount: f64,
        computed_vat_amount: Option<f64>,
    ) -> Option<f64> {
        self.order_vat_cents(branch_id, total_amount, tip_amount, computed_vat_amount)
            .map(|cents| cents as f64 / 100.0)
    }
}

/// The owner's VAT rate (`tax.default_tax_rate`); absent or not a number
/// means not set.
pub fn owner_vat_rate_percent(conn: &Connection) -> Option<f64> {
    crate::db::get_setting(
        conn,
        OWNER_VAT_RATE_SETTING_CATEGORY,
        OWNER_VAT_RATE_SETTING_KEY,
    )
    .and_then(|raw| raw.trim().parse::<f64>().ok())
    .filter(|rate| rate.is_finite())
}

/// A myDATA fiscal device is set up on this till: the managed
/// `mydata-fiscal-device`, or an enabled cash register on a fiscal protocol
/// (CAP Driver or the generic fiscal protocol). A disabled device, a payment
/// terminal or an unreadable device table is no fiscal device, and so is any
/// cash register while the MyData plugin is not in fiscal-device mode with its
/// setup finished (`crate::device_admission`, founder rule 08/10/2026).
pub fn mydata_fiscal_device_configured(conn: &Connection) -> bool {
    if !crate::device_admission::is_admitted(conn, crate::device_admission::CASH_REGISTER) {
        return false;
    }
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM ecr_devices
            WHERE COALESCE(enabled, 0) = 1
              AND (
                id = ?1
                OR (
                  device_type = 'cash_register'
                  AND lower(trim(COALESCE(protocol, ''))) IN (
                    'cap_driver', 'rbs_cap_driver', 'mat_cap_driver',
                    'generic', 'escpos_fiscal', 'generic_escpos_fiscal'
                  )
                )
              )
         )",
        [MYDATA_FISCAL_DEVICE_ID],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

/// A server fiscal plugin is connected for the branch: only a FRESH status
/// answer with `active` true, a named plugin and the reason `active`. An
/// unknown or stale verdict, or an active answer for another reason
/// (`adapter_not_registered`, `certification_missing`, ...), is not.
pub fn fiscal_plugin_connected(branch_id: &str) -> bool {
    let branch_id = branch_id.trim();
    !branch_id.is_empty() && super::active_cache::fresh_connected_plugin(branch_id).is_some()
}

/// The VAT an order JSON for the renderer shows (`printedVatAmount`): the
/// printed VAT of its slip, `null` when the slip prints no VAT line. Screens
/// read this instead of the stored `tax_amount`, so they show what the slip
/// shows.
pub fn attach_printed_vat_to_order_json(
    context: &PrintedVatContext,
    order: &mut serde_json::Value,
) {
    let number = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| order.get(*key).and_then(serde_json::Value::as_f64))
    };
    let total = number(&["totalAmount", "total_amount"]).unwrap_or(0.0);
    let tip = number(&["tipAmount", "tip_amount"]).unwrap_or(0.0);
    let computed = number(&["taxAmount", "tax_amount"]);
    let branch = ["branchId", "branch_id"]
        .iter()
        .find_map(|key| order.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_string);
    let printed = context.order_vat_amount(branch.as_deref(), total, tip, computed);
    if let Some(object) = order.as_object_mut() {
        object.insert("printedVatAmount".to_string(), serde_json::json!(printed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const RECEIPT_VAT_VECTORS: &str =
        include_str!("../../../../shared/services/__fixtures__/receipt-vat-vectors.json");

    #[test]
    fn port_reproduces_every_shared_receipt_vat_vector() {
        let vectors: Value = serde_json::from_str(RECEIPT_VAT_VECTORS).expect("vectors parse");
        let cases = vectors["cases"].as_array().expect("vector cases");
        assert_eq!(
            cases.len(),
            16,
            "the frozen printed-VAT vector set has 16 cases"
        );
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let input = &case["input"];
            let printed = resolve_printed_vat_cents(
                input["fiscalActive"].as_bool().unwrap(),
                input.get("computedVatAmount").and_then(Value::as_f64),
                input["totalAmount"].as_f64().unwrap(),
                input.get("tipAmount").and_then(Value::as_f64),
                input.get("ratePercent").and_then(Value::as_f64),
            );
            assert_eq!(printed, case["expectedVatCents"].as_i64(), "{name}");
        }
    }

    fn device_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        conn
    }

    fn add_device(conn: &Connection, id: &str, device_type: &str, protocol: &str, enabled: i64) {
        conn.execute(
            "INSERT INTO ecr_devices (id, name, device_type, protocol, connection_type, enabled)
             VALUES (?1, ?1, ?2, ?3, 'network', ?4)",
            rusqlite::params![id, device_type, protocol, enabled],
        )
        .unwrap();
    }

    #[test]
    fn only_an_enabled_fiscal_cashier_counts_as_a_mydata_device() {
        let conn = device_db();
        assert!(!mydata_fiscal_device_configured(&conn));
        // A card terminal on the default protocol is not a fiscal device.
        add_device(&conn, "card-terminal", "payment_terminal", "generic", 1);
        assert!(!mydata_fiscal_device_configured(&conn));
        // Tomikro today: the myDATA setup is pending, no device saved; a
        // disabled managed device does not count either.
        add_device(
            &conn,
            MYDATA_FISCAL_DEVICE_ID,
            "cash_register",
            "cap_driver",
            0,
        );
        assert!(!mydata_fiscal_device_configured(&conn));
        conn.execute(
            "UPDATE ecr_devices SET enabled = 1 WHERE id = ?1",
            [MYDATA_FISCAL_DEVICE_ID],
        )
        .unwrap();
        // Enabled, but the MyData fiscal-device setup was never finished
        // (founder rule 08/10/2026): still no fiscal device.
        assert!(!mydata_fiscal_device_configured(&conn));
        crate::device_admission::admit_for_test(&conn, &[crate::device_admission::CASH_REGISTER]);
        assert!(mydata_fiscal_device_configured(&conn));
        conn.execute(
            "DELETE FROM ecr_devices WHERE id = ?1",
            [MYDATA_FISCAL_DEVICE_ID],
        )
        .unwrap();
        add_device(&conn, "rbs", "cash_register", "rbs_cap_driver", 1);
        assert!(mydata_fiscal_device_configured(&conn));
    }

    #[test]
    #[serial_test::serial]
    fn only_a_fresh_connected_plugin_verdict_is_fiscal_active() {
        crate::fiscal::active_cache::reset_for_tests();
        assert!(!fiscal_plugin_connected("branch-p"), "unknown");
        crate::fiscal::active_cache::update_with_status(
            "branch-p",
            true,
            Some("fiscalization_gr".into()),
            Some("adapter_not_registered".into()),
        );
        assert!(
            !fiscal_plugin_connected("branch-p"),
            "active for another reason"
        );
        crate::fiscal::active_cache::update_with_status(
            "branch-p",
            true,
            None,
            Some("active".into()),
        );
        assert!(!fiscal_plugin_connected("branch-p"), "no plugin named");
        crate::fiscal::active_cache::update_with_status(
            "branch-p",
            false,
            None,
            Some("no_active_plugin".into()),
        );
        assert!(!fiscal_plugin_connected("branch-p"), "inactive");
        crate::fiscal::active_cache::update_with_status(
            "branch-p",
            true,
            Some("fiscalization_gr".into()),
            Some("active".into()),
        );
        assert!(fiscal_plugin_connected("branch-p"));
        assert!(!fiscal_plugin_connected("branch-other"));
        crate::fiscal::active_cache::reset_for_tests();
    }

    #[test]
    fn owner_rate_reads_the_admin_rate_and_never_the_checkout_rate() {
        let conn = device_db();
        assert_eq!(owner_vat_rate_percent(&conn), None);
        crate::db::set_setting(&conn, "tax", "tax_rate_percentage", "24").unwrap();
        assert_eq!(
            owner_vat_rate_percent(&conn),
            None,
            "the checkout rate is not the owner's"
        );
        crate::db::set_setting(&conn, "tax", "default_tax_rate", "0").unwrap();
        assert_eq!(owner_vat_rate_percent(&conn), Some(0.0));
        crate::db::set_setting(&conn, "tax", "default_tax_rate", "13").unwrap();
        assert_eq!(owner_vat_rate_percent(&conn), Some(13.0));
        crate::db::set_setting(&conn, "tax", "default_tax_rate", "abc").unwrap();
        assert_eq!(owner_vat_rate_percent(&conn), None);
    }
}
