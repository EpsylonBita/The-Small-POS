//! JSON number spelling for the new parameter-bearing contracts. Omitted
//! legacy parameters retain their historical transport/approval digest.
use serde_json::Value;

pub fn canonical(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(0.0);
            if x == 0.0 {
                return "0".into();
            }
            if (1e-6..1e21).contains(&x.abs()) {
                return x.to_string();
            }
            let text = format!("{x:e}");
            let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
            let exponent = exponent.parse::<i32>().unwrap_or(0);
            format!(
                "{mantissa}e{}{exponent}",
                if exponent >= 0 { "+" } else { "" }
            )
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}:{}", Value::String(k.clone()), canonical(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => v.to_string(),
    }
}
pub fn hash(v: &Value) -> String {
    super::contracts::sha256(canonical(v).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmed_hash_matches_node_generated_parameter_vectors() {
        let rows: Value =
            serde_json::from_str(include_str!("confirmed_hash_vectors.json")).unwrap();
        for row in rows.as_array().unwrap() {
            assert_eq!(hash(&row["value"]), row["sha256"], "{}", row["value"]);
        }
    }
    #[test]
    fn confirmed_hash_matches_javascript_numbers_and_exact_parameter_types() {
        for (input, text) in [
            ("0.000001", "0.000001"),
            ("0.0000001", "1e-7"),
            ("1e21", "1e+21"),
            ("1e20", "100000000000000000000"),
            ("-0.0", "0"),
            ("1.25", "1.25"),
            ("5e-324", "5e-324"),
        ] {
            assert_eq!(canonical(&serde_json::from_str(input).unwrap()), text);
        }
        assert_ne!(
            hash(&serde_json::json!({"params":[1]})),
            hash(&serde_json::json!({"params":["1"]}))
        );
    }
}
