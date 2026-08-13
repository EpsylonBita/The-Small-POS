/**
 * A `t()` for component tests that answers from the real English locale file.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**. Requirements R16.1, R16.4.
 *
 * Component tests normally stub `useTranslation` with a `t` that echoes the
 * `defaultValue`, which quietly makes them pass against copy that was never
 * shipped: a key missing from `en.json` still renders, because the fallback
 * carried the sentence. Resolving against the actual locale file instead means
 * a test that asserts a sentence is also asserting the key exists and that the
 * shipped wording says it — the two things the audit would otherwise have to
 * take on trust.
 *
 * Plural handling mirrors i18next: with a `count` option, `key_one` /
 * `key_other` win over the bare key.
 */

import en from '../../locales/en.json';

type TranslateOptions = Record<string, unknown> & { defaultValue?: string };

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (current, segment) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[segment]
          : undefined,
      en as unknown,
    );
}

function interpolate(template: string, options: TranslateOptions): string {
  let text = template;
  for (const [name, value] of Object.entries(options)) {
    if (name === 'defaultValue') continue;
    text = text.split(`{{${name}}}`).join(String(value));
  }
  return text;
}

/**
 * Resolve `key` from `en.json`, falling back to the caller's default value and
 * finally to the key itself (which makes an unresolved key visible in the DOM
 * rather than silently blank).
 */
export function translateEn(key: string, second?: string | TranslateOptions): string {
  const options: TranslateOptions =
    second && typeof second === 'object' ? second : { defaultValue: second };

  const candidates: string[] = [];
  if (typeof options.count === 'number') {
    candidates.push(options.count === 1 ? `${key}_one` : `${key}_other`);
  }
  candidates.push(key);

  for (const candidate of candidates) {
    const value = lookup(candidate);
    if (typeof value === 'string') {
      return interpolate(value, options);
    }
  }

  return options.defaultValue ? interpolate(options.defaultValue, options) : key;
}

/** Drop-in replacement for `useTranslation()` in a component test. */
export function useTranslationEn() {
  return { t: translateEn, i18n: { language: 'en' } };
}
