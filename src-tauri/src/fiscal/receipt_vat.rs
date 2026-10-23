//! The VAT a slip prints and a Z totals: the desktop port of
//! `shared/services/ReceiptVat.ts`.
//!
//! Founder rule (21/10/2026, replacing the owner-rate rule of 07/10): every
//! order carries ONE VAT, the computed `orders.tax_amount` the server stores
//! and the till adopts ([`super::greece_vat`]). The Z always totals it
//! ([`resolve_z_order_vat_cents`]). A slip prints it when a fiscal plugin is
//! active (a connected server fiscal plugin, or a myDATA fiscal device set up
//! on this till) or when the owner turned on «VAT on receipts»
//! (`tax.vat_print_on_receipt`); otherwise the slip has no VAT line. A zero
//! VAT never prints, and the slip never computes VAT at the owner's rate any
//! more. Until the till has received the switch, an owner rate above 0%
//! (`tax.default_tax_rate`, the 07/10 setting) reads as "on".
//! `shared/services/__fixtures__/receipt-vat-vectors.json` pins the results.

use rusqlite::Connection;

use super::greece_vat::js_round;

/// Local setting (category `tax`) holding the owner's VAT rate in percent.
/// The server feed sends it as `tax.default_tax_rate`; an explicit `null`
/// clears it (see `terminal_helpers::cache_terminal_settings_snapshot`).
/// Read only while the «VAT on receipts» switch is missing.
pub const OWNER_VAT_RATE_SETTING_CATEGORY: &str = "tax";
pub const OWNER_VAT_RATE_SETTING_KEY: &str = "default_tax_rate";
/// The owner's «VAT on receipts» switch (`tax.vat_print_on_receipt`); the
/// feed leaves it out when it cannot tell, so the till keeps its last value.
pub const PRINT_VAT_ON_RECEIPT_SETTING_KEY: &str = "vat_print_on_receipt";

/// The managed myDATA fiscal cashier the integrations page saves.
pub const MYDATA_FISCAL_DEVICE_ID: &str = "mydata-fiscal-device";

/// `reason` of a fiscal-status answer whose plugin dispatches receipts.
pub const FISCAL_STATUS_ACTIVE_REASON: &str = "active";

fn finite_or_zero(value: Option<f64>) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(0.0)
}

/// `resolvePrintVatOnReceipt`: the owner's switch, else (a till that has
/// not received the switch yet) an owner rate above 0% and at most 100%.
pub fn resolve_print_vat_on_receipt(switch: Option<bool>, owner_rate_percent: Option<f64>) -> bool {
    if let Some(on) = switch {
        return on;
    }
    owner_rate_percent.is_some_and(|rate| rate.is_finite() && rate > 0.0 && rate <= 100.0)
}

/// `resolveZOrderVatCents`: the order's VAT as the Z totals it, the computed
/// VAT in whole cents, never below 0.
pub fn resolve_z_order_vat_cents(computed_vat_amount: Option<f64>) -> i64 {
    (js_round(finite_or_zero(computed_vat_amount) * 100.0) as i64).max(0)
}

/// `resolvePrintedVat`, in cents: the VAT to print for an order, or `None`
/// when the slip has no VAT line.
pub fn resolve_printed_vat_cents(
    fiscal_active: bool,
    print_vat_on_receipt: Option<bool>,
    owner_rate_percent: Option<f64>,
    computed_vat_amount: Option<f64>,
) -> Option<i64> {
    if !fiscal_active && !resolve_print_vat_on_receipt(print_vat_on_receipt, owner_rate_percent) {
        return None;
    }
    let vat_cents = resolve_z_order_vat_cents(computed_vat_amount);
    (vat_cents > 0).then_some(vat_cents)
}

/// What decides a till's printed VAT, read once per slip or order list.
#[derive(Debug, Clone, PartialEq)]
pub struct PrintedVatContext {
    pub vat_registered: bool,
    /// A myDATA fiscal device is set up on this till.
    pub mydata_fiscal_device: bool,
    /// The owner's «VAT on receipts» switch, `None` until the feed sent it.
    pub print_vat_on_receipt: Option<bool>,
    /// The owner's configured VAT rate in percent, when set.
    pub owner_rate_percent: Option<f64>,
    /// The terminal's branch, for an order that names none.
    pub terminal_branch_id: Option<String>,
}

impl PrintedVatContext {
    /// Read the till's printed-VAT inputs (no keyring access).
    pub fn load(conn: &Connection) -> Self {
        Self {
            vat_registered: super::greece_vat::branch_vat_settings(conn).vat_registered
                != Some(false),
            mydata_fiscal_device: mydata_fiscal_device_configured(conn),
            print_vat_on_receipt: print_vat_on_receipt_switch(conn),
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
        computed_vat_amount: Option<f64>,
    ) -> Option<i64> {
        if !self.vat_registered {
            return None;
        }
        // A switched-on till prints without asking for the fiscal verdict.
        let fiscal_active =
            resolve_print_vat_on_receipt(self.print_vat_on_receipt, self.owner_rate_percent)
                || self.fiscal_active(branch_id);
        resolve_printed_vat_cents(
            fiscal_active,
            self.print_vat_on_receipt,
            self.owner_rate_percent,
            computed_vat_amount,
        )
    }

    /// The printed VAT of one order as an amount (`None`: no VAT line).
    pub fn order_vat_amount(
        &self,
        branch_id: Option<&str>,
        computed_vat_amount: Option<f64>,
    ) -> Option<f64> {
        self.order_vat_cents(branch_id, computed_vat_amount)
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

/// The owner's «VAT on receipts» switch (`tax.vat_print_on_receipt`, a
/// boolean the feed stores as `true`/`false`); missing or unreadable is
/// `None`.
pub fn print_vat_on_receipt_switch(conn: &Connection) -> Option<bool> {
    super::greece_vat::setting_bool(
        crate::db::get_setting(
            conn,
            OWNER_VAT_RATE_SETTING_CATEGORY,
            PRINT_VAT_ON_RECEIPT_SETTING_KEY,
        )
        .as_deref(),
    )
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
    // The cents column wins over the REAL value, as on the slip.
    let computed = number(&["taxAmountCents", "tax_amount_cents"])
        .map(|cents| cents / 100.0)
        .or_else(|| number(&["taxAmount", "tax_amount"]));
    let branch = ["branchId", "branch_id"]
        .iter()
        .find_map(|key| order.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_string);
    let printed = context.order_vat_amount(branch.as_deref(), computed);
    if let Some(object) = order.as_object_mut() {
        object.insert("printedVatAmount".to_string(), serde_json::json!(printed));
    }
}

/// Swiss rate letters; the input and result follow the shared slip helper exactly.
pub fn resolve_receipt_vat_legend(
    country: Option<&str>,
    registered: bool,
    prints: bool,
    lines: &[serde_json::Value],
) -> Option<serde_json::Value> {
    if !country.is_some_and(|c| c.trim().eq_ignore_ascii_case("CH")) || !registered || !prints {
        return None;
    }
    let mut rates: Vec<(String, f64)> = vec![];
    for line in lines {
        let code = line["vatCategoryCode"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        let rate = line["vatRatePercent"].as_f64().filter(|r| r.is_finite());
        if let (Some(code), Some(rate)) = (code, rate) {
            if !rates.iter().any(|r| r.0 == code) {
                rates.push((code.into(), rate));
            }
        }
    }
    rates.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    rates.truncate(10);
    if rates.is_empty() {
        return None;
    }
    let entries: Vec<serde_json::Value> = rates.into_iter().enumerate().map(|(i,(code,rate))| {
        let rate = if rate.fract() == 0.0 { serde_json::json!(rate as i64) } else { serde_json::json!(rate) };
        serde_json::json!({"letter":((b'A'+i as u8) as char).to_string(),"vatCategoryCode":code,"ratePercent":rate})
    }).collect();
    let letters: serde_json::Map<String, serde_json::Value> = entries
        .iter()
        .map(|e| {
            (
                e["vatCategoryCode"].as_str().unwrap().into(),
                e["letter"].clone(),
            )
        })
        .collect();
    Some(serde_json::json!({"letterByCategory":letters,"entries":entries}))
}

pub fn resolve_receipt_sale_channel_marker(
    country: Option<&str>,
    registered: bool,
    order_type: Option<&str>,
    platform: Option<&str>,
) -> Option<&'static str> {
    if !country.is_some_and(|c| c.trim().eq_ignore_ascii_case("CH")) || !registered {
        return None;
    }
    super::greece_vat::normalize_vat_sale_channel(order_type, platform).filter(|c| *c != "dine_in")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn swiss_legend_and_channel_match_every_shared_vector() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/services/__fixtures__/receipt-vat-legend-vectors.json"
        ))
        .unwrap();
        for case in fixture["legend"].as_array().unwrap() {
            let i = &case["input"];
            assert_eq!(
                resolve_receipt_vat_legend(
                    i["country"].as_str(),
                    i["vatRegistered"].as_bool().unwrap(),
                    i["vatPrints"].as_bool().unwrap(),
                    i["lines"].as_array().unwrap()
                )
                .unwrap_or(Value::Null),
                case["expected"],
                "{}",
                case["name"]
            );
        }
        for case in fixture["channelMarker"].as_array().unwrap() {
            let i = &case["input"];
            assert_eq!(
                serde_json::json!(resolve_receipt_sale_channel_marker(
                    i["country"].as_str(),
                    i["vatRegistered"].as_bool().unwrap(),
                    i["orderType"].as_str(),
                    i["platform"].as_str()
                )),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn unregistered_overrides_even_a_fiscal_device_and_print_switch() {
        let conn = device_db();
        crate::db::set_setting(&conn, "tax", "vat_registered", "false").unwrap();
        let context = PrintedVatContext {
            mydata_fiscal_device: true,
            print_vat_on_receipt: Some(true),
            ..PrintedVatContext::load(&conn)
        };
        assert_eq!(context.order_vat_cents(None, Some(5.0)), None);
    }

    const RECEIPT_VAT_VECTORS: &str =
        include_str!("../../../../shared/services/__fixtures__/receipt-vat-vectors.json");

    #[test]
    fn port_reproduces_every_shared_receipt_vat_vector() {
        let vectors: Value = serde_json::from_str(RECEIPT_VAT_VECTORS).expect("vectors parse");
        let cases = vectors["cases"].as_array().expect("vector cases");
        assert_eq!(vectors["version"], 2, "the one-VAT rule of 21/10/2026");
        assert_eq!(cases.len(), 19, "the printed-VAT vector set has 19 cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let input = &case["input"];
            let computed = input.get("computedVatAmount").and_then(Value::as_f64);
            let printed = resolve_printed_vat_cents(
                input["fiscalActive"].as_bool().unwrap(),
                input.get("printVatOnReceipt").and_then(Value::as_bool),
                input.get("ratePercent").and_then(Value::as_f64),
                computed,
            );
            assert_eq!(printed, case["expectedVatCents"].as_i64(), "{name}: slip");
            assert_eq!(
                Some(resolve_z_order_vat_cents(computed)),
                case["expectedZVatCents"].as_i64(),
                "{name}: Z"
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn the_context_prints_by_the_switch_and_falls_back_to_the_owner_rate() {
        crate::fiscal::active_cache::reset_for_tests();
        let conn = device_db();
        crate::db::set_setting(&conn, "terminal", "branch_id", "branch-ctx").unwrap();
        let printed = |conn: &Connection| {
            PrintedVatContext::load(conn).order_vat_cents(Some("branch-ctx"), Some(4.44))
        };
        // No switch, no rate (Le Petit Paris today): no VAT line.
        assert_eq!(printed(&conn), None);
        // No switch yet, the 07/10 owner rate above 0%: the computed VAT,
        // never a VAT at the owner's rate.
        crate::db::set_setting(&conn, "tax", "default_tax_rate", "13").unwrap();
        assert_eq!(printed(&conn), Some(444));
        // Tomikro: the switch is off, whatever the rate.
        crate::db::set_setting(&conn, "tax", "vat_print_on_receipt", "false").unwrap();
        assert_eq!(printed(&conn), None);
        crate::db::set_setting(&conn, "tax", "default_tax_rate", "0").unwrap();
        crate::db::set_setting(&conn, "tax", "vat_print_on_receipt", "true").unwrap();
        assert_eq!(printed(&conn), Some(444));
        assert_eq!(
            PrintedVatContext::load(&conn).order_vat_cents(None, Some(0.0)),
            None,
            "a zero VAT never prints"
        );
        crate::db::set_setting(&conn, "tax", "vat_print_on_receipt", "maybe").unwrap();
        assert_eq!(print_vat_on_receipt_switch(&conn), None);

        let mut order = serde_json::json!({
            "branch_id": "branch-ctx", "total_amount": 24.65, "tip_amount": 1.0,
            "tax_amount": 9.99, "tax_amount_cents": 444
        });
        let switched_on = PrintedVatContext {
            print_vat_on_receipt: Some(true),
            ..PrintedVatContext::load(&conn)
        };
        attach_printed_vat_to_order_json(&switched_on, &mut order);
        assert_eq!(order["printedVatAmount"], 4.44, "the cents column wins");
        let switched_off = PrintedVatContext {
            print_vat_on_receipt: Some(false),
            ..PrintedVatContext::load(&conn)
        };
        attach_printed_vat_to_order_json(&switched_off, &mut order);
        assert_eq!(order["printedVatAmount"], Value::Null);
        crate::fiscal::active_cache::reset_for_tests();
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
