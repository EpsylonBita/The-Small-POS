// Copy this file and its module declaration to c9100305e, then run
// box_tip_slip_goldens with BOX_TIP_WRITE_BASE_GOLDENS=1. Wolt contact layouts follow
// the current release; use WOLT_WRITE_SLIP_GOLDENS=1 to regenerate only those fixtures.
use super::{
    default_printable_width_dots_for_paper, render_classic_customer_raster_exact_bitmap,
    render_classic_customer_raster_exact_ttf, render_escpos, render_html,
    ClassicCustomerRenderMode, EscPosBodyMode, LayoutConfig, OrderReceiptDoc, PaperWidth,
    ReceiptDocument, ReceiptTemplate,
};
use crate::{db, print::build_order_receipt_doc};
use image::GrayImage;
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, sync::Mutex};

struct SlipFixture {
    name: &'static str,
    plugin: &'static str,
    provider: &'static str,
    metadata_only: bool,
    b449: bool,
}

impl SlipFixture {
    fn receipt(&self, db: &db::DbState) -> OrderReceiptDoc {
        let phone = self.plugin.is_empty();
        let mut food = json!({
            "platform": self.plugin,
            "delivery_provider": self.provider,
            "payment_method": if self.b449 { "online" } else { "cash" },
            "prepaid": self.b449,
            "short_code": if self.plugin == "box" { "B449" } else { "4579" },
        });
        if self.plugin == "box" {
            food["box_daas"] = json!(self.provider == "platform_delivery");
            food["reference"] = json!("B449");
        }
        let metadata = if phone {
            String::new()
        } else {
            json!({"food_delivery": food}).to_string()
        };
        let items = json!([
            {"name":"Τοστ","quantity":1,"price":4.40,"notes":"χωρίς ντομάτα"},
            {"name":"Καφές","quantity":1,"price":2.50,"notes":"λίγη ζάχαρη"}
        ]);
        let instructions = if self.b449 {
            "όπως ανεβαίνετε αριστερά\n--- Order Items ---\n1x Τοστ\n1x Καφές"
        } else if phone {
            "Χτυπήστε το κουδούνι"
        } else {
            "--- Order Items ---\n1x Τοστ\n1x Καφές"
        };
        let (total_cents, tip_cents) = if self.b449 { (765, 75) } else { (690, 0) };
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, order_type, status, sync_status, plugin,
                    external_plugin_order_id, ghost_metadata, items, special_instructions,
                    total_amount, total_amount_cents, subtotal, subtotal_cents,
                    tip_amount, tip_amount_cents, created_at, updated_at, currency,
                    customer_name, customer_phone, delivery_address, estimated_time
                 ) VALUES (
                    ?1, ?2, 'delivery', 'ready', 'synced', ?3,
                    ?4, ?5, ?6, ?7,
                    ?8 / 100.0, ?8, 6.90, 690, ?9 / 100.0, ?9,
                    '2026-11-21T12:00:00Z', '2026-11-21T12:00:00Z', 'EUR',
                    'Μαρία', '6900000000', 'Μυτιλήνης 4', 15
                 )",
                params![
                    self.name,
                    if self.plugin == "box" {
                        "BOX-1795286965261-6122F7E0"
                    } else {
                        "ORD-20261121-00019"
                    },
                    if self.metadata_only { "" } else { self.plugin },
                    if phone || self.metadata_only {
                        ""
                    } else {
                        "64656368"
                    },
                    metadata,
                    items.to_string(),
                    instructions,
                    total_cents,
                    tip_cents,
                ],
            )
            .unwrap();
        }
        build_order_receipt_doc(db, self.name).unwrap()
    }
}

fn pixel_hash(image: GrayImage) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update(image.width().to_le_bytes());
    hash.update(image.height().to_le_bytes());
    hash.update(image.as_raw());
    format!("{}\n", crate::core_helpers::lower_hex(&hash.finalize())).into_bytes()
}

#[test]
fn box_tip_slip_goldens_match_the_release() {
    let write = std::env::var("BOX_TIP_WRITE_BASE_GOLDENS").as_deref() == Ok("1");
    let update_wolt = std::env::var("WOLT_WRITE_SLIP_GOLDENS").as_deref() == Ok("1");
    let golden_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/receipt_renderer/testdata/box-tip-base-goldens");
    if write {
        fs::create_dir_all(&golden_dir).unwrap();
    }
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations_for_test(&conn);
    db::set_setting(&conn, "general", "language", "el").unwrap();
    let db = db::DbState {
        conn: Mutex::new(conn),
        db_path: ":memory:".into(),
    };
    for (name, plugin, provider, metadata_only, b449) in [
        ("box-own", "box", "vendor_delivery", false, false),
        ("box-courier", "box", "platform_delivery", false, false),
        ("efood-own", "efood", "vendor_delivery", false, false),
        ("efood-courier", "efood", "platform_delivery", false, false),
        ("wolt-own", "wolt", "vendor_delivery", false, false),
        ("wolt-courier", "wolt", "platform_delivery", false, false),
        ("legacy-efood", "efood", "vendor_delivery", true, false),
        ("phone", "", "", false, false),
        (
            "b449-released-reference",
            "box",
            "vendor_delivery",
            false,
            true,
        ),
    ] {
        if update_wolt && plugin != "wolt" {
            continue;
        }
        let receipt = SlipFixture {
            name,
            plugin,
            provider,
            metadata_only,
            b449,
        }
        .receipt(&db);
        for (kind, document) in [
            ("receipt", ReceiptDocument::OrderReceipt(receipt.clone())),
            ("delivery", ReceiptDocument::DeliverySlip(receipt)),
        ] {
            for (mm, paper_width) in [(58, PaperWidth::Mm58), (80, PaperWidth::Mm80)] {
                let cfg = LayoutConfig {
                    paper_width,
                    template: ReceiptTemplate::Classic,
                    printable_width_dots: default_printable_width_dots_for_paper(paper_width),
                    organization_name: "ΤΟ ΜΙΚΡΟ ΠΑΡΙΣΙ".into(),
                    language: "el".into(),
                    character_set: "PC737_GREEK".into(),
                    currency_symbol: "€".into(),
                    store_time_zone: Some(chrono_tz::Europe::Athens),
                    decimal_comma: true,
                    classic_customer_render_mode: ClassicCustomerRenderMode::Text,
                    ..LayoutConfig::default()
                };
                let text = render_escpos(&document, &cfg);
                assert_eq!(text.body_mode, EscPosBodyMode::Text);
                let html = render_html(&document, &cfg);
                if b449 && !write {
                    assert!(html.contains("Φιλοδώρημα διανομέα"));
                    assert!(html.contains("Σχόλια:"));
                    assert!(html.contains("Όπως ανεβαίνετε αριστερά"));
                }
                for (ext, actual) in [
                    ("escpos", text.bytes),
                    (
                        "ttf.sha256",
                        pixel_hash(
                            render_classic_customer_raster_exact_ttf(&document, &cfg).unwrap(),
                        ),
                    ),
                    (
                        "bitmap.sha256",
                        pixel_hash(
                            render_classic_customer_raster_exact_bitmap(&document, &cfg).unwrap(),
                        ),
                    ),
                    ("html", html.into_bytes()),
                ] {
                    let path = golden_dir.join(format!("{name}-{kind}-{mm}mm.{ext}"));
                    if write || update_wolt {
                        fs::write(path, actual).unwrap();
                    } else {
                        let released = fs::read(&path)
                            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                        if b449 {
                            // This fixture is a reference for the intended tip/comment change.
                            assert_ne!(actual, released, "{}", path.display());
                        } else {
                            assert!(actual == released, "slip differs from {}", path.display());
                        }
                    }
                }
            }
        }
    }
}
