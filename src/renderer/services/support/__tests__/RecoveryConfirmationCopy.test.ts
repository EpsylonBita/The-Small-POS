// @vitest-environment node
import { readFileSync } from 'node:fs';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import { localeBundles } from '../../../../locales/bundles';

// Tomikro, 17/11/2026: the PIN window of a Health recovery action showed the raw keys
// `recovery.confirmations.cashDrawerControl.title` / `.subtitle` (no locale had them and the
// runner asked for them with no default), and the unbreakable title pushed the window sideways.

const read = (file: string) => readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8');
const LOCALES = Object.keys(localeBundles) as Array<keyof typeof localeBundles>;
const KEYS = ['recovery.confirmations.cashDrawerControl.title', 'recovery.confirmations.cashDrawerControl.subtitle'] as const;

const translatorFor = async (lng: keyof typeof localeBundles) => {
  const instance = i18next.createInstance();
  await instance.init({ lng, fallbackLng: false, resources: { [lng]: { translation: localeBundles[lng] } },
    interpolation: { escapeValue: false } });
  return instance.t;
};

describe('the PIN window of a recovery action', () => {
  it('ships the six locales the app offers', () => {
    expect([...LOCALES].sort()).toEqual(['de', 'el', 'en', 'fr', 'it', 'sq']);
  });

  it.each(LOCALES)('%s has its own title and explanation, never a raw key', async (lng) => {
    const t = await translatorFor(lng);
    const english = await translatorFor('en');
    for (const key of KEYS) {
      const text = t(key);
      expect(text, key).not.toBe(key);
      expect(text.trim().length, key).toBeGreaterThan(8);
      expect(text, key).not.toMatch(/NEEDS TRANSLATION|\?{3,}|\{\{/);
      if (lng !== 'en') { expect(text, key).not.toBe(english(key)); }
    }
  });

  it('asks for every literal key with a fallback text or a key the English bundle has', async () => {
    const english = await translatorFor('en');
    const source = read('src/renderer/services/support/SupportRemedyRunner.ts');
    const calls = [...source.matchAll(/\bt\(\s*'([A-Za-z0-9_.-]+)'\s*(,\s*\{[^}]*\})?\s*\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(KEYS.length);
    for (const [, key, options] of calls) {
      expect(english(key), key).not.toBe(key);
      // A key a future locale lacks still reads as words, not as a dotted key.
      expect(options ?? '', key).toMatch(/defaultValue:\s*'[^']{8,}'/);
    }
  });

  it('lets a window title wrap and break instead of widening the window', () => {
    const css = read('src/renderer/styles/glassmorphism.css');
    const start = css.indexOf('\n.liquid-glass-modal-title {');
    expect(start).toBeGreaterThan(0);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).toMatch(/min-width:\s*0;/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere;/);
    const header = css.indexOf('\n.liquid-glass-modal-header {');
    expect(css.slice(header, css.indexOf('}', header))).toMatch(/gap:\s*0\.75rem;/);
  });
});
