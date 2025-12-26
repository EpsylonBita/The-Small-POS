/**
 * ESC/POS Command Builder
 *
 * Generates ESC/POS commands for thermal receipt printers.
 * Supports text formatting, alignment, line drawing, and paper cutting.
 *
 * @module printer/services/escpos
 *
 * **Feature: pos-printer-drivers, Property 6: ESC/POS Command Generation**
 */

import { PaperSize } from '../../types';

// ============================================================================
// ESC/POS Command Constants
// ============================================================================

/**
 * ESC/POS command bytes
 */
export const ESC = 0x1b; // Escape
export const GS = 0x1d; // Group Separator
export const LF = 0x0a; // Line Feed
export const CR = 0x0d; // Carriage Return

/**
 * Text alignment values
 */
export enum TextAlignment {
  LEFT = 0,
  CENTER = 1,
  RIGHT = 2,
}

/**
 * Text size multipliers (1-8)
 */
export interface TextSize {
  width: number; // 1-8
  height: number; // 1-8
}

/**
 * Paper width configurations in characters
 */
export const PAPER_WIDTH_CHARS: Record<PaperSize, number> = {
  [PaperSize.MM_58]: 32,
  [PaperSize.MM_80]: 48,
  [PaperSize.MM_112]: 64,
};

// ============================================================================
// EscPosBuilder Class
// ============================================================================

/**
 * Check if a string contains Greek characters
 */
function containsGreek(text: string): boolean {
  // Greek Unicode range: U+0370 to U+03FF (Greek and Coptic)
  // Also check for extended Greek: U+1F00 to U+1FFF
  return /[\u0370-\u03FF\u1F00-\u1FFF]/.test(text);
}

/**
 * Greek character mapping to CP737 (DOS Greek) code page
 * CP737 is the standard Greek code page for ESC/POS thermal printers
 * Maps Unicode Greek characters to their CP737 byte values
 */
const GREEK_TO_CP737: Record<string, number> = {
  // Uppercase Greek letters (0x80-0x90)
  '\u0391': 0x80,  // Α Alpha
  '\u0392': 0x81,  // Β Beta
  '\u0393': 0x82,  // Γ Gamma
  '\u0394': 0x83,  // Δ Delta
  '\u0395': 0x84,  // Ε Epsilon
  '\u0396': 0x85,  // Ζ Zeta
  '\u0397': 0x86,  // Η Eta
  '\u0398': 0x87,  // Θ Theta
  '\u0399': 0x88,  // Ι Iota
  '\u039A': 0x89,  // Κ Kappa
  '\u039B': 0x8A,  // Λ Lambda
  '\u039C': 0x8B,  // Μ Mu
  '\u039D': 0x8C,  // Ν Nu
  '\u039E': 0x8D,  // Ξ Xi
  '\u039F': 0x8E,  // Ο Omicron
  '\u03A0': 0x8F,  // Π Pi
  '\u03A1': 0x90,  // Ρ Rho
  '\u03A3': 0x91,  // Σ Sigma
  '\u03A4': 0x92,  // Τ Tau
  '\u03A5': 0x93,  // Υ Upsilon
  '\u03A6': 0x94,  // Φ Phi
  '\u03A7': 0x95,  // Χ Chi
  '\u03A8': 0x96,  // Ψ Psi
  '\u03A9': 0x97,  // Ω Omega
  // Lowercase Greek letters (0x98-0xAF, 0xE0)
  '\u03B1': 0x98,  // α alpha
  '\u03B2': 0x99,  // β beta
  '\u03B3': 0x9A,  // γ gamma
  '\u03B4': 0x9B,  // δ delta
  '\u03B5': 0x9C,  // ε epsilon
  '\u03B6': 0x9D,  // ζ zeta
  '\u03B7': 0x9E,  // η eta
  '\u03B8': 0x9F,  // θ theta
  '\u03B9': 0xA0,  // ι iota
  '\u03BA': 0xA1,  // κ kappa
  '\u03BB': 0xA2,  // λ lambda
  '\u03BC': 0xA3,  // μ mu
  '\u03BD': 0xA4,  // ν nu
  '\u03BE': 0xA5,  // ξ xi
  '\u03BF': 0xA6,  // ο omicron
  '\u03C0': 0xA7,  // π pi
  '\u03C1': 0xA8,  // ρ rho
  '\u03C3': 0xA9,  // σ sigma
  '\u03C2': 0xAA,  // ς final sigma
  '\u03C4': 0xAB,  // τ tau
  '\u03C5': 0xAC,  // υ upsilon
  '\u03C6': 0xAD,  // φ phi
  '\u03C7': 0xAE,  // χ chi
  '\u03C8': 0xAF,  // ψ psi
  '\u03C9': 0xE0,  // ω omega
};

/**
 * Greek character mapping for Netum/Chinese thermal printers Code Page 66
 * This is a non-standard code page used by many Chinese-made thermal printers
 * Based on actual character map from Netum NS-8360LW printer
 * 
 * Character positions decoded from printer self-test:
 * Row A0: A B Γ Δ E Z H Θ I (positions 4-12, using Latin A/E for Alpha/Epsilon)
 * Row B0: K Λ M N Ξ O (positions 5-8, 12-13)
 * Row C0: Π P Σ (positions 6-7, 15)
 * Row D0: T Y Φ X Ψ Ω α β δ ε (positions 0-7, 11-12)
 * Row E0: ζ η θ ι κ λ μ ν ξ ο π ρ σ ς τ (positions 0-14)
 * Row F0: υ φ χ ψ ω ϋ ΰ ώ (positions 2-4, 6, 9-12)
 */
const GREEK_TO_CP66: Record<string, number> = {
  // Uppercase Greek letters - using Latin equivalents where printer shows them
  // Based on actual test results from Netum NS-8360LW
  '\u0391': 0x41,  // Α Alpha -> Latin A
  '\u0392': 0x42,  // Β Beta -> Latin B  
  '\u0393': 0xA6,  // Γ Gamma - WORKS
  '\u0394': 0xA7,  // Δ Delta - WORKS
  '\u0395': 0x45,  // Ε Epsilon -> Latin E
  '\u0396': 0x5A,  // Ζ Zeta -> Latin Z
  '\u0397': 0x48,  // Η Eta -> Latin H
  '\u0398': 0xAC,  // Θ Theta - WORKS
  '\u0399': 0x49,  // Ι Iota -> Latin I
  '\u039A': 0x4B,  // Κ Kappa -> Latin K
  '\u039B': 0xB6,  // Λ Lambda - WORKS
  '\u039C': 0x4D,  // Μ Mu -> Latin M
  '\u039D': 0x4E,  // Ν Nu -> Latin N
  '\u039E': 0xBD,  // Ξ Xi - was 0xBC (wrong), try 0xBD
  '\u039F': 0x4F,  // Ο Omicron -> Latin O
  '\u03A0': 0xC6,  // Π Pi - WORKS
  '\u03A1': 0x50,  // Ρ Rho -> Latin P
  '\u03A3': 0xCF,  // Σ Sigma - WORKS
  '\u03A4': 0x54,  // Τ Tau -> Latin T
  '\u03A5': 0x59,  // Υ Upsilon -> Latin Y
  '\u03A6': 0xD2,  // Φ Phi - WORKS
  '\u03A7': 0x58,  // Χ Chi -> Latin X
  '\u03A8': 0xD4,  // Ψ Psi - WORKS
  '\u03A9': 0xD5,  // Ω Omega - WORKS
  // Lowercase Greek letters
  '\u03B1': 0xD6,  // α alpha - WORKS
  '\u03B2': 0xD7,  // β beta - WORKS
  '\u03B3': 0xE3,  // γ gamma - NOT IN FONT, use ι as visual approximation (both have descender)
  '\u03B4': 0xD6,  // δ delta - 0xDB shows black square, use α as fallback
  '\u03B5': 0xE9,  // ε epsilon - 0xDC shows black square, use ο as visual approximation
  '\u03B6': 0xE0,  // ζ zeta - WORKS
  '\u03B7': 0xE1,  // η eta - WORKS
  '\u03B8': 0xE2,  // θ theta - WORKS
  '\u03B9': 0xE3,  // ι iota - WORKS
  '\u03BA': 0xE4,  // κ kappa - WORKS
  '\u03BB': 0xE5,  // λ lambda - WORKS
  '\u03BC': 0xE6,  // μ mu - WORKS
  '\u03BD': 0xE7,  // ν nu - WORKS
  '\u03BE': 0xE8,  // ξ xi - WORKS
  '\u03BF': 0xE9,  // ο omicron - WORKS
  '\u03C0': 0xEA,  // π pi - WORKS
  '\u03C1': 0xEB,  // ρ rho - WORKS
  '\u03C3': 0xEC,  // σ sigma - WORKS
  '\u03C2': 0xED,  // ς final sigma - WORKS
  '\u03C4': 0xEE,  // τ tau - WORKS
  '\u03C5': 0xF2,  // υ upsilon - WORKS
  '\u03C6': 0xF3,  // φ phi - WORKS
  '\u03C7': 0xF4,  // χ chi - WORKS
  '\u03C8': 0xF6,  // ψ psi - WORKS
  '\u03C9': 0xF2,  // ω omega - 0xF9 shows ¨, use υ as fallback (similar shape)
  // Accented (approximations - map to base letters)
  '\u03AC': 0xD6,  // ά -> α
  '\u03AD': 0xE5,  // έ -> ε (use λ position since ε is broken)
  '\u03AE': 0xE1,  // ή -> η
  '\u03AF': 0xE3,  // ί -> ι
  '\u03CC': 0xE9,  // ό -> ο
  '\u03CD': 0xF2,  // ύ -> υ
  '\u03CE': 0xF9,  // ώ -> ω
  '\u03CA': 0xE3,  // ϊ -> ι
  '\u03CB': 0xFA,  // ϋ upsilon with dialytika
  '\u0390': 0xE3,  // ΐ -> ι
  '\u03B0': 0xF2,  // ΰ -> υ
  // Euro symbol
  '€': 0x81,  // Euro at 0x81
};

/**
 * Greek character mapping to Windows-1253 (CP1253) code page
 * CP1253 is the Windows Greek code page, commonly used in Windows printer drivers
 * Maps Unicode Greek characters to their CP1253 byte values
 */
const GREEK_TO_CP1253: Record<string, number> = {
  // Euro sign
  '€': 0x80,
  // Uppercase Greek letters
  '\u0386': 0xA2,  // Ά Alpha with tonos
  '\u0388': 0xB8,  // Έ Epsilon with tonos
  '\u0389': 0xB9,  // Ή Eta with tonos
  '\u038A': 0xBA,  // Ί Iota with tonos
  '\u038C': 0xBC,  // Ό Omicron with tonos
  '\u038E': 0xBE,  // Ύ Upsilon with tonos
  '\u038F': 0xBF,  // Ώ Omega with tonos
  '\u0391': 0xC1,  // Α Alpha
  '\u0392': 0xC2,  // Β Beta
  '\u0393': 0xC3,  // Γ Gamma
  '\u0394': 0xC4,  // Δ Delta
  '\u0395': 0xC5,  // Ε Epsilon
  '\u0396': 0xC6,  // Ζ Zeta
  '\u0397': 0xC7,  // Η Eta
  '\u0398': 0xC8,  // Θ Theta
  '\u0399': 0xC9,  // Ι Iota
  '\u039A': 0xCA,  // Κ Kappa
  '\u039B': 0xCB,  // Λ Lambda
  '\u039C': 0xCC,  // Μ Mu
  '\u039D': 0xCD,  // Ν Nu
  '\u039E': 0xCE,  // Ξ Xi
  '\u039F': 0xCF,  // Ο Omicron
  '\u03A0': 0xD0,  // Π Pi
  '\u03A1': 0xD1,  // Ρ Rho
  '\u03A3': 0xD3,  // Σ Sigma
  '\u03A4': 0xD4,  // Τ Tau
  '\u03A5': 0xD5,  // Υ Upsilon
  '\u03A6': 0xD6,  // Φ Phi
  '\u03A7': 0xD7,  // Χ Chi
  '\u03A8': 0xD8,  // Ψ Psi
  '\u03A9': 0xD9,  // Ω Omega
  '\u03AA': 0xDA,  // Ϊ Iota with dialytika
  '\u03AB': 0xDB,  // Ϋ Upsilon with dialytika
  // Lowercase Greek letters
  '\u03AC': 0xDC,  // ά alpha with tonos
  '\u03AD': 0xDD,  // έ epsilon with tonos
  '\u03AE': 0xDE,  // ή eta with tonos
  '\u03AF': 0xDF,  // ί iota with tonos
  '\u03B0': 0xE0,  // ΰ upsilon with dialytika and tonos
  '\u03B1': 0xE1,  // α alpha
  '\u03B2': 0xE2,  // β beta
  '\u03B3': 0xE3,  // γ gamma
  '\u03B4': 0xE4,  // δ delta
  '\u03B5': 0xE5,  // ε epsilon
  '\u03B6': 0xE6,  // ζ zeta
  '\u03B7': 0xE7,  // η eta
  '\u03B8': 0xE8,  // θ theta
  '\u03B9': 0xE9,  // ι iota
  '\u03BA': 0xEA,  // κ kappa
  '\u03BB': 0xEB,  // λ lambda
  '\u03BC': 0xEC,  // μ mu
  '\u03BD': 0xED,  // ν nu
  '\u03BE': 0xEE,  // ξ xi
  '\u03BF': 0xEF,  // ο omicron
  '\u03C0': 0xF0,  // π pi
  '\u03C1': 0xF1,  // ρ rho
  '\u03C2': 0xF2,  // ς final sigma
  '\u03C3': 0xF3,  // σ sigma
  '\u03C4': 0xF4,  // τ tau
  '\u03C5': 0xF5,  // υ upsilon
  '\u03C6': 0xF6,  // φ phi
  '\u03C7': 0xF7,  // χ chi
  '\u03C8': 0xF8,  // ψ psi
  '\u03C9': 0xF9,  // ω omega
  '\u03CA': 0xFA,  // ϊ iota with dialytika
  '\u03CB': 0xFB,  // ϋ upsilon with dialytika
  '\u03CC': 0xFC,  // ό omicron with tonos
  '\u03CD': 0xFD,  // ύ upsilon with tonos
  '\u03CE': 0xFE,  // ώ omega with tonos
};

/**
 * Supported character set types
 */
export type CharacterSetType = 
  | 'PC437_USA' 
  | 'PC737_GREEK' 
  | 'PC851_GREEK' 
  | 'PC869_GREEK' 
  | 'PC850_MULTILINGUAL' 
  | 'PC852_LATIN2' 
  | 'PC866_CYRILLIC' 
  | 'PC1252_LATIN1' 
  | 'PC1253_GREEK'
  | 'CP66_GREEK';  // Netum/Chinese printer code page 66

/**
 * ESC/POS code page numbers for different character sets
 * Note: These are standard ESC/POS code page numbers, but some printers may not support all of them
 */
export const CODE_PAGE_NUMBERS: Record<CharacterSetType, number> = {
  'PC437_USA': 0,
  'PC737_GREEK': 14,      // Some printers use 16
  'PC851_GREEK': 15,      // Some printers use 17
  'PC869_GREEK': 38,      // Some printers use 18
  'PC850_MULTILINGUAL': 2,
  'PC852_LATIN2': 18,
  'PC866_CYRILLIC': 17,
  'PC1252_LATIN1': 16,
  'PC1253_GREEK': 17,     // Windows Greek - some printers use different numbers
  'CP66_GREEK': 66,       // Netum/Chinese printers use code page 66 for Greek
};

/**
 * Encode a string to CP66 bytes for Greek text on Netum/Chinese thermal printers
 * Uses Latin equivalents for Greek letters that look similar (A, B, E, H, I, K, M, N, O, P, T, X, Y, Z)
 */
function encodeToCP66(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    
    // Check CP66 Greek mapping first
    if (GREEK_TO_CP66[char] !== undefined) {
      bytes.push(GREEK_TO_CP66[char]);
    }
    // ASCII printable characters (0x20-0x7E)
    else if (code >= 0x20 && code <= 0x7E) {
      bytes.push(code);
    }
    // Replace unknown characters with '?'
    else {
      bytes.push(0x3F); // '?'
    }
  }
  return bytes;
}

/**
 * Encode a string to CP737 bytes for Greek text on thermal printers
 * Falls back to ASCII for non-Greek characters
 */
function encodeToCP737(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    
    // Euro sign - use 'E' as approximation (CP737 doesn't have Euro)
    if (char === '€') {
      bytes.push(0x45); // 'E'
      continue;
    }
    
    // Check Greek mapping first
    if (GREEK_TO_CP737[char] !== undefined) {
      bytes.push(GREEK_TO_CP737[char]);
    }
    // ASCII printable characters (0x20-0x7E)
    else if (code >= 0x20 && code <= 0x7E) {
      bytes.push(code);
    }
    // Replace unknown characters with '?'
    else {
      bytes.push(0x3F); // '?'
    }
  }
  return bytes;
}

/**
 * Encode a string to CP1253 (Windows Greek) bytes
 * CP1253 includes Euro symbol and is commonly used in Windows printer drivers
 */
function encodeToCP1253(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    
    // Check CP1253 Greek mapping first (includes Euro)
    if (GREEK_TO_CP1253[char] !== undefined) {
      bytes.push(GREEK_TO_CP1253[char]);
    }
    // ASCII printable characters (0x20-0x7E)
    else if (code >= 0x20 && code <= 0x7E) {
      bytes.push(code);
    }
    // Replace unknown characters with '?'
    else {
      bytes.push(0x3F); // '?'
    }
  }
  return bytes;
}

/**
 * Encode text based on the specified character set
 */
function encodeText(text: string, characterSet: CharacterSetType): number[] {
  // For CP66 Greek (Netum/Chinese printers)
  if (characterSet === 'CP66_GREEK') {
    return encodeToCP66(text);
  }
  // For standard Greek character sets, use CP737 encoding
  if (characterSet === 'PC737_GREEK' || characterSet === 'PC851_GREEK' || characterSet === 'PC869_GREEK') {
    return encodeToCP737(text);
  }
  if (characterSet === 'PC1253_GREEK') {
    return encodeToCP1253(text);
  }
  
  // For other character sets, use ASCII encoding
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7E) {
      bytes.push(code);
    } else if (char === '€') {
      bytes.push(0x45); // 'E' fallback
    } else {
      bytes.push(0x3F); // '?'
    }
  }
  return bytes;
}

/**
 * Builder class for generating ESC/POS command buffers.
 *
 * Usage:
 * ```typescript
 * const builder = new EscPosBuilder(PaperSize.MM_80);
 * const buffer = builder
 *   .initialize()
 *   .alignCenter()
 *   .bold(true)
 *   .text('RECEIPT')
 *   .bold(false)
 *   .lineFeed()
 *   .cut()
 *   .build();
 * ```
 */
export class EscPosBuilder {
  private buffer: number[] = [];
  private paperSize: PaperSize;
  private lineWidth: number;
  private useGreekEncoding: boolean = false;
  private characterSet: CharacterSetType = 'PC437_USA';

  constructor(paperSize: PaperSize = PaperSize.MM_80, characterSet: CharacterSetType = 'PC437_USA') {
    this.paperSize = paperSize;
    this.lineWidth = PAPER_WIDTH_CHARS[paperSize];
    this.characterSet = characterSet;
  }

  /**
   * Set the character set for text encoding
   * This determines how Greek and other special characters are encoded
   * @param characterSet - The character set to use
   */
  setCharacterSetType(characterSet: CharacterSetType): this {
    this.characterSet = characterSet;
    // Auto-enable Greek encoding for Greek character sets
    if (characterSet.includes('GREEK')) {
      this.useGreekEncoding = true;
    }
    return this;
  }

  /**
   * Get the current character set
   */
  getCharacterSetType(): CharacterSetType {
    return this.characterSet;
  }

  /**
   * Enable Greek encoding mode (Windows-1253/CP1253)
   * When enabled, text will be encoded using CP1253 code page
   * CP1253 includes Euro symbol at 0x80
   */
  enableGreekEncoding(): this {
    this.useGreekEncoding = true;
    return this;
  }

  /**
   * Disable Greek encoding mode
   * Text will be sent as UTF-8 (default)
   */
  disableGreekEncoding(): this {
    this.useGreekEncoding = false;
    return this;
  }

  // ==========================================================================
  // Initialization Commands
  // ==========================================================================

  /**
   * Initialize printer (ESC @)
   * Clears the print buffer and resets the printer to default settings.
   */
  initialize(): this {
    this.buffer.push(ESC, 0x40); // ESC @
    return this;
  }

  /**
   * Set character code page (ESC t n)
   * Selects the character code page for printing special characters.
   *
   * Common code pages:
   * - 0: CP437 (USA, Standard Europe)
   * - 16: CP737 (Greek)
   * - 17: CP851 (Greek)
   * - 18: CP869 (Greek)
   * - 19: CP866 (Cyrillic)
   * - 32: CP852 (Latin 2)
   * - 255: Custom (depends on printer)
   *
   * @param codePage - code page number (0-255)
   */
  setCodePage(codePage: number): this {
    this.buffer.push(ESC, 0x74, codePage); // ESC t n
    return this;
  }

  /**
   * Set international character set (ESC R n)
   * Selects one of the international character sets.
   *
   * Common character sets:
   * - 0: USA
   * - 1: France
   * - 2: Germany
   * - 3: UK
   * - 13: Greece
   *
   * @param charset - character set number (0-15)
   */
  setCharacterSet(charset: number): this {
    this.buffer.push(ESC, 0x52, charset); // ESC R n
    return this;
  }

  // ==========================================================================
  // Text Formatting Commands
  // ==========================================================================

  /**
   * Set bold mode (ESC E n)
   * @param enabled - true to enable bold, false to disable
   */
  bold(enabled: boolean): this {
    this.buffer.push(ESC, 0x45, enabled ? 1 : 0); // ESC E n
    return this;
  }

  /**
   * Set underline mode (ESC - n)
   * @param mode - 0: off, 1: 1-dot underline, 2: 2-dot underline
   */
  underline(mode: 0 | 1 | 2 = 1): this {
    this.buffer.push(ESC, 0x2d, mode); // ESC - n
    return this;
  }

  /**
   * Set text size (GS ! n)
   * @param size - width and height multipliers (1-8)
   */
  setTextSize(size: TextSize): this {
    // Clamp values to valid range
    const width = Math.max(1, Math.min(8, size.width)) - 1;
    const height = Math.max(1, Math.min(8, size.height)) - 1;
    // n = (width << 4) | height
    const n = (width << 4) | height;
    this.buffer.push(GS, 0x21, n); // GS ! n
    return this;
  }

  /**
   * Reset text size to normal (1x1)
   */
  normalSize(): this {
    return this.setTextSize({ width: 1, height: 1 });
  }

  /**
   * Set double width text
   */
  doubleWidth(): this {
    return this.setTextSize({ width: 2, height: 1 });
  }

  /**
   * Set double height text
   */
  doubleHeight(): this {
    return this.setTextSize({ width: 1, height: 2 });
  }

  /**
   * Set double width and height text
   */
  doubleSize(): this {
    return this.setTextSize({ width: 2, height: 2 });
  }

  // ==========================================================================
  // Alignment Commands
  // ==========================================================================

  /**
   * Set text alignment (ESC a n)
   * @param alignment - TextAlignment value
   */
  align(alignment: TextAlignment): this {
    this.buffer.push(ESC, 0x61, alignment); // ESC a n
    return this;
  }

  /**
   * Align text to the left
   */
  alignLeft(): this {
    return this.align(TextAlignment.LEFT);
  }

  /**
   * Align text to the center
   */
  alignCenter(): this {
    return this.align(TextAlignment.CENTER);
  }

  /**
   * Align text to the right
   */
  alignRight(): this {
    return this.align(TextAlignment.RIGHT);
  }

  // ==========================================================================
  // Text Output Commands
  // ==========================================================================

  /**
   * Add raw text to the buffer
   * Uses the configured character set for encoding
   * @param content - text string to add
   */
  text(content: string): this {
    // Auto-detect Greek characters
    const hasGreek = containsGreek(content);
    
    if (this.useGreekEncoding || hasGreek) {
      // Use the configured character set for encoding
      const bytes = encodeText(content, this.characterSet);
      for (const byte of bytes) {
        this.buffer.push(byte);
      }
    } else {
      // Default: ASCII encoding for non-Greek text
      for (const char of content) {
        const code = char.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7E) {
          this.buffer.push(code);
        } else if (char === '€') {
          this.buffer.push(0x45); // 'E' fallback for Euro
        } else {
          this.buffer.push(0x3F); // '?' for unknown
        }
      }
    }
    return this;
  }

  /**
   * Add text followed by a line feed
   * @param content - text string to add
   */
  textLine(content: string): this {
    return this.text(content).lineFeed();
  }

  /**
   * Add a line feed (LF)
   * @param count - number of line feeds (default 1)
   */
  lineFeed(count: number = 1): this {
    for (let i = 0; i < count; i++) {
      this.buffer.push(LF);
    }
    return this;
  }

  /**
   * Add a carriage return and line feed
   */
  newLine(): this {
    this.buffer.push(CR, LF);
    return this;
  }

  // ==========================================================================
  // Line Drawing and Separators
  // ==========================================================================

  /**
   * Draw a horizontal line using a character
   * @param char - character to use for the line (default '-')
   */
  horizontalLine(char: string = '-'): this {
    const line = char.repeat(this.lineWidth);
    return this.textLine(line);
  }

  /**
   * Draw a double horizontal line
   */
  doubleLine(): this {
    return this.horizontalLine('=');
  }

  /**
   * Draw a dotted line
   */
  dottedLine(): this {
    return this.horizontalLine('.');
  }

  /**
   * Add empty lines as spacing
   * @param count - number of empty lines
   */
  emptyLines(count: number): this {
    return this.lineFeed(count);
  }

  /**
   * Print a two-column row (left and right aligned text)
   * @param left - left-aligned text
   * @param right - right-aligned text
   */
  twoColumnRow(left: string, right: string): this {
    const padding = this.lineWidth - left.length - right.length;
    if (padding < 1) {
      // If text is too long, truncate left side
      const maxLeft = this.lineWidth - right.length - 1;
      const truncatedLeft = left.substring(0, maxLeft);
      const spaces = ' '.repeat(this.lineWidth - truncatedLeft.length - right.length);
      return this.textLine(truncatedLeft + spaces + right);
    }
    const spaces = ' '.repeat(padding);
    return this.textLine(left + spaces + right);
  }

  /**
   * Print a three-column row
   * @param left - left-aligned text
   * @param center - center text
   * @param right - right-aligned text
   */
  threeColumnRow(left: string, center: string, right: string): this {
    const totalTextLength = left.length + center.length + right.length;
    const totalPadding = this.lineWidth - totalTextLength;

    if (totalPadding < 2) {
      // Fallback to two columns if not enough space
      return this.twoColumnRow(left, right);
    }

    const leftPadding = Math.floor(totalPadding / 2);
    const rightPadding = totalPadding - leftPadding;

    const line = left + ' '.repeat(leftPadding) + center + ' '.repeat(rightPadding) + right;
    return this.textLine(line);
  }

  // ==========================================================================
  // Paper Cut Commands
  // ==========================================================================

  /**
   * Full paper cut (GS V 0)
   */
  fullCut(): this {
    this.buffer.push(GS, 0x56, 0x00); // GS V 0
    return this;
  }

  /**
   * Partial paper cut (GS V 1)
   */
  partialCut(): this {
    this.buffer.push(GS, 0x56, 0x01); // GS V 1
    return this;
  }

  /**
   * Feed paper and cut (GS V 66 n)
   * @param feedLines - number of lines to feed before cutting (default 3)
   */
  feedAndCut(feedLines: number = 3): this {
    this.buffer.push(GS, 0x56, 0x42, feedLines); // GS V 66 n
    return this;
  }

  /**
   * Default cut command (feed and partial cut)
   */
  cut(): this {
    return this.feedAndCut(3);
  }

  // ==========================================================================
  // Cash Drawer Commands
  // ==========================================================================

  /**
   * Open cash drawer (ESC p m t1 t2)
   * @param pin - drawer pin (0 or 1)
   */
  openCashDrawer(pin: 0 | 1 = 0): this {
    // ESC p m t1 t2
    // m = pin connector (0 or 1)
    // t1 = on time (25ms units)
    // t2 = off time (25ms units)
    this.buffer.push(ESC, 0x70, pin, 25, 250);
    return this;
  }

  // ==========================================================================
  // Build Methods
  // ==========================================================================

  /**
   * Get the current buffer as a Buffer object
   */
  build(): Buffer {
    return Buffer.from(this.buffer);
  }

  /**
   * Get the current buffer length
   */
  getLength(): number {
    return this.buffer.length;
  }

  /**
   * Get the paper size
   */
  getPaperSize(): PaperSize {
    return this.paperSize;
  }

  /**
   * Get the line width in characters
   */
  getLineWidth(): number {
    return this.lineWidth;
  }

  /**
   * Clear the buffer
   */
  clear(): this {
    this.buffer = [];
    return this;
  }

  /**
   * Append raw bytes to the buffer
   * @param bytes - array of bytes or Buffer to append
   */
  raw(bytes: number[] | Buffer): this {
    if (Buffer.isBuffer(bytes)) {
      for (const byte of bytes) {
        this.buffer.push(byte);
      }
    } else {
      this.buffer.push(...bytes);
    }
    return this;
  }

  // ==========================================================================
  // Enhanced Formatting Methods for Receipt Templates
  // ==========================================================================

  /**
   * Print a bold, centered section header with dividers
   * @param title - section title text
   */
  sectionHeader(title: string): this {
    return this
      .horizontalLine()
      .alignCenter()
      .bold(true)
      .textLine(title)
      .bold(false)
      .alignLeft()
      .horizontalLine();
  }

  /**
   * Print a boxed summary section with aligned label-value pairs
   * @param items - array of label-value pairs
   */
  summaryBox(items: Array<{ label: string; value: string }>): this {
    this.doubleLine();
    items.forEach(item => {
      this.twoColumnRow(item.label, item.value);
    });
    this.doubleLine();
    return this;
  }

  /**
   * Print a signature line with label
   * @param label - signature label (e.g., "CASHIER SIGNATURE")
   */
  signatureLine(label: string): this {
    return this
      .emptyLines(1)
      .textLine(label + ':')
      .emptyLines(1)
      .textLine('X' + '_'.repeat(Math.min(31, this.lineWidth - 2)));
  }

  /**
   * Print status with symbol indicator
   * @param status - status text
   * @param symbol - symbol to display (e.g., "[OK]", "[X]")
   */
  statusIndicator(status: string, symbol: string): this {
    return this.textLine(`${symbol} ${status}`);
  }

  /**
   * Print multi-column row with specified widths
   * @param columns - array of column text values
   * @param widths - array of column widths (should sum to lineWidth)
   */
  tableRow(columns: string[], widths: number[]): this {
    let row = '';
    columns.forEach((col, i) => {
      const width = widths[i] || 10;
      if (col.length > width) {
        row += col.substring(0, width);
      } else {
        row += col + ' '.repeat(width - col.length);
      }
    });
    return this.textLine(row.trimEnd());
  }

  /**
   * Shortcut for centered bold text
   * @param text - text to print
   */
  centeredBold(text: string): this {
    return this
      .alignCenter()
      .bold(true)
      .textLine(text)
      .bold(false)
      .alignLeft();
  }

  /**
   * Bold version of twoColumnRow
   * @param left - left-aligned text
   * @param right - right-aligned text
   */
  leftRightBold(left: string, right: string): this {
    this.bold(true);
    this.twoColumnRow(left, right);
    this.bold(false);
    return this;
  }

  /**
   * Draw a dashed line separator
   */
  dashedLine(): this {
    return this.horizontalLine('-');
  }

  /**
   * Draw a thick line using '=' character
   */
  thickLine(): this {
    return this.horizontalLine('=');
  }

  /**
   * Add a single empty line (alias for emptyLines(1))
   */
  emptyLine(): this {
    return this.emptyLines(1);
  }

  /**
   * Print a title with double-size, bold, centered formatting
   * @param title - title text
   */
  receiptTitle(title: string): this {
    return this
      .thickLine()
      .alignCenter()
      .doubleSize()
      .bold(true)
      .textLine(title)
      .bold(false)
      .normalSize()
      .alignLeft()
      .thickLine();
  }

  /**
   * Print a subsection header (bold, left-aligned)
   * @param title - subsection title
   */
  subsectionHeader(title: string): this {
    return this
      .emptyLine()
      .bold(true)
      .textLine(title)
      .bold(false)
      .dashedLine();
  }

  /**
   * Print indented text
   * @param text - text to indent
   * @param indent - number of spaces to indent (default 2)
   */
  indentedText(text: string, indent: number = 2): this {
    return this.textLine(' '.repeat(indent) + text);
  }

  /**
   * Print indented two-column row
   * @param left - left text
   * @param right - right text
   * @param indent - number of spaces to indent (default 2)
   */
  indentedTwoColumn(left: string, right: string, indent: number = 2): this {
    const indentedLeft = ' '.repeat(indent) + left;
    const padding = this.lineWidth - indentedLeft.length - right.length;
    if (padding < 1) {
      const maxLeft = this.lineWidth - right.length - 1;
      const truncatedLeft = indentedLeft.substring(0, maxLeft);
      const spaces = ' '.repeat(this.lineWidth - truncatedLeft.length - right.length);
      return this.textLine(truncatedLeft + spaces + right);
    }
    const spaces = ' '.repeat(padding);
    return this.textLine(indentedLeft + spaces + right);
  }

  /**
   * Print a warning message (bold, centered, with asterisks)
   * @param message - warning message
   */
  warningMessage(message: string): this {
    return this
      .emptyLine()
      .alignCenter()
      .bold(true)
      .textLine('*** ' + message + ' ***')
      .bold(false)
      .alignLeft()
      .emptyLine();
  }

  /**
   * Print receipt footer with centered message
   * @param message - footer message
   */
  receiptFooter(message: string): this {
    return this
      .emptyLines(2)
      .dashedLine()
      .alignCenter()
      .textLine(message)
      .alignLeft()
      .emptyLines(3);
  }
}
