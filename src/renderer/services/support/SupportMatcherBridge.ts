import { getBridge, type RecoveryActionDescriptor, type RecoveryIssue } from '../../../lib';
import { buildSyncRecoveryIssues, RECOVERY_RECIPES } from '../../components/recovery/sync-recovery-issues';
import type { HealthProblemCode } from '../../../../../shared/pos/health/health-contract';
import { syncNowTargetItems } from '../../components/recovery/sync-now-attempt';

export type HealthMatcherInput = Parameters<typeof buildSyncRecoveryIssues>[0];
export interface RemedyTarget { key: string; issue: RecoveryIssue; action: RecoveryActionDescriptor; count?: number }
export interface RendererRemedyMatch {
  id: string; version: number; title: string; explanation: string;
  matches_now: boolean | 'not_applicable'; target_count: number;
  targets: RemedyTarget[];
  observation?: { status: 'fresh' | 'stale' | 'unavailable'; inputs: Record<string, Omit<MatcherObservation<unknown>, 'content'>> };
}
export interface MatcherObservation<T> { status: 'fresh' | 'stale' | 'unavailable'; at: string | null; age_ms: number | null; content: T | null }
export interface SupportMatcherInputs {
  systemHealth: MatcherObservation<HealthMatcherInput['systemHealth']>;
  financialItems: MatcherObservation<HealthMatcherInput['financialItems']>;
  integrity: MatcherObservation<HealthMatcherInput['integrity']>;
  parityItems: MatcherObservation<HealthMatcherInput['parityItems']>;
}
export type SupportTranslate = (key: string, params?: Record<string, unknown>) => string;
export interface HealthSupportObservation { problem: HealthProblemCode; realtime: string; stale: boolean; observedAt?: number }
let healthObservation: HealthSupportObservation | null = null;
/** The mounted Health view supplies its own classification; support never guesses it. */
export function registerSupportHealthObservation(value: HealthSupportObservation): () => void {
  const retained = { ...value, observedAt: value.observedAt ?? Date.now() };
  healthObservation = retained;
  return () => { if (healthObservation === retained) { healthObservation = null; } };
}
export const SUPPORT_HEALTH_ACTIONS = [
  { id: 'syncNow', actionId: 'runParitySyncNow', titleKey: 'sync.healthModal.primaryAction.syncNow.label', explanationKey: 'sync.healthModal.primaryAction.syncNow.detail' },
  { id: 'printerReprobe', actionId: 'printerReprobe', titleKey: 'common.refresh', explanationKey: 'settings.printer.quickWizardVerifyTransportHint' },
  { id: 'testPrint', actionId: 'testPrint', titleKey: 'settings.printer.testPrint', explanationKey: 'settings.printer.quickWizardVerifyIntro' },
] as const;

/** The catalogue is shipped code. Neither native events nor operator text define an action. */
export function matchHealthRemedies(input: HealthMatcherInput, stale: boolean, t: SupportTranslate, observation = healthObservation): RendererRemedyMatch[] {
  const issues = buildSyncRecoveryIssues(input).issues;
  const recipes: RendererRemedyMatch[] = Object.values(RECOVERY_RECIPES).map((recipe): RendererRemedyMatch => {
    const targets = issues.flatMap(issue => issue.actions
      .filter(action => action.recipeId === recipe.recipeId && action.recipeVersion === recipe.version)
      .map(action => ({ key: issue.id, issue, action, count: typeof issue.params?.count === 'number' && Number.isSafeInteger(issue.params.count) && issue.params.count > 0 ? issue.params.count : 1 })));
    return { id: recipe.recipeId, version: recipe.version, title: t(recipe.labelKey), explanation: t(recipe.explanationKey),
      matches_now: stale || !input.systemHealth ? 'not_applicable' : targets.length > 0,
      target_count: stale || !input.systemHealth ? 0 : targets.reduce((total, target) => total + target.count, 0), targets: stale ? [] : targets };
  });
  const health = input.systemHealth;
  const manual: RendererRemedyMatch[] = SUPPORT_HEALTH_ACTIONS.map((definition): RendererRemedyMatch => {
    const age = observation?.observedAt === undefined ? null : Date.now() - observation.observedAt;
    const observationStatus = !observation || age === null || age < 0 ? 'unavailable' : observation.stale || age > 300_000 ? 'stale' : 'fresh';
    const unavailable = stale || !health || observationStatus !== 'fresh';
    const syncRows = observation ? syncNowTargetItems(observation.problem, input.parityItems ?? [], Date.now()) : [];
    const count = unavailable ? 0 : definition.id === 'syncNow' ? syncRows.length
      : Number(health.printerStatus.configured && Boolean(health.printerStatus.defaultProfile));
    const key = definition.id === 'printerReprobe' || definition.id === 'testPrint' ? health?.printerStatus.defaultProfile ?? '' : definition.id;
    const action: RecoveryActionDescriptor = { id: definition.actionId, recipeId: definition.id, recipeVersion: 1,
      labelKey: definition.titleKey, descriptionKey: definition.explanationKey, safetyLevel: 'safe',
      requiresOnline: definition.id === 'syncNow', requiresSnapshot: false, confirmationRequired: false };
    const issue: RecoveryIssue = { id: `health-${definition.id}`, code: definition.id, severity: 'info', status: 'blocking',
      entityType: definition.id === 'printerReprobe' || definition.id === 'testPrint' ? 'printer' : 'sync', entityId: key,
      titleKey: definition.titleKey, summaryKey: definition.explanationKey, guidanceKey: definition.explanationKey,
      params: { printerId: health?.printerStatus.defaultProfile ?? null, queueRowIds: syncRows.map(row => row.id) }, actions: [action] };
    return { id: definition.id, version: 1, title: t(definition.titleKey), explanation: t(definition.explanationKey),
      matches_now: unavailable ? 'not_applicable' : count > 0, target_count: count,
      targets: count > 0 ? [{ key, issue, action, count }] : [],
      observation: { status: observationStatus, inputs: { healthView: { status: observationStatus, at: observation?.observedAt === undefined ? null : new Date(observation.observedAt).toISOString(), age_ms: age } } } };
  });
  const addressRepair = recipes.find(recipe => recipe.id === 'customer-address-default-conflict.repair');
  const nativeAddress: RendererRemedyMatch[] = addressRepair ? [{ ...addressRepair, id: 'customer-address-default.retry',
    targets: addressRepair.targets.map(target => ({ ...target, key: target.issue.entityId,
      action: { ...target.action, id: 'nativeCustomerAddressDefaultRetry', recipeId: 'customer-address-default.retry', recipeVersion: 1, requiresSnapshot: true } })) }] : [];
  return [...recipes, ...nativeAddress, ...manual];
}

/** Support owns its read handles; manual Health commands must never run here. */
export async function readHealthRemedyMatches(t: SupportTranslate): Promise<RendererRemedyMatch[]> {
  const unavailable = (): MatcherObservation<never> => ({ status: 'unavailable', at: null, age_ms: null, content: null });
  const inputs: SupportMatcherInputs = await getBridge().invoke('support_matcher_inputs').catch(() => ({
    systemHealth: unavailable(), financialItems: unavailable(), integrity: unavailable(), parityItems: unavailable(),
  }));
  const values = Object.values(inputs);
  const status = values.some(value => value.status === 'unavailable') ? 'unavailable'
    : values.some(value => value.status === 'stale') ? 'stale' : 'fresh';
  const { systemHealth, financialItems, integrity, parityItems } = inputs;
  const missing = !systemHealth.content || systemHealth.content.syncBacklogStatus === 'unavailable' ||
    !Array.isArray(financialItems.content) || !Array.isArray(integrity.content?.issues) || !Array.isArray(parityItems.content);
  const matches = matchHealthRemedies({ systemHealth: systemHealth.content,
    lastParitySync: systemHealth.content?.lastParitySync, financialItems: financialItems.content ?? [],
    integrity: integrity.content, parityItems: parityItems.content ?? [] }, status !== 'fresh' || missing, t);
  const metadata = Object.fromEntries(Object.entries(inputs).map(([key, { status: inputStatus, at, age_ms }]) => [key, { status: inputStatus, at, age_ms }]));
  return matches.map(match => {
    const observation: NonNullable<RendererRemedyMatch['observation']> = {
      status: missing || status === 'unavailable' || match.observation?.status === 'unavailable' ? 'unavailable'
        : status === 'stale' || match.observation?.status === 'stale' ? 'stale' : 'fresh',
      inputs: { ...metadata, ...match.observation?.inputs },
    };
    // The closed remote contract has an explanation but no observation fields.
    // Keep the evidence age visible there too, without exporting input content.
    return { ...match, observation, explanation: observation.status === 'fresh' ? match.explanation
      : `${match.explanation}\n${JSON.stringify({ observation })}` };
  });
}
