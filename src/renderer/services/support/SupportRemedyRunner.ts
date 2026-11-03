import { z } from 'zod';
import { listen } from '@tauri-apps/api/event';
import { getBridge, type RecoveryActionDescriptor, type RecoveryActionRequest, type RecoveryActionResult, type RecoveryActionLogEntry, type RecoveryIssue } from '../../../lib';
import type { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { readHealthRemedyMatches, type RendererRemedyMatch, type SupportTranslate } from './SupportMatcherBridge';

export const OnsiteRequestSchema = z.object({
  request_id: z.string().min(1), session_id: z.string().min(1),
  title: z.string().max(600), description: z.string().max(2000), technical_details: z.string().max(16000).default(''),
  needs_staff_pin: z.boolean().default(false), remaining_ms: z.number().min(0).max(300000).default(300000),
  check_id: z.enum(['power_cycle_printer', 'check_printer_paper', 'check_printer_cable', 'check_network_cable', 'power_cycle_card_terminal']).optional(),
});
export type OnsiteRequest = z.infer<typeof OnsiteRequestSchema>;
export type OnsiteDecision = 'confirmed' | 'declined' | 'done' | 'not_done' | 'timeout';
export type PrivilegedRunner = ReturnType<typeof usePrivilegedActionConfirmation>['runWithPrivilegedConfirmation'];
/** These support events are deliberately native names, outside the compatibility map. */
export function listenSupportEvent(name: string, receive: (value: unknown) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<unknown>(name, event => { if (!disposed) { receive(event.payload); } }).then(stop => {
    if (disposed) { stop(); } else { unlisten = stop; }
  }).catch(() => { /* An unavailable support listener cannot affect selling. */ });
  return () => { disposed = true; unlisten?.(); };
}
export const RunRemedySchema = z.object({
  request_id: z.string().min(1), session_id: z.string().min(1), recipe_id: z.string().min(1).max(96),
  recipe_version: z.number().int().positive(), target_key: z.string().max(200).optional(),
  unattended: z.boolean().default(false), unattended_verified: z.boolean().default(false),
  organization_id: z.string().min(1).max(200).optional(),
});
let recoveryInFlight = false;
/** Shared by manual Health actions and remote support, including their PIN wait. */
export function acquireRecoveryAction(): (() => void) | null {
  if (recoveryInFlight) { return null; }
  recoveryInFlight = true;
  return () => { recoveryInFlight = false; };
}
export function buildRecoveryActionRequest(issue: RecoveryIssue, action: RecoveryActionDescriptor): RecoveryActionRequest {
  return { actionId: action.id, issueId: issue.id, issueCode: issue.code, queueId: issue.queueId ?? null,
    entityType: issue.entityType, entityId: issue.entityId, orderId: issue.orderId ?? null, orderNumber: issue.orderNumber ?? null,
    paymentId: issue.paymentId ?? null, adjustmentId: issue.adjustmentId ?? null, zReportId: issue.zReportId ?? null,
    shiftId: issue.shiftId ?? null, reportDate: typeof issue.params?.reportDate === 'string' ? issue.params.reportDate
      : typeof issue.params?.pendingReportDate === 'string' ? issue.params.pendingReportDate : action.routeTarget?.zReportDate ?? null,
    recipeId: action.recipeId ?? issue.knownSolution?.recipeId ?? null,
    recipeVersion: action.recipeVersion ?? issue.knownSolution?.version ?? null, routeTarget: action.routeTarget ?? null, params: issue.params };
}
export async function executeHealthRecoveryAction(options: {
  request: RecoveryActionRequest; action: RecoveryActionDescriptor; stale(): boolean; critical?(): boolean;
  authorize: PrivilegedRunner; t: SupportTranslate; onSnapshot?(id: string): void;
  beforeExecute?(): Promise<void>;
}): Promise<RecoveryActionResult> {
  const { request, action, authorize, t } = options;
  const check = () => {
    if (options.stale()) { throw new Error('REMEDY_NOT_APPLICABLE'); }
    if (options.critical?.()) { throw new Error('CONCURRENT_OPERATION'); }
  };
  check();
  if (action.recipeId === 'printer.restore_last_known_brand' && action.id === 'restoreLastKnownPrinterBrand') {
    // Native owns its snapshot, audit and critical fence; this remedy reads no PIN.
    await options.beforeExecute?.();
    check();
    const result = await getBridge().recovery.executeAction(request);
    if (result.snapshotPointId) { options.onSnapshot?.(result.snapshotPointId); }
    return result;
  }
  let snapshotPointId: string | null = null;
  if (action.requiresSnapshot) {
    const snapshot = await getBridge().recovery.createPreActionSnapshot();
    if (!snapshot?.id) { throw new Error('Recovery snapshot was not confirmed'); }
    options.onSnapshot?.(snapshot.id);
    snapshotPointId = snapshot.id;
  }
  return authorize({ scope: 'cash_drawer_control',
    action: async () => { check(); await options.beforeExecute?.(); check();
      return getBridge().recovery.executeAction({ ...request, ...(snapshotPointId ? { snapshotPointId } : {}) }); },
    title: t('recovery.confirmations.cashDrawerControl.title'), subtitle: t('recovery.confirmations.cashDrawerControl.subtitle') });
}

function refusalCode(error: unknown): string | null {
  const value = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'code' in error ? error.code : error;
  return typeof value === 'string' && ['FORBIDDEN', 'UNAUTHORIZED', 'REAUTH_REQUIRED', 'POLICY_REFUSED', 'CONCURRENT_OPERATION', 'REMEDY_NOT_APPLICABLE', 'REMEDY_COOLDOWN', 'REMEDY_ATTEMPT_CAP'].includes(value) ? value : null;
}

export interface SupportRunnerOptions {
  t: SupportTranslate; authorize: PrivilegedRunner;
  onsite(request: OnsiteRequest): Promise<OnsiteDecision>;
  critical(): boolean; sessionId(): string | null;
  matches?: () => Promise<RendererRemedyMatch[]>;
  ipc?: (command: string, payload: Record<string, unknown>) => Promise<unknown>;
}
/** Native owns eligibility, cooldown, attempts and final fresh-state verification. */
export class SupportRemedyRunner {
  private stopped = false;
  private seen = new Set<string>();
  private ipc: NonNullable<SupportRunnerOptions['ipc']>;
  constructor(private options: SupportRunnerOptions) {
    this.ipc = options.ipc ?? ((command, payload) => getBridge().invoke(command, payload));
  }
  private matches = () => this.options.matches?.() ?? readHealthRemedyMatches(this.options.t);
  private onList = (value: unknown) => {
    const request = z.object({ request_id: z.string().min(1) }).safeParse(value);
    if (!request.success || this.stopped) { return; }
    void this.matches().then(remedies => this.stopped ? undefined : this.ipc('till_list_remedies', { request_id: request.data.request_id,
      remedies: remedies.map(({ id, version, title, explanation, matches_now, target_count }) => ({ id, version, title, explanation, matches_now, target_count })) }))
      .catch(() => this.ipc('till_list_remedies', { request_id: request.data.request_id, error: 'REMEDY_NOT_APPLICABLE' })).catch(() => {});
  };
  private onRun = (value: unknown) => { void this.run(value).catch(() => {}); };
  start(): () => void {
    this.stopped = false;
    const stopRun = listenSupportEvent('support://run-remedy', this.onRun), stopList = listenSupportEvent('till_list_remedies', this.onList);
    return () => { this.stopped = true; stopRun(); stopList(); };
  }
  async run(value: unknown): Promise<void> {
    const parsed = RunRemedySchema.safeParse(value);
    if (!parsed.success || this.stopped) { return; }
    const input = parsed.data, identity = `${input.session_id}:${input.request_id}`;
    if (this.seen.has(identity)) { return; }
    this.seen.add(identity);
    let snapshotId: string | null = null;
    let release: (() => void) | null = null;
    let onsite = 'not_required';
    let applied = 0;
    const results: RecoveryActionResult[] = [];
    try {
      this.assertCurrent(input.session_id);
      const remedy = (await this.matches()).find(entry => entry.id === input.recipe_id && entry.version === input.recipe_version);
      this.assertCurrent(input.session_id);
      const targets = remedy?.targets.filter(target => !input.target_key || target.key === input.target_key) ?? [];
      if (!remedy || remedy.matches_now !== true || targets.length === 0) { throw new Error('REMEDY_NOT_APPLICABLE'); }
      const mutates = targets.some(target => !target.action.routeTarget);
      if (mutates && !(input.unattended && input.unattended_verified)) {
        const decision = await this.options.onsite({ request_id: input.request_id, session_id: input.session_id,
          title: remedy.title, description: remedy.explanation, technical_details: JSON.stringify({ recipe_id: input.recipe_id,
            recipe_version: input.recipe_version, target_keys: targets.map(target => target.key) }, null, 2),
          needs_staff_pin: remedy.id !== 'printer.restore_last_known_brand', remaining_ms: 300000 });
        if (decision !== 'confirmed') { throw new Error(decision === 'timeout' ? 'ONSITE_TIMEOUT' : 'ONSITE_DECLINED'); }
        onsite = 'confirmed';
      } else if (mutates) { onsite = 'unattended_verified'; }
      this.assertCurrent(input.session_id);
      if (this.options.critical()) { throw new Error('CONCURRENT_OPERATION'); }
      release = acquireRecoveryAction();
      if (!release) { throw new Error('CONCURRENT_OPERATION'); }
      for (const target of targets) {
        this.assertCurrent(input.session_id);
        const fresh = (await this.matches()).find(entry => entry.id === remedy.id && entry.version === remedy.version);
        const currentTarget = fresh?.targets.find(entry => entry.key === target.key);
        if (fresh?.matches_now !== true || !currentTarget) { throw new Error('REMEDY_NOT_APPLICABLE'); }
        const request = buildRecoveryActionRequest(currentTarget.issue, currentTarget.action);
        // Native audit attribution is carried separately from the action's issue parameters.
        const attributedRequest = { ...request, source: 'remote_support', sessionId: input.session_id, supportRequestId: input.request_id };
        const audit: RecoveryActionLogEntry & Record<string, unknown> = {
          id: `support:${input.request_id}:${currentTarget.key}`, actionId: currentTarget.action.id,
          issueCode: currentTarget.issue.code, issueId: currentTarget.issue.id, entityType: currentTarget.issue.entityType,
          success: false, outcome: 'pending', timestamp: new Date().toISOString(), recipeId: input.recipe_id,
          recipeVersion: input.recipe_version, snapshotPointId: null, actor: { staffId: null, staffName: null },
          targetRefs: { entityId: currentTarget.issue.entityId }, source: 'remote_support', sessionId: input.session_id,
          organizationId: input.organization_id ?? null,
        };
        const result = await executeHealthRecoveryAction({ request: attributedRequest,
          action: currentTarget.action, stale: () => this.stopped || this.options.sessionId() !== input.session_id,
          critical: this.options.critical, authorize: this.options.authorize, t: this.options.t,
          onSnapshot: id => { snapshotId = id; }, beforeExecute: async () => {
            this.assertCurrent(input.session_id);
            const latest = (await this.matches()).find(entry => entry.id === remedy.id && entry.version === remedy.version);
            if (latest?.matches_now !== true || !latest.targets.some(entry => entry.key === target.key)) { throw new Error('REMEDY_NOT_APPLICABLE'); }
            audit.snapshotPointId = snapshotId;
            await getBridge().recovery.recordActionLog(audit);
          } });
        results.push(result);
        if (result.success === true && result.verification?.status !== 'failed') { applied += currentTarget.count ?? 1; }
        Object.assign(audit, {
          success: result.success === true && result.verification?.status === 'passed',
          outcome: result.verification?.status === 'unknown' ? 'unknown' : result.success !== true || result.verification?.status === 'failed' ? 'failed'
            : currentTarget.action.routeTarget ? 'unknown' : result.verification?.status === 'passed' ? 'resolved' : 'pending',
          timestamp: new Date().toISOString(), recipeId: input.recipe_id, recipeVersion: input.recipe_version,
          snapshotPointId: snapshotId, actor: { staffId: null, staffName: null }, targetRefs: { entityId: currentTarget.issue.entityId },
          source: 'remote_support', sessionId: input.session_id,
        });
        await getBridge().recovery.recordActionLog(audit);
        if (result.success !== true || result.verification?.status === 'failed') { throw new Error('REMEDY_NOT_APPLICABLE'); }
        if (result.routeTarget) { window.dispatchEvent(new CustomEvent('pos:recovery-route', { detail: result.routeTarget })); }
      }
      // The native diagnostics owner publishes this read; Rust checks its time
      // against execution admission and never trusts the renderer's outcome.
      await this.matches();
      await this.ipc('support_remedy_result', { request_id: input.request_id, session_id: input.session_id, onsite,
        snapshot_id: snapshotId, targets_applied: applied, results });
    } catch (error) {
      const code = error instanceof Error && ['REMEDY_NOT_APPLICABLE', 'REMEDY_COOLDOWN', 'REMEDY_ATTEMPT_CAP', 'SNAPSHOT_FAILED', 'INSUFFICIENT_DISK', 'CONCURRENT_OPERATION', 'ONSITE_TIMEOUT', 'ONSITE_DECLINED', 'PAYLOAD_MISMATCH'].includes(error.message)
        ? error.message : 'REMEDY_NOT_APPLICABLE';
      const appRefusal = refusalCode(error);
      await this.ipc('support_remedy_result', { request_id: input.request_id, session_id: input.session_id, onsite,
        snapshot_id: snapshotId, targets_applied: applied, results, error: code, app_refusal: appRefusal });
    } finally { release?.(); }
  }
  private assertCurrent(sessionId: string): void {
    if (this.stopped || this.options.sessionId() !== sessionId) { throw new Error('PAYLOAD_MISMATCH'); }
  }
}
