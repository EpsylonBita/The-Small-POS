import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORT_LOCALES, validateSupportLocales } from '../../../../../../shared/pos/support/i18n-keys';

function bundle(app: string, locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`../${app}/src/locales/support/${locale}.json`, 'utf8'));
}
function lookup(value: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, value);
}
describe('Phase three support locale parity', () => {
  it('keeps the complete shared key inventory and Greek reference', () => {
    expect(validateSupportLocales(Object.fromEntries(SUPPORT_LOCALES.map(locale => [locale, bundle('pos-tauri', locale)])))).toEqual([]);
  });
  it.each(SUPPORT_LOCALES)('%s matches Android exactly and translates every Phase 3 renderer key', locale => {
    const desktop = bundle('pos-tauri', locale);
    expect(desktop).toEqual(bundle('POSSystemMobile', locale));
    expect(desktop.onsite).not.toHaveProperty('commandReadback');
    expect(desktop.onsite).not.toHaveProperty('terminalCommandConsequences');
    for (const key of ['restore.action', 'restore.snapshotFirst', 'restore.snapshots', 'restore.quarantine', 'restore.resynced', 'restore.confirm',
      'restore.reasons.pre_breakglass_sql', 'restore.reasons.pre_quarantine', 'restore.reasons.pre_quarantine_restore', 'restore.reasons.pre_command', 'restore.reasons.pre_restore',
      'onsite.aiExplanation', 'onsite.terminalCommandWarning', 'banner.restoreRestarting', 'banner.endDuringWrite.committed', 'banner.endDuringWrite.rolledBack']) {
      const text = lookup(desktop, key); expect(text).toEqual(expect.any(String)); expect(text).not.toBe(key); expect(text).not.toMatch(/\uFFFD|\?{2,}/);
    }
    if (locale === 'el') { expect(lookup(desktop, 'banner.restoreRestarting')).toBe('\u0395\u03c0\u03b1\u03bd\u03b5\u03ba\u03ba\u03af\u03bd\u03b7\u03c3\u03b7 \u03b3\u03b9\u03b1 \u03b5\u03c0\u03b1\u03bd\u03b1\u03c6\u03bf\u03c1\u03ac'); }
  });
});
