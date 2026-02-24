export type AddressLanguage = string;

const GREEK_SCRIPT_REGEX = /[\u0370-\u03FF\u1F00-\u1FFF]/u;
const HOUSE_NUMBER_REGEX = /\b\d+[A-Za-zΑ-Ωα-ω]?\b/u;
const NON_ASCII_REGEX = /[^\x00-\x7F]/;
const GREEK_LETTER_REGEX = /\p{Script=Greek}/u;
const CYRILLIC_LETTER_REGEX = /\p{Script=Cyrillic}/u;
const ARABIC_LETTER_REGEX = /\p{Script=Arabic}/u;
const HEBREW_LETTER_REGEX = /\p{Script=Hebrew}/u;
const LATIN_LETTER_REGEX = /\p{Script=Latin}/u;
const TURKISH_LETTER_REGEX = /[çğıöşüİı]/iu;
const ALBANIAN_HINT_REGEX = /\b(sheshi|rruga|lagjja|qyteti|durr[eë]s|tiran[eë])\b/iu;
const BCP47_REGEX = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function resolveAddressLanguage(...candidates: Array<string | null | undefined>): AddressLanguage {
  for (const value of candidates) {
    const normalized = (value || '').trim();
    if (!normalized) continue;
    if (BCP47_REGEX.test(normalized)) {
      return normalized.toLowerCase();
    }
  }

  for (const value of candidates) {
    if (typeof value !== 'string') {
      continue;
    }
    if (GREEK_SCRIPT_REGEX.test(value)) {
      return 'el';
    }
    if (CYRILLIC_LETTER_REGEX.test(value)) {
      return 'sr';
    }
    if (ARABIC_LETTER_REGEX.test(value)) {
      return 'ar';
    }
    if (HEBREW_LETTER_REGEX.test(value)) {
      return 'he';
    }
    if (TURKISH_LETTER_REGEX.test(value)) {
      return 'tr';
    }
    if (ALBANIAN_HINT_REGEX.test(value)) {
      return 'sq';
    }
  }

  return 'en';
}

export function hasGreekScript(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return GREEK_SCRIPT_REGEX.test(value);
}

function detectPrimaryScript(value: string): 'latin' | 'greek' | 'cyrillic' | 'arabic' | 'hebrew' | 'unknown' {
  if (GREEK_LETTER_REGEX.test(value)) return 'greek';
  if (CYRILLIC_LETTER_REGEX.test(value)) return 'cyrillic';
  if (ARABIC_LETTER_REGEX.test(value)) return 'arabic';
  if (HEBREW_LETTER_REGEX.test(value)) return 'hebrew';
  if (LATIN_LETTER_REGEX.test(value)) return 'latin';
  return 'unknown';
}

export function shouldPreferInputLanguage(
  input: string | null | undefined,
  candidate: string | null | undefined
): boolean {
  const inputText = (input || '').trim();
  const candidateText = (candidate || '').trim();

  if (!inputText || !candidateText) {
    return false;
  }

  const inputScript = detectPrimaryScript(inputText);
  const candidateScript = detectPrimaryScript(candidateText);
  if (inputScript !== 'unknown' && candidateScript !== 'unknown' && inputScript !== candidateScript) {
    return true;
  }

  const inputHasNonAscii = NON_ASCII_REGEX.test(inputText);
  const candidateHasNonAscii = NON_ASCII_REGEX.test(candidateText);
  if (inputHasNonAscii && !candidateHasNonAscii) {
    return true;
  }

  return false;
}

export function buildPreferredStreetFromInput(
  input: string | null | undefined,
  formattedAddress?: string | null,
  explicitStreetNumber?: string | null
): string {
  const base = (input || '').trim();
  if (!base) {
    return '';
  }

  if (/\d/.test(base)) {
    return base;
  }

  const num = (explicitStreetNumber || '').trim();
  if (num) {
    return `${base} ${num}`;
  }

  const match = (formattedAddress || '').match(HOUSE_NUMBER_REGEX);
  if (match?.[0]) {
    return `${base} ${match[0]}`;
  }

  return base;
}

export function applyGreekSuggestionFallback(
  input: string | null | undefined,
  name: string | null | undefined,
  formattedAddress: string | null | undefined
): { name: string; formattedAddress: string } {
  const safeName = (name || '').trim();
  const safeFormatted = (formattedAddress || '').trim();
  const preferredStreet = buildPreferredStreetFromInput(input, safeFormatted);

  if (!preferredStreet) {
    return {
      name: safeName,
      formattedAddress: safeFormatted,
    };
  }

  const rest = safeFormatted.includes(',') ? safeFormatted.slice(safeFormatted.indexOf(',')) : '';
  return {
    name: preferredStreet,
    formattedAddress: rest ? `${preferredStreet}${rest}` : preferredStreet,
  };
}

export function applyInputLanguageFallback(
  input: string | null | undefined,
  name: string | null | undefined,
  formattedAddress: string | null | undefined
): { name: string; formattedAddress: string } {
  return applyGreekSuggestionFallback(input, name, formattedAddress);
}
