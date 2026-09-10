import itPlatforms from './overlays/it.platforms.json';
import frPlatforms from './overlays/fr.platforms.json';
import dePlatforms from './overlays/de.platforms.json';
import elPlatforms from './overlays/el.platforms.json';
import enPlatforms from './overlays/en.platforms.json';
import enShiftWorkflow from './overlays/en.shift-workflow-fixes.json';
import elShiftWorkflow from './overlays/el.shift-workflow-fixes.json';
import deShiftWorkflow from './overlays/de.shift-workflow-fixes.json';
import frShiftWorkflow from './overlays/fr.shift-workflow-fixes.json';
import itShiftWorkflow from './overlays/it.shift-workflow-fixes.json';
import enRoomWorkflow from './overlays/en.room-workflow-fixes.json';
import elRoomWorkflow from './overlays/el.room-workflow-fixes.json';
import deRoomWorkflow from './overlays/de.room-workflow-fixes.json';
import frRoomWorkflow from './overlays/fr.room-workflow-fixes.json';
import itRoomWorkflow from './overlays/it.room-workflow-fixes.json';
import enScheduleWorkflow from './overlays/en.schedule-workflow-fixes.json';
import elScheduleWorkflow from './overlays/el.schedule-workflow-fixes.json';
import deScheduleWorkflow from './overlays/de.schedule-workflow-fixes.json';
import frScheduleWorkflow from './overlays/fr.schedule-workflow-fixes.json';
import itScheduleWorkflow from './overlays/it.schedule-workflow-fixes.json';
import enWorkflowAudit from './overlays/en.workflow-audit.json';
import elWorkflowAudit from './overlays/el.workflow-audit.json';
import deWorkflowAudit from './overlays/de.workflow-audit.json';
import frWorkflowAudit from './overlays/fr.workflow-audit.json';
import itWorkflowAudit from './overlays/it.workflow-audit.json';
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
import enOnboarding from './overlays/en.onboarding.json';
import elOnboarding from './overlays/el.onboarding.json';
import deOnboarding from './overlays/de.onboarding.json';
import frOnboarding from './overlays/fr.onboarding.json';
import itOnboarding from './overlays/it.onboarding.json';
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

const mergeLocaleLayers = (...layers: unknown[]): LocaleBundle =>
  layers.reduce(mergeLocaleBundle) as LocaleBundle;

export const localeBundles = {
  en: mergeLocaleLayers(enBase, enHotfix, enTableCheck, { support: enSupport }, enSettingsWorkflow, enOnboarding, enShiftWorkflow, enRoomWorkflow, enScheduleWorkflow, enWorkflowAudit, enPlatforms),
  el: mergeLocaleLayers(elBase, elHotfix, elTableCheck, { support: elSupport }, elSettingsWorkflow, elOnboarding, elShiftWorkflow, elRoomWorkflow, elScheduleWorkflow, elWorkflowAudit, elPlatforms),
  de: mergeLocaleLayers(deBase, deHotfix, deTableCheck, { support: deSupport }, deSettingsWorkflow, deOnboarding, deShiftWorkflow, deRoomWorkflow, deScheduleWorkflow, deWorkflowAudit, dePlatforms),
  fr: mergeLocaleLayers(frBase, frHotfix, frTableCheck, { support: frSupport }, frSettingsWorkflow, frOnboarding, frShiftWorkflow, frRoomWorkflow, frScheduleWorkflow, frWorkflowAudit, frPlatforms),
  it: mergeLocaleLayers(itBase, itHotfix, itTableCheck, { support: itSupport }, itSettingsWorkflow, itOnboarding, itShiftWorkflow, itRoomWorkflow, itScheduleWorkflow, itWorkflowAudit, itPlatforms),
} as const;
