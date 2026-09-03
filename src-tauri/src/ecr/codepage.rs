//! Windows-1253 (Greek) code page helpers for vendor file drivers.
//!
//! Some RBS/MAT CAP Driver installations are configured for ANSI 1253 instead
//! of UTF-8 (the EMDI/Pegasus integration guides set the service to 1253).
//! Command files must then be written in that code page and the service's
//! Output/log files decoded with it, otherwise `ΜΕΤΡΗΤΑ`/`ΚΑΡΤΑ` in the
//! payment lines reach the cashier as mojibake. Hand-rolled like
//! `escpos::encode_cp737` so no new crate enters the dependency graph.

/// Upper half (`0x80..=0xFF`) of Windows-1253. `None` marks bytes the code
/// page leaves undefined.
const CP1253_HIGH: [Option<char>; 128] = [
    // 0x80..=0x8F
    Some('\u{20AC}'),
    None,
    Some('\u{201A}'),
    Some('\u{0192}'),
    Some('\u{201E}'),
    Some('\u{2026}'),
    Some('\u{2020}'),
    Some('\u{2021}'),
    None,
    Some('\u{2030}'),
    None,
    Some('\u{2039}'),
    None,
    None,
    None,
    None,
    // 0x90..=0x9F
    None,
    Some('\u{2018}'),
    Some('\u{2019}'),
    Some('\u{201C}'),
    Some('\u{201D}'),
    Some('\u{2022}'),
    Some('\u{2013}'),
    Some('\u{2014}'),
    None,
    Some('\u{2122}'),
    None,
    Some('\u{203A}'),
    None,
    None,
    None,
    None,
    // 0xA0..=0xAF
    Some('\u{00A0}'),
    Some('\u{0385}'),
    Some('\u{0386}'),
    Some('\u{00A3}'),
    Some('\u{00A4}'),
    Some('\u{00A5}'),
    Some('\u{00A6}'),
    Some('\u{00A7}'),
    Some('\u{00A8}'),
    Some('\u{00A9}'),
    None,
    Some('\u{00AB}'),
    Some('\u{00AC}'),
    Some('\u{00AD}'),
    Some('\u{00AE}'),
    Some('\u{2015}'),
    // 0xB0..=0xBF
    Some('\u{00B0}'),
    Some('\u{00B1}'),
    Some('\u{00B2}'),
    Some('\u{00B3}'),
    Some('\u{0384}'),
    Some('\u{00B5}'),
    Some('\u{00B6}'),
    Some('\u{00B7}'),
    Some('\u{0388}'),
    Some('\u{0389}'),
    Some('\u{038A}'),
    Some('\u{00BB}'),
    Some('\u{038C}'),
    Some('\u{00BD}'),
    Some('\u{038E}'),
    Some('\u{038F}'),
    // 0xC0..=0xCF: ΐ Α Β Γ Δ Ε Ζ Η Θ Ι Κ Λ Μ Ν Ξ Ο
    Some('\u{0390}'),
    Some('\u{0391}'),
    Some('\u{0392}'),
    Some('\u{0393}'),
    Some('\u{0394}'),
    Some('\u{0395}'),
    Some('\u{0396}'),
    Some('\u{0397}'),
    Some('\u{0398}'),
    Some('\u{0399}'),
    Some('\u{039A}'),
    Some('\u{039B}'),
    Some('\u{039C}'),
    Some('\u{039D}'),
    Some('\u{039E}'),
    Some('\u{039F}'),
    // 0xD0..=0xDF: Π Ρ (undefined) Σ Τ Υ Φ Χ Ψ Ω Ϊ Ϋ ά έ ή ί
    Some('\u{03A0}'),
    Some('\u{03A1}'),
    None,
    Some('\u{03A3}'),
    Some('\u{03A4}'),
    Some('\u{03A5}'),
    Some('\u{03A6}'),
    Some('\u{03A7}'),
    Some('\u{03A8}'),
    Some('\u{03A9}'),
    Some('\u{03AA}'),
    Some('\u{03AB}'),
    Some('\u{03AC}'),
    Some('\u{03AD}'),
    Some('\u{03AE}'),
    Some('\u{03AF}'),
    // 0xE0..=0xEF: ΰ α β γ δ ε ζ η θ ι κ λ μ ν ξ ο
    Some('\u{03B0}'),
    Some('\u{03B1}'),
    Some('\u{03B2}'),
    Some('\u{03B3}'),
    Some('\u{03B4}'),
    Some('\u{03B5}'),
    Some('\u{03B6}'),
    Some('\u{03B7}'),
    Some('\u{03B8}'),
    Some('\u{03B9}'),
    Some('\u{03BA}'),
    Some('\u{03BB}'),
    Some('\u{03BC}'),
    Some('\u{03BD}'),
    Some('\u{03BE}'),
    Some('\u{03BF}'),
    // 0xF0..=0xFF: π ρ ς σ τ υ φ χ ψ ω ϊ ϋ ό ύ ώ (undefined)
    Some('\u{03C0}'),
    Some('\u{03C1}'),
    Some('\u{03C2}'),
    Some('\u{03C3}'),
    Some('\u{03C4}'),
    Some('\u{03C5}'),
    Some('\u{03C6}'),
    Some('\u{03C7}'),
    Some('\u{03C8}'),
    Some('\u{03C9}'),
    Some('\u{03CA}'),
    Some('\u{03CB}'),
    Some('\u{03CC}'),
    Some('\u{03CD}'),
    Some('\u{03CE}'),
    None,
];

/// Encode text as Windows-1253. Characters outside the code page become `?`
/// so a receipt line never silently changes length or meaning by dropping
/// bytes; the cashier prints the placeholder instead.
pub fn encode_cp1253(text: &str) -> Vec<u8> {
    text.chars()
        .map(|ch| {
            if ch.is_ascii() {
                ch as u8
            } else {
                CP1253_HIGH
                    .iter()
                    .position(|entry| *entry == Some(ch))
                    .map(|index| 0x80 + index as u8)
                    .unwrap_or(b'?')
            }
        })
        .collect()
}

/// Decode Windows-1253 bytes. Undefined bytes become U+FFFD so the caller can
/// still search the text for the driver's `Error 0x..` markers.
pub fn decode_cp1253(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| {
            if byte < 0x80 {
                byte as char
            } else {
                CP1253_HIGH[(byte - 0x80) as usize].unwrap_or('\u{FFFD}')
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greek_capitals_map_to_the_windows_1253_upper_half() {
        assert_eq!(
            encode_cp1253("ΜΕΤΡΗΤΑ"),
            vec![0xCC, 0xC5, 0xD4, 0xD1, 0xC7, 0xD4, 0xC1]
        );
        assert_eq!(encode_cp1253("ΚΑΡΤΑ"), vec![0xCA, 0xC1, 0xD1, 0xD4, 0xC1]);
        assert_eq!(encode_cp1253("€"), vec![0x80]);
    }

    #[test]
    fn ascii_passes_through_unchanged() {
        assert_eq!(
            encode_cp1253("SL/ITEM//1.000/0.01/3/24"),
            b"SL/ITEM//1.000/0.01/3/24"
        );
    }

    #[test]
    fn unmappable_characters_become_a_question_mark_of_the_same_length() {
        assert_eq!(encode_cp1253("A→B"), b"A?B");
        assert_eq!(encode_cp1253("日本"), b"??");
    }

    #[test]
    fn decode_round_trips_the_whole_greek_block() {
        let text = "ΆΈΉΊΌΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωϊϋόύώ €";
        assert_eq!(decode_cp1253(&encode_cp1253(text)), text);
    }

    #[test]
    fn undefined_bytes_decode_to_replacement_characters() {
        assert_eq!(decode_cp1253(&[0x41, 0xD2, 0xFF]), "A\u{FFFD}\u{FFFD}");
    }
}
