//! Single source of truth for "is this order's `plugin` an EXTERNAL platform?".
//!
//! Founder incident 16/09/2026: the Z-report printed «POS x37» inside the
//! ΠΛΑΤΦΟΡΜΕΣ block, next to efood and Wolt. `orders.plugin = 'pos'` is the
//! store's OWN till — an order SOURCE, never an external platform — and it
//! must never reach platform turnover, platform settlement, or the
//! rider-facing slip banner.
//!
//! The bug was not one bad line; it was three different questions asked in
//! three different dialects:
//!   * `zreport.rs` grouped on `TRIM(COALESCE(o.plugin,'')) != ''`
//!     (everything non-empty is a platform → `pos` counted),
//!   * `print.rs::is_food_delivery_plugin` kept a hand-written `matches!`,
//!   * `renderer/utils/plugin-icons.tsx` kept a third allowlist.
//!
//! Every accounting surface now calls [`classify_order_platform`] (Rust) or
//! `classifyOrderPlatform` (`shared/platforms/order-platforms.ts`). The two
//! implementations are kept in lockstep by
//! `tests/renderer/platform-classification-parity.test.ts`.
//!
//! ## Classification contract
//!
//! | `plugin` value        | class                 | meaning                  |
//! |-----------------------|-----------------------|--------------------------|
//! | `''` / whitespace     | `None`                | plain store order        |
//! | `pos`,`kiosk`,`web`,`android-ios` | `Internal`| our own channels         |
//! | the 13 slugs below    | `ExternalMarketplace` | somebody else's marketplace |
//! | anything else         | `Unknown`             | a source we cannot name  |
//!
//! ### Why `Unknown` exists, and is not folded into "external"
//!
//! The word "plugin" is overloaded in this system. `plugin_integrations` /
//! `plugin_credentials` catalog `mydata`, `stripe`, `viva`, `google_analytics`,
//! `woocommerce` and `shopify` — e-invoicing, payment gateways, analytics and
//! e-commerce. Those are a DIFFERENT namespace from an order source, and two of
//! them (`woocommerce`, `shopify`) are flagged `supports_order_sync: true` in
//! the catalog. None of them reaches `orders.plugin` today (audited
//! 16/09/2026 — every server writer emits a value from a closed set: `'pos'`
//! hardcoded twice, `'web'` from the kiosk route, and one of the 13 slugs below
//! from the webhook transformer behind `isValidWebhookPlatform`). But
//! `sync::create_order` accepts the field verbatim from its payload with no
//! allowlist, and the day someone wires up WooCommerce order sync the obvious
//! thing to write is `platform = 'woocommerce'`.
//!
//! An "everything else is a marketplace" rule would then file a web-shop order
//! — or a mis-mapped payment-gateway name — under ΠΛΑΤΦΟΡΜΕΣ as if efood had
//! delivered it. So the marketplace set is CLOSED, and an unrecognised slug is
//! `Unknown`: it never enters the platform breakdown.
//!
//! `Unknown` costs nothing in money terms. The ΠΛΑΤΦΟΡΜΕΣ block is a
//! BREAKDOWN, not a total: `sales.totalSales` comes from `orders` and
//! `daySummary.total` from `order_payments`, and neither reads
//! `sales.platforms`. An unknown-source order keeps its full weight in both.
//! What it loses is only its attribution to a named platform — and it does not
//! lose that silently either: the Z's `integrity.unclassifiedPlatforms` names
//! the slug, the order count and the amount, so the slug can be added here.
//!
//! Presentation (logo, brand colour, rider banner) keeps its own closed
//! allowlists, which are a subset of the marketplace set.

/// Our own order sources. Closed set: we ship every one of these.
pub(crate) const INTERNAL_ORDER_PLATFORMS: &[&str] = &["pos", "kiosk", "web", "android-ios"];

/// Food-delivery aggregators we have integrated. Closed set — it drives the
/// rider-facing slip banner, which needs a real brand name to be useful.
pub(crate) const EXTERNAL_DELIVERY_PLATFORMS: &[&str] = &[
    "efood",
    "wolt",
    "box",
    "glovo",
    "bolt_food",
    "uber_eats",
    "just_eat_takeaway",
    "deliveroo",
    "foodora",
    "smood",
];

/// Stay/table marketplaces. External money, but never a food-delivery slip.
pub(crate) const EXTERNAL_BOOKING_PLATFORMS: &[&str] = &["booking", "tripadvisor", "airbnb"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OrderPlatformClass {
    /// No plugin recorded — a plain store order.
    None,
    /// One of our own channels (`pos`, `kiosk`, `web`, `android-ios`).
    Internal,
    /// A marketplace we have integrated: efood, Wolt, Booking.com, …
    ExternalMarketplace,
    /// A source we cannot name. Never reported as a platform — see the module
    /// header for why this is a class of its own rather than "external".
    Unknown,
}

impl OrderPlatformClass {
    /// Wire/report name, used by the Z's `integrity.unclassifiedPlatforms`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OrderPlatformClass::None => "none",
            OrderPlatformClass::Internal => "internal",
            OrderPlatformClass::ExternalMarketplace => "external_marketplace",
            OrderPlatformClass::Unknown => "unknown",
        }
    }
}

/// Every marketplace slug we can name. CLOSED on purpose.
fn is_known_marketplace_slug(slug: &str) -> bool {
    EXTERNAL_DELIVERY_PLATFORMS.contains(&slug) || EXTERNAL_BOOKING_PLATFORMS.contains(&slug)
}

/// Spelling variants seen in the wild. The server column is `platform`, the
/// POS column is `plugin`, and aggregator payloads have used every casing and
/// separator — so normalize before comparing, never compare raw strings.
///
/// Mirrors `PLATFORM_SLUG_ALIASES` in
/// `shared/platforms/order-platforms.ts`.
const PLATFORM_SLUG_ALIASES: &[(&str, &str)] = &[
    ("ubereats", "uber_eats"),
    ("bolt", "bolt_food"),
    ("boltfood", "bolt_food"),
    ("justeat", "just_eat_takeaway"),
    ("just_eat", "just_eat_takeaway"),
    ("takeaway", "just_eat_takeaway"),
    ("takeawaycom", "just_eat_takeaway"),
    ("e_food", "efood"),
    ("box_gr", "box"),
    ("boxgr", "box"),
    ("booking_com", "booking"),
    ("trip_advisor", "tripadvisor"),
    ("android_ios", "android-ios"),
    ("androidios", "android-ios"),
    ("pos_terminal", "pos"),
    ("posterminal", "pos"),
    ("in_store", "pos"),
    ("instore", "pos"),
    ("self_service", "kiosk"),
    ("selfservice", "kiosk"),
    ("website", "web"),
    ("web_app", "web"),
    ("webapp", "web"),
    ("online_store", "web"),
    ("mobile_app", "android-ios"),
    ("mobileapp", "android-ios"),
];

/// Lowercase, punctuation-folded slug, or `None` when nothing was recorded.
/// `android-ios` is the one canonical slug carrying a hyphen, so the fold
/// runs through the alias table rather than keeping hyphens verbatim.
pub(crate) fn normalize_platform_slug(value: &str) -> Option<String> {
    let mut folded = String::with_capacity(value.len());
    let mut pending_separator = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_separator && !folded.is_empty() {
                folded.push('_');
            }
            pending_separator = false;
            folded.push(ch.to_ascii_lowercase());
        } else {
            pending_separator = true;
        }
    }
    if folded.is_empty() {
        return None;
    }
    for (alias, canonical) in PLATFORM_SLUG_ALIASES {
        if folded == *alias {
            return Some((*canonical).to_string());
        }
    }
    Some(folded)
}

/// The one classification every accounting surface must call.
pub(crate) fn classify_order_platform(value: &str) -> OrderPlatformClass {
    match normalize_platform_slug(value) {
        None => OrderPlatformClass::None,
        Some(slug) if INTERNAL_ORDER_PLATFORMS.contains(&slug.as_str()) => {
            OrderPlatformClass::Internal
        }
        Some(slug) if is_known_marketplace_slug(slug.as_str()) => {
            OrderPlatformClass::ExternalMarketplace
        }
        Some(_) => OrderPlatformClass::Unknown,
    }
}

/// True only for money that reaches us through a marketplace we can NAME.
/// `pos` / `kiosk` / `web` / `android-ios` are false by construction — that is
/// the whole point of this module — and so is any slug we do not recognise.
pub(crate) fn is_external_marketplace(value: &str) -> bool {
    classify_order_platform(value) == OrderPlatformClass::ExternalMarketplace
}

/// A source that is recorded but that we cannot name. Reported, never counted
/// as a platform.
pub(crate) fn is_unknown_platform(value: &str) -> bool {
    classify_order_platform(value) == OrderPlatformClass::Unknown
}

/// Closed check: does this platform hand slips to an external rider?
/// Used by the receipt banner and by platform settlement eligibility, both of
/// which need a platform we have actually integrated.
pub(crate) fn is_external_delivery_platform(value: &str) -> bool {
    normalize_platform_slug(value)
        .map(|slug| EXTERNAL_DELIVERY_PLATFORMS.contains(&slug.as_str()))
        .unwrap_or(false)
}

/// Closed check: is this a platform we can name (logo, brand colour)?
/// Identical to [`is_external_marketplace`] today; kept as its own name
/// because presentation and accounting are different questions.
pub(crate) fn is_known_external_platform(value: &str) -> bool {
    is_external_marketplace(value)
}

/// SQLite expression folding a plugin column to the comparison form used by
/// the predicates below. SQLite has no regex, so this covers the two folds
/// that actually occur in the column — case and the `-`/space/`.` separators
/// — which is enough to recognize every internal spelling we have ever
/// written. Unknown spellings fall through to "external", the safe side.
fn normalized_plugin_sql_expr(plugin_expr: &str) -> String {
    format!(
        "REPLACE(REPLACE(REPLACE(LOWER(TRIM(COALESCE({plugin_expr}, ''))), '-', '_'), ' ', '_'), '.', '_')"
    )
}

/// Builds a SQL literal list from a set of canonical slugs, adding every
/// alias that folds into one of them, so the SQL recognises the same
/// spellings the Rust classifier does.
fn sql_slug_list(canonical: &[&str]) -> String {
    let mut slugs: Vec<String> = canonical.iter().map(|s| s.replace('-', "_")).collect();
    for (alias, target) in PLATFORM_SLUG_ALIASES {
        if canonical.contains(target) {
            slugs.push(alias.replace('-', "_"));
        }
    }
    slugs.sort();
    slugs.dedup();
    slugs
        .into_iter()
        .map(|slug| format!("'{slug}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn marketplace_sql_list() -> String {
    let mut all: Vec<&str> = EXTERNAL_DELIVERY_PLATFORMS.to_vec();
    all.extend_from_slice(EXTERNAL_BOOKING_PLATFORMS);
    sql_slug_list(&all)
}

/// SQL predicate: true when `plugin_expr` names a marketplace we can NAME.
/// This is the replacement for the `TRIM(COALESCE(o.plugin,'')) != ''` test
/// that put «POS x37» on the founder's Z slip. The list is closed, so a slug
/// we do not recognise answers false here and is reported separately rather
/// than being filed under ΠΛΑΤΦΟΡΜΕΣ.
pub(crate) fn external_marketplace_sql_predicate(plugin_expr: &str) -> String {
    format!(
        "({normalized} IN ({marketplaces}))",
        normalized = normalized_plugin_sql_expr(plugin_expr),
        marketplaces = marketplace_sql_list()
    )
}

/// SQL predicate: true when a source IS recorded but names neither one of our
/// own channels nor a marketplace we know. Drives
/// `integrity.unclassifiedPlatforms`, so such money is visible rather than
/// silently uncategorised.
pub(crate) fn unknown_platform_sql_predicate(plugin_expr: &str) -> String {
    format!(
        "({normalized} <> '' AND {normalized} NOT IN ({internal}) AND {normalized} NOT IN ({marketplaces}))",
        normalized = normalized_plugin_sql_expr(plugin_expr),
        internal = sql_slug_list(INTERNAL_ORDER_PLATFORMS),
        marketplaces = marketplace_sql_list()
    )
}

/// SQL expression producing the platform label for GROUP BY: the lowercased
/// plugin for known marketplaces, `''` for everything else. Pairs with
/// [`external_marketplace_sql_predicate`] so a row can never be grouped under
/// a platform it is not.
pub(crate) fn external_marketplace_label_sql_expr(plugin_expr: &str) -> String {
    format!(
        "CASE WHEN {predicate} THEN LOWER(TRIM(COALESCE({plugin_expr}, ''))) ELSE '' END",
        predicate = external_marketplace_sql_predicate(plugin_expr)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn pos_is_never_an_external_platform() {
        // The founder-facing bug, pinned: «POS x37» must not be a platform.
        assert_eq!(classify_order_platform("pos"), OrderPlatformClass::Internal);
        assert!(!is_external_marketplace("pos"));
        assert!(!is_external_marketplace("POS"));
        assert!(!is_external_marketplace(" Pos "));
        assert!(!is_external_marketplace("pos_terminal"));
        assert!(!is_external_delivery_platform("pos"));
        assert!(!is_unknown_platform("pos"));
    }

    #[test]
    fn the_other_internal_channels_are_internal_too() {
        for slug in ["kiosk", "web", "android-ios", "android_ios", "website"] {
            assert_eq!(
                classify_order_platform(slug),
                OrderPlatformClass::Internal,
                "{slug} must classify as internal"
            );
        }
    }

    #[test]
    fn named_marketplaces_are_external() {
        for slug in ["efood", "EFOOD", "e-food", "wolt", "box", "uber eats"] {
            assert_eq!(
                classify_order_platform(slug),
                OrderPlatformClass::ExternalMarketplace,
                "{slug} must classify as an external marketplace"
            );
        }
        assert!(is_external_delivery_platform("efood"));
        assert!(is_external_delivery_platform("uber eats"));
    }

    #[test]
    fn booking_marketplaces_are_external_but_not_delivery() {
        assert_eq!(
            classify_order_platform("booking.com"),
            OrderPlatformClass::ExternalMarketplace
        );
        assert!(!is_external_delivery_platform("booking.com"));
        assert!(is_known_external_platform("booking.com"));
    }

    #[test]
    fn a_source_we_cannot_name_is_unknown_and_never_a_platform() {
        // Audit 16/09/2026: "plugin" is overloaded — `plugin_integrations`
        // catalogs mydata/stripe/viva/google_analytics/woocommerce/shopify,
        // and woocommerce/shopify are flagged `supports_order_sync`. None of
        // them reaches `orders.plugin` today, but `sync::create_order` takes
        // the field verbatim from its payload, so an unrecognised slug must
        // never be filed under ΠΛΑΤΦΟΡΜΕΣ as if a marketplace delivered it.
        for slug in [
            "woocommerce",
            "shopify",
            "stripe",
            "viva",
            "mydata",
            "google_analytics",
            "brand_new_delivery_app",
        ] {
            assert_eq!(
                classify_order_platform(slug),
                OrderPlatformClass::Unknown,
                "{slug} must classify as unknown, not as a marketplace"
            );
            assert!(is_unknown_platform(slug));
            assert!(!is_external_marketplace(slug));
            assert!(!is_known_external_platform(slug));
            assert!(!is_external_delivery_platform(slug));
        }
    }

    #[test]
    fn empty_and_whitespace_are_not_platforms() {
        assert_eq!(classify_order_platform(""), OrderPlatformClass::None);
        assert_eq!(classify_order_platform("   "), OrderPlatformClass::None);
        assert_eq!(classify_order_platform("--"), OrderPlatformClass::None);
        assert!(!is_external_marketplace(""));
        assert!(!is_unknown_platform(""));
    }

    #[test]
    fn the_four_classes_are_mutually_exclusive_and_total() {
        for slug in [
            "",
            "   ",
            "pos",
            "kiosk",
            "web",
            "android-ios",
            "efood",
            "wolt",
            "booking",
            "woocommerce",
            "stripe",
            "anything_else",
        ] {
            let class = classify_order_platform(slug);
            let flags = [
                class == OrderPlatformClass::None,
                class == OrderPlatformClass::Internal,
                is_external_marketplace(slug),
                is_unknown_platform(slug),
            ];
            assert_eq!(
                flags.iter().filter(|set| **set).count(),
                1,
                "{slug} must land in exactly one class, got {class:?}"
            );
        }
    }

    /// Every sample the SQL tests run, with the spelling variants that matter.
    const SQL_SAMPLES: &[&str] = &[
        "pos",
        "POS",
        "Pos",
        "pos_terminal",
        "kiosk",
        "web",
        "Website",
        "android-ios",
        "android_ios",
        "efood",
        "EFOOD",
        "e-food",
        "wolt",
        "box",
        "uber_eats",
        "uber eats",
        "booking",
        "booking.com",
        "woocommerce",
        "shopify",
        "stripe",
        "brand_new_app",
        "",
        "   ",
    ];

    fn seeded_sample_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("CREATE TABLE orders (id TEXT PRIMARY KEY, plugin TEXT)")
            .expect("create orders");
        for (index, sample) in SQL_SAMPLES.iter().enumerate() {
            conn.execute(
                "INSERT INTO orders (id, plugin) VALUES (?1, ?2)",
                rusqlite::params![format!("order-{index}"), sample],
            )
            .expect("insert sample");
        }
        conn.execute(
            "INSERT INTO orders (id, plugin) VALUES ('order-null', NULL)",
            [],
        )
        .expect("insert null sample");
        conn
    }

    #[test]
    fn sql_marketplace_predicate_agrees_with_the_rust_classifier() {
        let conn = seeded_sample_db();
        let predicate = external_marketplace_sql_predicate("plugin");
        let sql = format!("SELECT COALESCE(plugin, ''), {predicate} FROM orders");
        let mut stmt = conn.prepare(&sql).expect("prepare predicate query");
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("run predicate query")
            .map(|row| row.expect("read predicate row"))
            .collect();

        assert_eq!(rows.len(), SQL_SAMPLES.len() + 1);
        for (plugin, sql_says_marketplace) in rows {
            assert_eq!(
                sql_says_marketplace == 1,
                is_external_marketplace(&plugin),
                "SQL marketplace predicate and Rust classifier disagree on {plugin:?}"
            );
        }
    }

    #[test]
    fn sql_unknown_predicate_agrees_with_the_rust_classifier() {
        let conn = seeded_sample_db();
        let predicate = unknown_platform_sql_predicate("plugin");
        let sql = format!("SELECT COALESCE(plugin, ''), {predicate} FROM orders");
        let mut stmt = conn.prepare(&sql).expect("prepare unknown query");
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("run unknown query")
            .map(|row| row.expect("read unknown row"))
            .collect();

        for (plugin, sql_says_unknown) in rows {
            assert_eq!(
                sql_says_unknown == 1,
                is_unknown_platform(&plugin),
                "SQL unknown predicate and Rust classifier disagree on {plugin:?}"
            );
        }
    }

    #[test]
    fn sql_predicates_never_overlap() {
        // A row cannot be both a marketplace and unknown, or the ΠΛΑΤΦΟΡΜΕΣ
        // section and the unclassified report would double-count it.
        let conn = seeded_sample_db();
        let overlapping: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM orders WHERE {market} AND {unknown}",
                    market = external_marketplace_sql_predicate("plugin"),
                    unknown = unknown_platform_sql_predicate("plugin"),
                ),
                [],
                |row| row.get(0),
            )
            .expect("overlap query");
        assert_eq!(overlapping, 0);
    }

    #[test]
    fn sql_label_expression_blanks_everything_but_named_marketplaces() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE orders (id TEXT PRIMARY KEY, plugin TEXT);
             INSERT INTO orders VALUES ('a', 'pos'), ('b', 'efood'), ('c', 'Kiosk'),
                                       ('d', NULL), ('e', 'woocommerce');",
        )
        .expect("seed orders");

        let label = external_marketplace_label_sql_expr("plugin");
        let mut stmt = conn
            .prepare(&format!("SELECT id, {label} FROM orders ORDER BY id"))
            .expect("prepare label query");
        let labels: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("run label query")
            .map(|row| row.expect("read label row"))
            .collect();

        assert_eq!(
            labels,
            vec![
                ("a".to_string(), String::new()),
                ("b".to_string(), "efood".to_string()),
                ("c".to_string(), String::new()),
                ("d".to_string(), String::new()),
                // An e-commerce plugin is NOT a delivery marketplace.
                ("e".to_string(), String::new()),
            ]
        );
    }
}
