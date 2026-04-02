import enBase from './en.json';
import elBase from './el.json';
import deBase from './de.json';
import frBase from './fr.json';
import itBase from './it.json';
import enHotfix from './overlays/en.sync-hotfix.json';
import elHotfix from './overlays/el.sync-hotfix.json';
import deHotfix from './overlays/de.sync-hotfix.json';
import frHotfix from './overlays/fr.sync-hotfix.json';
import itHotfix from './overlays/it.sync-hotfix.json';
import enSupport from './support/en.json';
import elSupport from './support/el.json';
import deSupport from './support/de.json';
import frSupport from './support/fr.json';
import itSupport from './support/it.json';

type LocaleBundle = Record<string, unknown>;

const isPlainObject = (value: unknown): value is LocaleBundle =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function mergeLocaleBundle(base: unknown, extension: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(extension)) {
    return extension;
  }

  const merged: LocaleBundle = { ...base };
  for (const [key, value] of Object.entries(extension)) {
    const currentValue = merged[key];
    if (isPlainObject(currentValue) && isPlainObject(value)) {
      merged[key] = mergeLocaleBundle(currentValue, value);
      continue;
    }

    merged[key] = value;
  }
  return merged;
}

export const localeBundles = {
  en: mergeLocaleBundle(mergeLocaleBundle(enBase, enHotfix), { support: enSupport }) as LocaleBundle,
  el: mergeLocaleBundle(mergeLocaleBundle(elBase, elHotfix), { support: elSupport }) as LocaleBundle,
  de: mergeLocaleBundle(mergeLocaleBundle(deBase, deHotfix), { support: deSupport }) as LocaleBundle,
  fr: mergeLocaleBundle(mergeLocaleBundle(frBase, frHotfix), { support: frSupport }) as LocaleBundle,
  it: mergeLocaleBundle(mergeLocaleBundle(itBase, itHotfix), { support: itSupport }) as LocaleBundle,
} as const;
