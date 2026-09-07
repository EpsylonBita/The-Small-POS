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
import enTableCheck from './overlays/en.table-check.json';
import elTableCheck from './overlays/el.table-check.json';
import deTableCheck from './overlays/de.table-check.json';
import frTableCheck from './overlays/fr.table-check.json';
import itTableCheck from './overlays/it.table-check.json';
import enSettingsWorkflow from './overlays/en.settings-workflow.json';
import elSettingsWorkflow from './overlays/el.settings-workflow.json';
import deSettingsWorkflow from './overlays/de.settings-workflow.json';
import frSettingsWorkflow from './overlays/fr.settings-workflow.json';
import itSettingsWorkflow from './overlays/it.settings-workflow.json';
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
  en: mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(enBase, enHotfix), enTableCheck), { support: enSupport }), enSettingsWorkflow) as LocaleBundle,
  el: mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(elBase, elHotfix), elTableCheck), { support: elSupport }), elSettingsWorkflow) as LocaleBundle,
  de: mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(deBase, deHotfix), deTableCheck), { support: deSupport }), deSettingsWorkflow) as LocaleBundle,
  fr: mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(frBase, frHotfix), frTableCheck), { support: frSupport }), frSettingsWorkflow) as LocaleBundle,
  it: mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(mergeLocaleBundle(itBase, itHotfix), itTableCheck), { support: itSupport }), itSettingsWorkflow) as LocaleBundle,
} as const;
