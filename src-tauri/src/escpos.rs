//! Minimal ESC/POS binary command builder for thermal receipt printers.
//!
//! Generates raw byte sequences that can be sent directly to the printer
//! spooler via the winspool `WritePrinter` API. Supports text formatting,
//! alignment, Greek character encoding (CP737), and paper cutting.
#![allow(dead_code)]

// ESC/POS command bytes
const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;
const LF: u8 = 0x0A;

/// Paper width in characters.
#[derive(Debug, Clone, Copy)]
pub enum PaperWidth {
    Mm58,
    Mm80,
}

impl PaperWidth {
    pub fn chars(self) -> usize {
        match self {
            PaperWidth::Mm58 => 32,
            PaperWidth::Mm80 => 48,
        }
    }

    pub fn from_mm(mm: i32) -> Self {
        if mm <= 58 {
            PaperWidth::Mm58
        } else {
            PaperWidth::Mm80
        }
    }
}

/// Builder for generating ESC/POS binary command buffers.
///
/// ```rust,ignore
/// let data = EscPosBuilder::new()
///     .init()
///     .center()
///     .bold(true).text("RECEIPT\n").bold(false)
///     .left()
///     .text("Item 1        $5.00\n")
///     .feed(3)
///     .cut()
///     .build();
/// ```
pub struct EscPosBuilder {
    buffer: Vec<u8>,
    paper: PaperWidth,
    greek_mode: bool,
}

impl EscPosBuilder {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(512),
            paper: PaperWidth::Mm80,
            greek_mode: false,
        }
    }

    pub fn with_paper(mut self, paper: PaperWidth) -> Self {
        self.paper = paper;
        self
    }

    /// Enable Greek text encoding (CP737).
    pub fn with_greek(mut self) -> Self {
        self.greek_mode = true;
        self
    }

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /// ESC @ — Initialize printer, reset to defaults.
    pub fn init(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x40]);
        self
    }

    /// ESC t n — Select character code page.
    pub fn code_page(&mut self, page: u8) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x74, page]);
        self
    }

    /// Set code page to CP737 (Greek) and enable Greek text encoding.
    pub fn greek_mode(&mut self) -> &mut Self {
        self.code_page(14); // CP737
        self.greek_mode = true;
        self
    }

    // -----------------------------------------------------------------------
    // Text formatting
    // -----------------------------------------------------------------------

    /// ESC E n — Bold on/off.
    pub fn bold(&mut self, on: bool) -> &mut Self {
        self.buffer
            .extend_from_slice(&[ESC, 0x45, if on { 1 } else { 0 }]);
        self
    }

    /// ESC - n — Underline (0=off, 1=thin, 2=thick).
    pub fn underline(&mut self, mode: u8) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x2D, mode]);
        self
    }

    /// GS ! n — Set text size (width × height multiplier, 1–8 each).
    pub fn text_size(&mut self, width: u8, height: u8) -> &mut Self {
        let w = width.clamp(1, 8) - 1;
        let h = height.clamp(1, 8) - 1;
        self.buffer.extend_from_slice(&[GS, 0x21, (w << 4) | h]);
        self
    }

    /// Reset text size to 1×1.
    pub fn normal_size(&mut self) -> &mut Self {
        self.text_size(1, 1)
    }

    /// Double-width text (2×1).
    pub fn double_width(&mut self) -> &mut Self {
        self.text_size(2, 1)
    }

    /// Double-height text (1×2).
    pub fn double_height(&mut self) -> &mut Self {
        self.text_size(1, 2)
    }

    // -----------------------------------------------------------------------
    // Alignment
    // -----------------------------------------------------------------------

    /// ESC a 0 — Left-align.
    pub fn left(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x61, 0]);
        self
    }

    /// ESC a 1 — Centre-align.
    pub fn center(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x61, 1]);
        self
    }

    /// ESC a 2 — Right-align.
    pub fn right(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x61, 2]);
        self
    }

    // -----------------------------------------------------------------------
    // Text output
    // -----------------------------------------------------------------------

    /// Append text. Characters are encoded as ASCII or CP737 (Greek mode).
    pub fn text(&mut self, s: &str) -> &mut Self {
        if self.greek_mode {
            self.buffer.extend(encode_cp737(s));
        } else {
            // ASCII fallback — pass through bytes < 0x80, replace rest with '?'
            for ch in s.chars() {
                let code = ch as u32;
                if code < 0x80 {
                    self.buffer.push(code as u8);
                } else {
                    self.buffer.push(b'?');
                }
            }
        }
        self
    }

    /// Append raw bytes (e.g. pre-encoded text).
    pub fn raw(&mut self, data: &[u8]) -> &mut Self {
        self.buffer.extend_from_slice(data);
        self
    }

    /// Append a line-feed.
    pub fn lf(&mut self) -> &mut Self {
        self.buffer.push(LF);
        self
    }

    /// Print a horizontal separator using dashes, matching paper width.
    pub fn separator(&mut self) -> &mut Self {
        let width = self.paper.chars();
        for _ in 0..width {
            self.buffer.push(b'-');
        }
        self.buffer.push(LF);
        self
    }

    /// Print a line with left-aligned label and right-aligned value.
    pub fn line_pair(&mut self, label: &str, value: &str) -> &mut Self {
        let width = self.paper.chars();
        let gap = width.saturating_sub(label.len() + value.len());
        self.text(label);
        for _ in 0..gap {
            self.buffer.push(b' ');
        }
        self.text(value);
        self.lf()
    }

    // -----------------------------------------------------------------------
    // Feed / cut
    // -----------------------------------------------------------------------

    /// ESC d n — Feed n lines.
    pub fn feed(&mut self, lines: u8) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x64, lines]);
        self
    }

    /// GS V A 16 — Partial cut with 16-dot feed.
    pub fn cut(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[GS, 0x56, 0x41, 0x10]);
        self
    }

    /// GS V 0 — Full cut.
    pub fn full_cut(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[GS, 0x56, 0x00]);
        self
    }

    // -----------------------------------------------------------------------
    // Cash drawer
    // -----------------------------------------------------------------------

    /// ESC p m t1 t2 — Kick cash drawer (pin 2, 200ms pulse).
    pub fn open_drawer(&mut self) -> &mut Self {
        self.buffer
            .extend_from_slice(&[ESC, 0x70, 0x00, 0x19, 0x78]);
        self
    }

    // -----------------------------------------------------------------------
    // Build
    // -----------------------------------------------------------------------

    /// Consume the builder and return the binary ESC/POS payload.
    pub fn build(self) -> Vec<u8> {
        self.buffer
    }
}

// ---------------------------------------------------------------------------
// CP737 Greek character encoding
// ---------------------------------------------------------------------------

/// Encode a string to CP737 bytes. ASCII characters pass through; Greek
/// characters (U+0370–U+03FF) are mapped to their CP737 byte values.
/// Unknown characters are replaced with `?` (0x3F).
fn encode_cp737(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        // ASCII printable + control chars (LF, CR, etc.)
        if code < 0x80 {
            bytes.push(code as u8);
            continue;
        }
        // Euro sign
        if ch == '€' {
            bytes.push(b'E'); // CP737 has no Euro — approximate with 'E'
            continue;
        }
        // Greek character lookup
        if let Some(b) = greek_to_cp737(ch) {
            bytes.push(b);
        } else {
            bytes.push(b'?');
        }
    }
    bytes
}

/// Map a Unicode Greek character to its CP737 byte value.
fn greek_to_cp737(ch: char) -> Option<u8> {
    match ch {
        // Uppercase
        '\u{0391}' => Some(0x80), // Α
        '\u{0392}' => Some(0x81), // Β
        '\u{0393}' => Some(0x82), // Γ
        '\u{0394}' => Some(0x83), // Δ
        '\u{0395}' => Some(0x84), // Ε
        '\u{0396}' => Some(0x85), // Ζ
        '\u{0397}' => Some(0x86), // Η
        '\u{0398}' => Some(0x87), // Θ
        '\u{0399}' => Some(0x88), // Ι
        '\u{039A}' => Some(0x89), // Κ
        '\u{039B}' => Some(0x8A), // Λ
        '\u{039C}' => Some(0x8B), // Μ
        '\u{039D}' => Some(0x8C), // Ν
        '\u{039E}' => Some(0x8D), // Ξ
        '\u{039F}' => Some(0x8E), // Ο
        '\u{03A0}' => Some(0x8F), // Π
        '\u{03A1}' => Some(0x90), // Ρ
        '\u{03A3}' => Some(0x91), // Σ
        '\u{03A4}' => Some(0x92), // Τ
        '\u{03A5}' => Some(0x93), // Υ
        '\u{03A6}' => Some(0x94), // Φ
        '\u{03A7}' => Some(0x95), // Χ
        '\u{03A8}' => Some(0x96), // Ψ
        '\u{03A9}' => Some(0x97), // Ω
        // Lowercase
        '\u{03B1}' => Some(0x98), // α
        '\u{03B2}' => Some(0x99), // β
        '\u{03B3}' => Some(0x9A), // γ
        '\u{03B4}' => Some(0x9B), // δ
        '\u{03B5}' => Some(0x9C), // ε
        '\u{03B6}' => Some(0x9D), // ζ
        '\u{03B7}' => Some(0x9E), // η
        '\u{03B8}' => Some(0x9F), // θ
        '\u{03B9}' => Some(0xA0), // ι
        '\u{03BA}' => Some(0xA1), // κ
        '\u{03BB}' => Some(0xA2), // λ
        '\u{03BC}' => Some(0xA3), // μ
        '\u{03BD}' => Some(0xA4), // ν
        '\u{03BE}' => Some(0xA5), // ξ
        '\u{03BF}' => Some(0xA6), // ο
        '\u{03C0}' => Some(0xA7), // π
        '\u{03C1}' => Some(0xA8), // ρ
        '\u{03C3}' => Some(0xA9), // σ
        '\u{03C2}' => Some(0xAA), // ς (final sigma)
        '\u{03C4}' => Some(0xAB), // τ
        '\u{03C5}' => Some(0xAC), // υ
        '\u{03C6}' => Some(0xAD), // φ
        '\u{03C7}' => Some(0xAE), // χ
        '\u{03C8}' => Some(0xAF), // ψ
        '\u{03C9}' => Some(0xE0), // ω
        // Accented → base letter approximation
        '\u{0386}' => Some(0x80), // Ά → Α
        '\u{0388}' => Some(0x84), // Έ → Ε
        '\u{0389}' => Some(0x86), // Ή → Η
        '\u{038A}' => Some(0x88), // Ί → Ι
        '\u{038C}' => Some(0x8E), // Ό → Ο
        '\u{038E}' => Some(0x93), // Ύ → Υ
        '\u{038F}' => Some(0x97), // Ώ → Ω
        '\u{03AC}' => Some(0x98), // ά → α
        '\u{03AD}' => Some(0x9C), // έ → ε
        '\u{03AE}' => Some(0x9E), // ή → η
        '\u{03AF}' => Some(0xA0), // ί → ι
        '\u{03CC}' => Some(0xA6), // ό → ο
        '\u{03CD}' => Some(0xAC), // ύ → υ
        '\u{03CE}' => Some(0xE0), // ώ → ω
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_command() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.init();
            b.build()
        };
        assert_eq!(data, vec![0x1B, 0x40]);
    }

    #[test]
    fn test_bold_on_off() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.bold(true).text("HI").bold(false);
            b.build()
        };
        assert_eq!(data, vec![0x1B, 0x45, 1, b'H', b'I', 0x1B, 0x45, 0]);
    }

    #[test]
    fn test_center_align() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.center();
            b.build()
        };
        assert_eq!(data, vec![0x1B, 0x61, 1]);
    }

    #[test]
    fn test_cut() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.cut();
            b.build()
        };
        assert_eq!(data, vec![0x1D, 0x56, 0x41, 0x10]);
    }

    #[test]
    fn test_feed() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.feed(4);
            b.build()
        };
        assert_eq!(data, vec![0x1B, 0x64, 4]);
    }

    #[test]
    fn test_text_ascii() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.text("ABC\n");
            b.build()
        };
        assert_eq!(data, vec![b'A', b'B', b'C', b'\n']);
    }

    #[test]
    fn test_greek_encoding() {
        // "ΑΒ" in Greek
        let data = {
            let mut b = EscPosBuilder::new().with_greek();
            b.init().greek_mode().text("\u{0391}\u{0392}\n");
            b.build()
        };
        // ESC @ + ESC t 14 + 0x80 0x81 LF
        assert_eq!(data, vec![0x1B, 0x40, 0x1B, 0x74, 14, 0x80, 0x81, 0x0A]);
    }

    #[test]
    fn test_separator_80mm() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.separator();
            b.build()
        };
        // 48 dashes + LF
        assert_eq!(data.len(), 49);
        assert!(data[..48].iter().all(|&b| b == b'-'));
        assert_eq!(data[48], 0x0A);
    }

    #[test]
    fn test_line_pair() {
        let data = {
            let mut b = EscPosBuilder::new().with_paper(PaperWidth::Mm58);
            // 32 chars wide
            b.line_pair("Item", "$5.00");
            b.build()
        };
        // "Item" (4) + spaces (23) + "$5.00" (5) + LF = 33 bytes
        assert_eq!(data.len(), 33);
        assert_eq!(&data[..4], b"Item");
        assert_eq!(&data[27..32], b"$5.00");
        assert_eq!(data[32], 0x0A);
    }

    #[test]
    fn test_text_size() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.text_size(2, 2);
            b.build()
        };
        // GS ! n where n = ((2-1) << 4) | (2-1) = 0x11
        assert_eq!(data, vec![0x1D, 0x21, 0x11]);
    }

    #[test]
    fn test_open_drawer() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.open_drawer();
            b.build()
        };
        assert_eq!(data, vec![0x1B, 0x70, 0x00, 0x19, 0x78]);
    }

    #[test]
    fn test_full_test_receipt() {
        let mut b = EscPosBuilder::new();
        b.init()
            .center()
            .bold(true)
            .text("TEST PRINT\n")
            .bold(false)
            .separator()
            .left()
            .text("Printer: Test\n")
            .text("Date: 2026-02-21\n")
            .separator()
            .text("ABCDEFGHIJKLMNOPQRSTUVWXYZ\n")
            .text("0123456789 !@#$%^&*()\n")
            .separator()
            .center()
            .text("-- End of Test --\n")
            .feed(4)
            .cut();
        let data = b.build();
        // Just verify it produces non-empty bytes and starts with ESC @
        assert!(data.len() > 50);
        assert_eq!(data[0], 0x1B);
        assert_eq!(data[1], 0x40);
        // Ends with cut command
        let tail = &data[data.len() - 4..];
        assert_eq!(tail, &[0x1D, 0x56, 0x41, 0x10]);
    }
}
