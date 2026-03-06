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
    Mm112,
}

impl PaperWidth {
    pub fn chars(self) -> usize {
        match self {
            PaperWidth::Mm58 => 32,
            PaperWidth::Mm80 => 48,
            PaperWidth::Mm112 => 64,
        }
    }

    pub fn from_mm(mm: i32) -> Self {
        if mm <= 58 {
            PaperWidth::Mm58
        } else if mm >= 100 {
            PaperWidth::Mm112
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
    /// The active ESC/POS code page number (used to restore after inline switches).
    active_code_page: u8,
    /// When true, code page commands use Star Line Mode format (ESC GS t n)
    /// instead of standard ESC/POS (ESC t n).
    star_line_mode: bool,
}

impl EscPosBuilder {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(512),
            paper: PaperWidth::Mm80,
            greek_mode: false,
            active_code_page: 0,
            star_line_mode: false,
        }
    }

    /// Enable Star Line Mode code page commands (ESC GS t instead of ESC t).
    pub fn with_star_line_mode(mut self) -> Self {
        self.star_line_mode = true;
        self
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

    /// ESC t n — Select character code page (standard ESC/POS).
    pub fn code_page(&mut self, page: u8) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x74, page]);
        self.active_code_page = page;
        self
    }

    /// ESC GS t n — Select character code page (Star Line Mode).
    ///
    /// Star printers in native Star Line Mode use a different command from
    /// standard ESC/POS. This sends `1B 1D 74 n` instead of `1B 74 n`.
    /// Also enables `star_line_mode` so inline code page switches (e.g. for €)
    /// use the correct Star command format.
    pub fn star_code_page(&mut self, page: u8) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, GS, 0x74, page]);
        self.active_code_page = page;
        self.star_line_mode = true;
        self
    }

    /// Set code page to CP737 (Greek) and enable Greek text encoding.
    ///
    /// Uses code page 14 which is the default for CP737 on many Epson models.
    /// For printers that use a different number (e.g. Star mcPrint uses 15),
    /// call `code_page(n)` + `set_greek_mode(true)` directly.
    pub fn greek_mode(&mut self) -> &mut Self {
        self.code_page(14); // CP737 — default for Epson TM-T88III
        self.greek_mode = true;
        self
    }

    /// Enable or disable Greek text encoding without changing the code page.
    pub fn set_greek_mode(&mut self, enabled: bool) -> &mut Self {
        self.greek_mode = enabled;
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

    /// ESC M 0 — Select Font A (larger default glyphs).
    pub fn font_a(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x4D, 0x00]);
        self
    }

    /// ESC M 1 — Select Font B (smaller compact glyphs).
    pub fn font_b(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x4D, 0x01]);
        self
    }

    /// ESC - n — Underline (0=off, 1=thin, 2=thick).
    pub fn underline(&mut self, mode: u8) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x2D, mode]);
        self
    }

    /// GS B n — Reverse printing mode (white text on black background).
    /// n=1: reverse on, n=0: reverse off.
    ///
    /// **Note:** Star printers do not support GS B and will print literal "B".
    /// Use `star_reverse()` for Star printers instead.
    pub fn reverse(&mut self, on: bool) -> &mut Self {
        self.buffer
            .extend_from_slice(&[GS, 0x42, if on { 1 } else { 0 }]);
        self
    }

    /// ESC 4 / ESC 5 — Star Line Mode reverse (white-on-black) printing.
    ///
    /// Star printers in native Star Line Mode use `ESC 4` to turn on
    /// reverse and `ESC 5` to turn off. Standard ESC/POS `GS B` is not
    /// recognized and prints literal "B" text.
    pub fn star_reverse(&mut self, on: bool) -> &mut Self {
        if on {
            self.buffer.extend_from_slice(&[ESC, 0x34]); // ESC 4
        } else {
            self.buffer.extend_from_slice(&[ESC, 0x35]); // ESC 5
        }
        self
    }

    /// Set text size multiplier.
    ///
    /// - Standard ESC/POS: `GS ! n` with width/height 1–8.
    /// - Star Line Mode: `ESC W n` (double-width on/off) + `ESC h n` (double-height on/off).
    ///   Star only supports 1× or 2× per axis (no 3×–8×).
    pub fn text_size(&mut self, width: u8, height: u8) -> &mut Self {
        if self.star_line_mode {
            // ESC W n — expanded (double-width): n=1 on, n=0 off
            self.buffer
                .extend_from_slice(&[ESC, 0x57, if width > 1 { 1 } else { 0 }]);
            // ESC h n — double-height: n=1 on, n=0 off
            self.buffer
                .extend_from_slice(&[ESC, 0x68, if height > 1 { 1 } else { 0 }]);
        } else {
            let w = width.clamp(1, 8) - 1;
            let h = height.clamp(1, 8) - 1;
            self.buffer.extend_from_slice(&[GS, 0x21, (w << 4) | h]);
        }
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
    ///
    /// Euro sign (€) is handled via inline code page switching to CP858
    /// (page 19) which has € at 0xD5, then restoring the active code page.
    /// Uses Star Line Mode commands (ESC GS t) when `star_line_mode` is set.
    pub fn text(&mut self, s: &str) -> &mut Self {
        // Split on € to handle inline code page switches
        for (i, segment) in s.split('€').enumerate() {
            if i > 0 {
                // Emit € via inline code page switch to CP858 (has € at 0xD5).
                // Star Line Mode uses different code page numbers: CP858 = page 4.
                // Standard ESC/POS (Epson): CP858 = page 19.
                let cp858_page = if self.star_line_mode { 4 } else { 19 };
                self.emit_code_page_cmd(cp858_page);
                self.buffer.push(0xD5);
                self.emit_code_page_cmd(self.active_code_page); // restore
            }
            if self.greek_mode {
                self.buffer.extend(encode_cp737(segment));
            } else {
                for ch in segment.chars() {
                    let code = ch as u32;
                    if code < 0x80 {
                        self.buffer.push(code as u8);
                    } else {
                        self.buffer.push(b'?');
                    }
                }
            }
        }
        self
    }

    /// Emit a code page switch using the correct command for the printer mode.
    fn emit_code_page_cmd(&mut self, page: u8) {
        if self.star_line_mode {
            self.buffer.extend_from_slice(&[ESC, GS, 0x74, page]); // Star Line Mode
        } else {
            self.buffer.extend_from_slice(&[ESC, 0x74, page]); // Standard ESC/POS
        }
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
        // Use character count (not UTF-8 byte length) so that multi-byte
        // characters like Greek letters are measured correctly for alignment.
        let label_chars = label.chars().count();
        let value_chars = value.chars().count();
        let gap = width.saturating_sub(label_chars + value_chars);
        self.text(label);
        for _ in 0..gap {
            self.buffer.push(b' ');
        }
        self.text(value);
        self.lf()
    }

    /// Print a QR code using standard ESC/POS 2D barcode commands.
    pub fn qr(&mut self, data: &str) -> &mut Self {
        if data.is_empty() {
            return self;
        }

        let payload = data.as_bytes();
        let store_len = payload.len() + 3;
        let p_l = (store_len & 0xFF) as u8;
        let p_h = ((store_len >> 8) & 0xFF) as u8;

        // Model 2
        self.raw(&[GS, b'(', b'k', 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
        // Module size
        self.raw(&[GS, b'(', b'k', 0x03, 0x00, 0x31, 0x43, 0x06]);
        // Error correction level M
        self.raw(&[GS, b'(', b'k', 0x03, 0x00, 0x31, 0x45, 0x31]);
        // Store data
        self.raw(&[GS, b'(', b'k', p_l, p_h, 0x31, 0x50, 0x30]);
        self.raw(payload);
        // Print symbol
        self.raw(&[GS, b'(', b'k', 0x03, 0x00, 0x31, 0x51, 0x30]);
        self
    }

    /// Print a raster bit image (GS v 0), where `width_bytes` is the number
    /// of horizontal bytes per row and `height_dots` is total rows.
    ///
    /// `data` length must be `width_bytes * height_dots`.
    pub fn raster_image(&mut self, width_bytes: u16, height_dots: u16, data: &[u8]) -> &mut Self {
        let x_l = (width_bytes & 0x00FF) as u8;
        let x_h = ((width_bytes >> 8) & 0x00FF) as u8;
        let y_l = (height_dots & 0x00FF) as u8;
        let y_h = ((height_dots >> 8) & 0x00FF) as u8;
        self.raw(&[GS, b'v', b'0', 0x00, x_l, x_h, y_l, y_h]);
        self.raw(data);
        self
    }

    /// Print a raster image using **Star Line Mode** raster protocol.
    ///
    /// Works on all Star printers regardless of emulation mode (Star Line,
    /// StarPRNT, or ESC/POS compatibility).  The protocol matches the
    /// battle-tested [StarTSPImage](https://github.com/geftactics/python-StarTSPImage) library:
    ///
    /// ```text
    /// ESC * r A             — enter raster mode
    /// ESC * r P '0' NUL    — continuous mode (no page boundary)
    /// ESC * r E '1' NUL    — disable auto-cut on raster exit
    /// b nL nH [row_data]   — one raster line (repeated per row)
    /// ESC * r B             — exit raster mode (no page advance, no cut)
    /// ```
    ///
    /// The `ESC * r P '0' NUL` command sets **continuous mode** — the printer
    /// has no fixed page length, so `ESC * r B` exits without any paper
    /// advance.  Without this, the printer advances to fill a default
    /// raster page (~2400 dots ≈ 30 cm of blank paper).
    ///
    /// `width_bytes` = ceil(image_width_pixels / 8).
    /// `data` layout is identical to `raster_image` (row-major, MSB first).
    pub fn star_raster_image(
        &mut self,
        width_bytes: u16,
        height_dots: u16,
        data: &[u8],
    ) -> &mut Self {
        let wb = width_bytes as usize;
        let n_l = (width_bytes & 0x00FF) as u8;
        let n_h = ((width_bytes >> 8) & 0x00FF) as u8;

        // ESC * r A — enter raster mode
        self.raw(&[ESC, b'*', b'r', b'A']);
        // ESC * r P '0' NUL — continuous mode (no page boundary).
        // The '0' is ASCII 0x30, NOT a binary zero.  This tells the printer
        // there is no fixed page length, so ESC * r B exits without the
        // automatic page advance that causes ~25 cm of blank paper.
        self.raw(&[ESC, b'*', b'r', b'P', b'0', 0x00]);
        // ESC * r E '1' NUL — disable auto-cut after raster exit.
        // Star mC-Print3 auto-cuts on ESC * r B by default; this prevents
        // a paper cut between the logo and the receipt text.
        self.raw(&[ESC, b'*', b'r', b'E', b'1', 0x00]);

        for row in 0..height_dots as usize {
            let start = row * wb;
            let end = (start + wb).min(data.len());
            // b nL nH [row_data]
            self.raw(&[b'b', n_l, n_h]);
            if start < data.len() {
                self.raw(&data[start..end]);
                // Pad if row data is short
                if end - start < wb {
                    let padding = vec![0u8; wb - (end - start)];
                    self.raw(&padding);
                }
            } else {
                // Blank row
                let blank = vec![0u8; wb];
                self.raw(&blank);
            }
        }
        // ESC * r B — exit raster mode.  With continuous mode active,
        // no page advance occurs.
        self.raw(&[ESC, b'*', b'r', b'B']);
        self
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

    /// ESC d 1 — Partial cut (Star Line Mode).
    ///
    /// Star printers do not recognize the Epson `GS V A` cut command and will
    /// print its bytes as literal "VA" text.  Use this method for Star printers.
    pub fn star_cut(&mut self) -> &mut Self {
        self.buffer.extend_from_slice(&[ESC, 0x64, 0x01]);
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
        // Note: € is handled at the EscPosBuilder::text() level via code page switching.
        // Box-drawing characters (CP737 shares positions with CP437)
        if let Some(b) = box_drawing_to_cp737(ch) {
            bytes.push(b);
            continue;
        }
        // Safe ASCII fallbacks for common Unicode punctuation
        if let Some(b) = unicode_fallback(ch) {
            bytes.push(b);
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

/// Map Unicode box-drawing characters to CP737/CP437 byte positions.
fn box_drawing_to_cp737(ch: char) -> Option<u8> {
    match ch {
        '─' => Some(0xC4), // U+2500
        '│' => Some(0xB3), // U+2502
        '┌' => Some(0xDA), // U+250C
        '┐' => Some(0xBF), // U+2510
        '└' => Some(0xC0), // U+2514
        '┘' => Some(0xD9), // U+2518
        '├' => Some(0xC3), // U+251C
        '┤' => Some(0xB4), // U+2524
        '┬' => Some(0xC2), // U+252C
        '┴' => Some(0xC1), // U+2534
        '┼' => Some(0xC5), // U+253C
        '═' => Some(0xCD), // U+2550
        '║' => Some(0xBA), // U+2551
        '╔' => Some(0xC9), // U+2554
        '╗' => Some(0xBB), // U+2557
        '╚' => Some(0xC8), // U+255A
        '╝' => Some(0xBC), // U+255D
        '╠' => Some(0xCC), // U+2560
        '╣' => Some(0xB9), // U+2563
        '╦' => Some(0xCB), // U+2566
        '╩' => Some(0xCA), // U+2569
        '╬' => Some(0xCE), // U+256C
        _ => None,
    }
}

/// Approximate common Unicode punctuation with ASCII equivalents.
fn unicode_fallback(ch: char) -> Option<u8> {
    match ch {
        '\u{00D7}' => Some(b'x'),               // × multiplication sign
        '\u{2013}' => Some(b'-'),               // – en-dash
        '\u{2014}' => Some(b'-'),               // — em-dash
        '\u{2018}' | '\u{2019}' => Some(b'\''), // '' smart quotes
        '\u{201C}' | '\u{201D}' => Some(b'"'),  // "" smart quotes
        '\u{2026}' => Some(b'.'),               // … ellipsis (single dot)
        '\u{00B7}' => Some(b'.'),               // · middle dot
        _ => None,
    }
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
        // Accented lowercase (tonos) — CP737 bytes 0xE1-0xE9
        '\u{03AC}' => Some(0xE1), // ά
        '\u{03AD}' => Some(0xE2), // έ
        '\u{03AE}' => Some(0xE3), // ή
        '\u{03AF}' => Some(0xE5), // ί
        '\u{03CC}' => Some(0xE6), // ό
        '\u{03CD}' => Some(0xE7), // ύ
        '\u{03CE}' => Some(0xE9), // ώ
        // Accented uppercase (tonos) — CP737 bytes 0xEA-0xF0
        '\u{0386}' => Some(0xEA), // Ά
        '\u{0388}' => Some(0xEB), // Έ
        '\u{0389}' => Some(0xEC), // Ή
        '\u{038A}' => Some(0xED), // Ί
        '\u{038C}' => Some(0xEE), // Ό
        '\u{038E}' => Some(0xEF), // Ύ
        '\u{038F}' => Some(0xF0), // Ώ
        // Dialytika — CP737 bytes 0xE4, 0xE8, 0xF4, 0xF5
        '\u{03CA}' => Some(0xE4), // ϊ
        '\u{03CB}' => Some(0xE8), // ϋ
        '\u{03AA}' => Some(0xF4), // Ϊ
        '\u{03AB}' => Some(0xF5), // Ϋ
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
    fn test_star_cut() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.star_cut();
            b.build()
        };
        assert_eq!(data, vec![0x1B, 0x64, 0x01]);
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
    fn test_text_euro_uses_cp858_switch_standard_escpos() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.code_page(14).text("17,70 \u{20AC}");
            b.build()
        };

        // ... text "17,70 " + ESC t 19 + 0xD5 + ESC t 14
        assert!(data.windows(3).any(|window| window == [0x1B, 0x74, 19]));
        assert!(data.windows(3).any(|window| window == [0x1B, 0x74, 14]));
        assert!(data.contains(&0xD5));
    }

    #[test]
    fn test_text_euro_uses_cp858_switch_star_line_mode() {
        let data = {
            let mut b = EscPosBuilder::new().with_star_line_mode();
            b.star_code_page(15).text("17,70 \u{20AC}");
            b.build()
        };

        // ... text "17,70 " + ESC GS t 4 + 0xD5 + ESC GS t 15
        assert!(data
            .windows(4)
            .any(|window| window == [0x1B, 0x1D, 0x74, 4]));
        assert!(data
            .windows(4)
            .any(|window| window == [0x1B, 0x1D, 0x74, 15]));
        assert!(data.contains(&0xD5));
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
    fn test_paper_width_112_chars() {
        assert_eq!(PaperWidth::Mm112.chars(), 64);
        assert!(matches!(PaperWidth::from_mm(112), PaperWidth::Mm112));
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
    fn test_qr_command_emits_data() {
        let data = {
            let mut b = EscPosBuilder::new();
            b.qr("https://example.com");
            b.build()
        };
        assert!(data.len() > 20);
        assert_eq!(data[0], 0x1D);
        assert_eq!(data[1], b'(');
        assert_eq!(data[2], b'k');
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
