import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { getBridge } from '../../../lib';
import { useSupportSession } from '../../hooks/useSupportSession';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { supportButtonClass, supportSelectedClass } from './SupportOnsiteChip';

const AppliesSchema = z.object({ applies: z.array(z.object({ id: z.string(), session_id: z.string(),
  device_id: z.string(), state: z.string(), undo_available: z.boolean() })) });
const SnapshotsSchema = z.object({ snapshots: z.array(z.object({
  snapshot_id: z.string().min(1), taken_at: z.iso.datetime({ offset: true }),
  reason: z.enum(['pre_breakglass_sql', 'pre_quarantine', 'pre_quarantine_restore', 'pre_command', 'pre_restore']),
  integrity_ok: z.boolean(), restorable: z.boolean(),
  changed_since: z.array(z.object({ table: z.string(), count: z.number().int().nonnegative(), resynced_from_server: z.boolean() })),
})) });
const QuarantineSchema = z.object({ groups: z.array(z.object({
  group_id: z.string().min(1), created_at: z.iso.datetime({ offset: true }), tables: z.array(z.string()),
  row_counts: z.record(z.string(), z.number().int().nonnegative()),
  restore_state: z.enum(['quarantined', 'restored', 'expired']), restorable: z.boolean(),
}).refine(group => group.tables.every(table => group.row_counts[table] !== undefined))) });
type RestoreSelection = { kind: 'snapshot' | 'group'; id: string };
export function SupportDetailsPanel() {
  const { t } = useTranslation(), session = useSupportSession();
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  const [expanded, setExpanded] = useState(false), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const [applies, setApplies] = useState<z.infer<typeof AppliesSchema>['applies']>([]);
  const [snapshots, setSnapshots] = useState<z.infer<typeof SnapshotsSchema>['snapshots']>([]);
  const [groups, setGroups] = useState<z.infer<typeof QuarantineSchema>['groups']>([]);
  const [confirm, setConfirm] = useState<RestoreSelection | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const current = useRef(session?.snapshot); current.current = session?.snapshot;
  const inFlight = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!expanded || !session?.snapshot?.can_connect) { setApplies([]); return; }
    void Promise.resolve(getBridge().invoke('support_undo_device_apply', { action: 'list' })).then(value => {
      const rows = AppliesSchema.parse(value);
      if (alive) { setApplies(rows.applies); setFailed(false); }
    }).catch(() => { if (alive) { setFailed(true); } });
    return () => { alive = false; };
  }, [expanded, revision, session?.snapshot?.can_connect]);
  useEffect(() => {
    let alive = true;
    setRecoveryReady(false); setRecoveryFailed(false); setConfirm(null);
    if (!expanded || !session?.snapshot?.can_connect) { setSnapshots([]); setGroups([]); return; }
    void Promise.all([getBridge().invoke('support_list_snapshots'), getBridge().invoke('support_list_quarantine')]).then(([snapshotValue, groupValue]) => {
      const nextSnapshots = SnapshotsSchema.parse(snapshotValue).snapshots;
      const nextGroups = QuarantineSchema.parse(groupValue).groups;
      if (alive) {
        setSnapshots(nextSnapshots.sort((left, right) => Date.parse(right.taken_at) - Date.parse(left.taken_at)));
        setGroups(nextGroups); setRecoveryReady(true);
      }
    }).catch(() => { if (alive) { setRecoveryFailed(true); } });
    return () => { alive = false; };
  }, [expanded, revision, session?.snapshot?.can_connect]);
  const restore = async (selection: RestoreSelection) => {
    if (inFlight.current || !recoveryReady || current.current?.critical_op_active || !current.current?.can_connect) { return; }
    inFlight.current = true; setBusy(true); setFailed(false);
    try {
      // Native must check the same manual system-control authority as Undo.
      // The wrapper handles the store's own re-authentication after this tap.
      const result: unknown = await runWithPrivilegedConfirmation({ scope: 'system_control',
        title: t('support.restore.action'), subtitle: t('support.onsite.storePinNotice'), action: () => {
          if (!current.current?.can_connect || current.current.critical_op_active) { throw new Error('Restore no longer authorized'); }
          return selection.kind === 'snapshot'
            ? getBridge().invoke('support_restore_snapshot', { snapshot_id: selection.id })
            : getBridge().invoke('support_restore_quarantine', { group_id: selection.id });
        } });
      if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true) { throw new Error('Restore refused'); }
      setRevision(value => value + 1);
    } catch { setFailed(true); }
    finally { setConfirm(null); inFlight.current = false; setBusy(false); }
  };
  if (!session?.snapshot?.can_connect) { return null; }
  return <section data-testid="support-details-panel" className="space-y-3 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface) p-3 text-(--pos-s-fg)">
    <button type="button" className={supportButtonClass} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t('support.onsite.technicalDetails')}</button>
    {expanded && applies.map(apply => <div key={apply.id} className="flex flex-wrap items-center gap-3">
      <span className="break-all">{apply.device_id}</span>
      {apply.undo_available && <button type="button" className={supportButtonClass} disabled={busy || session.snapshot?.critical_op_active} onClick={() => {
        if (inFlight.current) { return; }
        inFlight.current = true; setBusy(true); setFailed(false);
        // As with manual device settings, native must check system_control before
        // writing. The existing app dialog handles REAUTH_REQUIRED; support rights
        // alone never grant or mint that authorization.
        void runWithPrivilegedConfirmation({ scope: 'system_control',
          title: t('support.deviceApply.undo'), subtitle: t('support.onsite.storePinNotice'),
          action: async () => {
            if (!current.current?.can_connect || current.current.critical_op_active) { throw new Error('Undo no longer authorized'); }
            return getBridge().invoke('support_undo_device_apply', { action: 'undo', apply_id: apply.id, session_id: apply.session_id });
          },
        }).then(result => {
          if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true) { throw new Error('Undo refused'); }
          setRevision(value => value + 1);
        }).catch(() => setFailed(true)).finally(() => { inFlight.current = false; setBusy(false); });
      }}>{t('support.deviceApply.undo')}</button>}
    </div>)}
    {expanded && snapshots.length > 0 && <h3 className="font-semibold">{t('support.restore.snapshots')}</h3>}
    {expanded && snapshots.map((snapshot, index) => <div key={snapshot.snapshot_id} data-testid={`support-snapshot-${snapshot.snapshot_id}`} className="space-y-2 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) p-3">
      <p><time dateTime={snapshot.taken_at}>{snapshot.taken_at}</time>{' · '}{t(`support.restore.reasons.${snapshot.reason}`)}</p>
      {snapshot.changed_since.map(row => <p key={row.table}>{`${row.table}: ${row.count}${row.resynced_from_server ? ` · ${t('support.restore.resynced')}` : ''}`}</p>)}
      {index === 0 && snapshot.integrity_ok && snapshot.restorable && <button type="button" className={supportButtonClass} disabled={busy || !recoveryReady || session.snapshot?.critical_op_active}
        onClick={() => setConfirm({ kind: 'snapshot', id: snapshot.snapshot_id })}>{t('support.restore.action')}</button>}
    </div>)}
    {expanded && groups.length > 0 && <h3 className="font-semibold">{t('support.restore.quarantine')}</h3>}
    {expanded && groups.map(group => <div key={group.group_id} data-testid={`support-quarantine-${group.group_id}`} className="space-y-2 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) p-3">
      <p><time dateTime={group.created_at}>{group.created_at}</time>{' · '}{t('support.restore.reasons.pre_quarantine')}</p>
      {group.tables.map(table => <p key={table}>{`${table}: ${group.row_counts[table]}`}</p>)}
      {group.restore_state === 'quarantined' && group.restorable && <button type="button" className={supportButtonClass} disabled={busy || !recoveryReady || session.snapshot?.critical_op_active}
        onClick={() => setConfirm({ kind: 'group', id: group.group_id })}>{t('support.restore.action')}</button>}
    </div>)}
    {expanded && confirm && <div role="group" aria-label={t('support.restore.confirm')} className="space-y-3 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) p-3">
      <p>{t('support.restore.confirm')}</p>
      {confirm.kind === 'snapshot' && <p>{t('support.restore.preparing')}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={supportSelectedClass} disabled={busy || !recoveryReady || session.snapshot?.critical_op_active} onClick={() => { void restore(confirm); }}>{t('support.restore.action')}</button>
        <button type="button" className={supportButtonClass} disabled={busy} onClick={() => setConfirm(null)}>{t('support.onsite.decline')}</button>
      </div>
    </div>}
    {(failed || recoveryFailed) && <p role="alert">{t('support.code.retry')}</p>}
    {confirmationModal}
  </section>;
}
