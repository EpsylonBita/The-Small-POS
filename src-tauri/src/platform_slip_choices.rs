//! Ingredient labels on imported platform orders. Only apply to selected modifiers.
fn folded(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'ά' => 'α',
            'έ' => 'ε',
            'ή' => 'η',
            'ί' | 'ϊ' | 'ΐ' => 'ι',
            'ό' => 'ο',
            'ύ' | 'ϋ' | 'ΰ' => 'υ',
            'ώ' => 'ω',
            'ς' => 'σ',
            c => c,
        })
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect()
}

pub(crate) fn selection(label: &str) -> (&str, bool) {
    let (group, option) = label.split_once(": ").unwrap_or(("", label));
    let option = option.trim();
    if option.is_empty()
        || matches!(
            folded(option).as_str(),
            "ναι"
                | "οχι"
                | "καμια"
                | "κανενα"
                | "κανενασ"
                | "καθολου"
                | "χωρισ"
                | "yes"
                | "no"
                | "none"
                | "without"
        )
    {
        return (label, false);
    }
    if let Some((word, ingredient)) = option.split_once(char::is_whitespace) {
        if matches!(folded(word).as_str(), "χωρισ" | "without" | "no") {
            return (ingredient.trim(), true);
        }
    }
    let group = folded(group.trim().trim_end_matches([';', '?', ':', '·']));
    let words: Vec<_> = group.split_whitespace().collect();
    let heading = matches!(
        words.as_slice(),
        ["χωρισ"] | ["χωρισ", "υλικα"] | ["without"] | ["without", "ingredients"] | ["no"]
    );
    let remove = heading
        || matches!(
            words.first().copied(),
            Some(
                "βγαλτε"
                    | "exclude"
                    | "αφαιρεστε"
                    | "αφαιρεση"
                    | "αφαιρεσεισ"
                    | "αφαιρεσησ"
                    | "remove"
                    | "removal"
                    | "removals"
                    | "hold"
                    | "omit"
            )
        )
        || words.windows(2).any(|w| {
            matches!(
                w,
                ["προσ" | "για", "αφαιρεση"]
                    | ["to", "remove" | "omit"]
                    | ["μη" | "μην", "βαλετε"]
                    | ["δε" | "δεν", "θελετε"]
            ) || (w[0] == "να" && (w[1].starts_with("αφαιρεθ") || w[1].starts_with("αφαιρεσ")))
        });
    (option, remove)
}

/// A legacy cached import can have no plugin column. A declared provider always
/// wins over an internal transport number. This is only a printing hint.
pub(crate) fn is_wolt_order(plugin: &str, metadata: &str, order_number: &str) -> bool {
    if !plugin.trim().is_empty() {
        return plugin.trim().eq_ignore_ascii_case("wolt");
    }
    if let Some(food) = crate::payments::food_delivery_from_metadata(metadata.to_owned()) {
        if let Some(platform) = food
            .get("platform")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return platform.eq_ignore_ascii_case("wolt");
        }
    }
    let Some((prefix, body)) = order_number.trim().split_once('-') else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("wolt") {
        return false;
    }
    if let Some((timestamp, suffix)) = body.split_once('-') {
        return timestamp.len() == 13
            && timestamp.bytes().all(|b| b.is_ascii_digit())
            && (1..=8).contains(&suffix.len())
            && suffix.bytes().all(|b| b.is_ascii_alphanumeric());
    }
    body.len() == 24 && body.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Older Wolt orders join the option group and its chosen value in one string.
/// Keep the subject of fees and yes/no choices, and the qualifier of an extra.
pub(crate) fn wolt_selection(label: &str) -> (&str, bool) {
    let label = label.trim();
    if let Some((group, value)) = label.split_once(": ") {
        let group = folded(group.trim());
        let choice = folded(value.trim());
        if group != choice {
            let words = group.split(|c: char| !c.is_alphanumeric());
            if matches!(group.as_str(), "extra" | "extras" | "εξτρα")
                || words.into_iter().any(|word| {
                    matches!(
                        word,
                        "τελοσ"
                            | "τελη"
                            | "χρεωση"
                            | "εισφορα"
                            | "fee"
                            | "fees"
                            | "charge"
                            | "deposit"
                            | "tax"
                    )
                })
            {
                return (label, false);
            }
        }
    }
    selection(label)
}
