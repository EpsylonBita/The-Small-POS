import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Scissors, UserX } from 'lucide-react';
import { getBridge, isBrowser } from '../../../../lib';
import { posApiGet } from '../../../utils/api-helpers';
import { LiquidGlassModal } from '../../../components/ui/pos-glass-components';
import type { WalkInStylist } from './salon-sale';

/**
 * The branch staff list of the booking modal (`bridge.staffSchedule.list`),
 * read without a date range: staff only, no shifts. Native keeps the last good
 * answer in its branch cache, so the list also works offline. Ids and names
 * only: no PIN, role or permission leaves this file.
 */
export function stylistsFromStaffPayload(payload: unknown): WalkInStylist[] {
  const staff = (payload as { staff?: unknown } | null)?.staff;
  if (!Array.isArray(staff)) return [];
  const seen = new Set<string>();
  return staff.flatMap((member: any) => {
    const id = String(member?.id ?? '').trim();
    const name = String(member?.name ?? '').trim() ||
      `${member?.firstName ?? member?.first_name ?? ''} ${member?.lastName ?? member?.last_name ?? ''}`.trim();
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name }];
  });
}

interface StylistScope { branchId: string; organizationId: string }

async function loadStylists(branchId: string): Promise<WalkInStylist[]> {
  const result = isBrowser()
    ? await posApiGet<{ staff?: unknown[] }>(`/api/pos/staff-schedule?branch_id=${encodeURIComponent(branchId)}`)
    : await getBridge().staffSchedule.list({ branch_id: branchId });
  return stylistsFromStaffPayload((result as { data?: unknown } | null)?.data ?? null);
}

export function useSalonStylists({ branchId, organizationId }: StylistScope): { stylists: WalkInStylist[]; loading: boolean } {
  // Native owns the durable branch cache. Do not keep an unscoped renderer
  // cache: a terminal can be reconfigured to another organization or branch.
  const scopeKey = JSON.stringify([organizationId, branchId]);
  const [result, setResult] = useState<{ scopeKey: string; stylists: WalkInStylist[]; loading: boolean }>({ scopeKey, stylists: [], loading: true });
  useEffect(() => {
    let disposed = false;
    setResult({ scopeKey, stylists: [], loading: true });
    if (!organizationId || !branchId) return;
    loadStylists(branchId)
      .then(list => {
        if (!disposed) setResult({ scopeKey, stylists: list, loading: false });
      })
      .catch(() => { if (!disposed) setResult({ scopeKey, stylists: [], loading: false }); });
    return () => { disposed = true; };
  }, [branchId, organizationId, scopeKey]);
  return result.scopeKey === scopeKey ? result : { stylists: [], loading: true };
}

interface StylistPickerProps {
  isOpen: boolean;
  serviceName?: string;
  stylists: WalkInStylist[];
  loading?: boolean;
  /** `null` is the explicit "No stylist" choice. */
  onPick: (stylist: WalkInStylist | null) => void;
  /** Cancel: the service is not added. */
  onClose: () => void;
}

const choiceClass =
  'flex min-h-12 w-full items-center gap-3 rounded-xl border border-slate-200/90 bg-white/90 px-3 py-2 text-left font-semibold liquid-glass-modal-text shadow-[0_8px_20px_rgba(15,23,42,0.10)] transition-all active:translate-y-px dark:border-white/10 dark:bg-white/5';

export function StylistPicker({ isOpen, serviceName, stylists, loading = false, onPick, onClose }: StylistPickerProps) {
  const { t } = useTranslation();
  return (
    <LiquidGlassModal isOpen={isOpen} onClose={onClose} size="sm" className="max-w-md!" closeOnBackdrop={false}
      title={t('salonStaff.pickerTitle', 'Who does this service?')}>
      <div className="space-y-2" data-testid="salon-stylist-picker">
        {serviceName && <p className="text-sm liquid-glass-modal-text-muted">{serviceName}</p>}
        {loading && stylists.length === 0 && <p role="status" className="text-sm liquid-glass-modal-text-muted">{t('common.loading', 'Loading...')}</p>}
        {stylists.map(stylist => (
          <button key={stylist.id} type="button" className={choiceClass} onClick={() => onPick(stylist)}>
            <Scissors className="h-5 w-5 shrink-0 text-amber-500" />
            <span className="min-w-0 truncate">{stylist.name}</span>
          </button>
        ))}
        <button type="button" className={choiceClass} onClick={() => onPick(null)}>
          <UserX className="h-5 w-5 shrink-0 liquid-glass-modal-text-muted" />
          <span>{t('salonStaff.noStylist', 'No stylist')}</span>
        </button>
        <button type="button" onClick={onClose}
          className="liquid-glass-modal-button w-full border-slate-200/90 bg-white/90 font-medium liquid-glass-modal-text dark:border-white/10 dark:bg-white/10">
          {t('common.actions.cancel', 'Cancel')}
        </button>
      </div>
    </LiquidGlassModal>
  );
}

/**
 * Asks for the stylist of a walk-in service. With no staff in the branch list
 * the service is added at once without a stylist, as before.
 */
export function useStylistChoice(scope: StylistScope) {
  const { stylists, loading } = useSalonStylists(scope);
  const [pending, setPending] = useState<{ serviceName: string; resolve: (stylist: WalkInStylist | null) => void } | null>(null);
  useEffect(() => { setPending(null); }, [scope.branchId, scope.organizationId]);
  const chooseStylist = useCallback((serviceName: string, onChosen: (stylist: WalkInStylist | null) => void) => {
    if (!loading && stylists.length === 0) { onChosen(null); return; }
    setPending({ serviceName, resolve: onChosen });
  }, [loading, stylists.length]);
  const stylistPicker = (
    <StylistPicker isOpen={pending !== null} serviceName={pending?.serviceName} stylists={stylists} loading={loading}
      onPick={stylist => { const request = pending; setPending(null); request?.resolve(stylist); }}
      onClose={() => setPending(null)} />
  );
  return { chooseStylist, stylistPicker };
}
