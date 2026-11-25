//! Presentation of BOX orders that have already been imported into the POS.
use crate::receipt_renderer::ReceiptCustomizationLine;

use crate::platform_slip_choices::selection;

pub(crate) fn format_customization(line: &mut ReceiptCustomizationLine, without_label: &str) {
    let label = line.name.trim();
    // BOX offer products carry their own selections inside parentheses.
    if let Some((product, rest)) = label.split_once(" (") {
        if let Some(options) = rest.strip_suffix(')').filter(|s| {
            !product.contains(": ")
                && s.split(", ")
                    .any(|option| option.contains(": ") || selection(option).1)
        }) {
            let options: Vec<_> = options
                .split(", ")
                .map(|option| {
                    let (name, without) = selection(option);
                    if without {
                        format!("{without_label} {name}")
                    } else {
                        name.to_owned()
                    }
                })
                .collect();
            line.name = format!("{product} ({})", options.join(", "));
            return;
        }
    }
    let (name, without) = selection(label);
    line.name = name.to_owned();
    line.is_without |= without;
}

pub(crate) fn is_box(plugin: &str, metadata: &str) -> bool {
    if !plugin.trim().is_empty() {
        return crate::platforms::normalize_platform_slug(plugin).as_deref() == Some("box");
    }
    if let Ok(meta) = serde_json::from_str::<serde_json::Value>(metadata) {
        if let Some(platform) = meta["food_delivery"]["platform"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        {
            return crate::platforms::normalize_platform_slug(platform).as_deref() == Some("box");
        }
    }
    false
}

fn is_transport_number(raw: &str) -> bool {
    // A transport identifier is never a rider reference.
    let mut parts = raw.trim().split('-');
    matches!((parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(prefix), Some(time), Some(suffix), None)
        if prefix.eq_ignore_ascii_case("box") && !time.is_empty() && time.bytes().all(|b| b.is_ascii_digit())
            && !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn rider_number(s: &str) -> Option<String> {
    let value = s.trim().strip_prefix('#').unwrap_or(s.trim());
    let digits = value
        .strip_prefix('B')
        .or_else(|| value.strip_prefix('b'))?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| format!("B{digits}"))
}

/// Only a rider-facing number can headline a BOX slip. The transport ID and
/// the customer's long platform reference belong to different namespaces.
pub(crate) fn order_code(metadata: &str, display: &str, raw: &str) -> Option<String> {
    let metadata = serde_json::from_str::<serde_json::Value>(metadata).ok();
    let food = metadata.as_ref().and_then(|v| v.get("food_delivery"));
    let field = |k: &str| food.and_then(|v| v.get(k)).and_then(|v| v.as_str());
    if let Some(code) = field("short_code")
        .map(str::trim)
        .map(|s| s.strip_prefix('#').unwrap_or(s))
    {
        if code
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric()))
            && !is_transport_number(code)
            && uuid::Uuid::parse_str(code).is_err()
            && !(code.len() >= 12 && code.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Some(rider_number(code).unwrap_or_else(|| code.to_owned()));
        }
    }
    field("reference")
        .and_then(rider_number)
        .or_else(|| rider_number(display))
        .or_else(|| rider_number(raw))
}

pub(crate) fn order_label(metadata: &str, display: &str, raw: &str) -> String {
    order_code(metadata, display, raw).unwrap_or_else(|| "BOX".to_owned())
}

pub(crate) fn checkout_number(
    plugin: Option<&str>,
    visible: Option<&str>,
    metadata: Option<&str>,
    raw: Option<&str>,
) -> Option<String> {
    let raw = raw.unwrap_or_default();
    if !is_box(plugin.unwrap_or_default(), metadata.unwrap_or_default()) {
        return None;
    }
    let code = order_code(
        metadata.unwrap_or_default(),
        visible.unwrap_or_default(),
        raw,
    );
    Some(code.map_or_else(|| "BOX".to_owned(), |code| format!("#{code}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_slip_prefixes_a_literal_box_code_on_driver_checkout() {
        let metadata = r#"{"food_delivery":{"short_code":"BOX"}}"#;
        assert_eq!(
            checkout_number(Some("box"), None, Some(metadata), None).as_deref(),
            Some("#BOX")
        );
        assert_eq!(
            checkout_number(Some("box"), None, None, None).as_deref(),
            Some("BOX")
        );
    }

    #[test]
    fn box_slip_prefers_stored_provider_references_and_skips_transport_ids() {
        let raw = "BOX-1794948068572-2F43E65D";
        let meta = r#"{"food_delivery":{"short_code":"ABC123","reference":"B416"}}"#;
        assert_eq!(order_label(meta, "B420", raw), "ABC123");
        assert_eq!(
            order_label(r#"{"food_delivery":{"short_code":"TEST-123"}}"#, "", raw),
            "TEST-123"
        );
        let uuid = r#"{"food_delivery":{"short_code":"7bade3fb-ca47-4d78-b217-5a647f95c676","reference":"B416"}}"#;
        assert_eq!(order_label(uuid, "B420", raw), "B416");
        assert_eq!(order_label("{}", raw, "#b421"), "B421");
        assert_eq!(order_label("{}", raw, ""), "BOX");
        assert_eq!(checkout_number(None, None, None, Some(raw)), None);
        assert!(!is_box("efood", ""));
        for alias in ["box_gr", "boxgr", "Box.gr"] {
            assert!(is_box(alias, ""));
        }
        assert!(is_box("", r#"{"food_delivery":{"platform":"boxgr"}}"#));
        assert_eq!(
            order_label(r#"{"food_delivery":{"short_code":"b416"}}"#, "", raw),
            "B416"
        );
        assert_eq!(
            order_label(r#"{"food_delivery":{"short_code":"ABC 123"}}"#, "", raw),
            "BOX"
        );
    }
}
