import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Clock3, Download, FolderOpen, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getBridge, type RecoveryPoint } from '../../../lib';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';

interface RecoveryPanelProps {
  className?: string;
  compact?: boolean;
}

const destructiveKinds = new Set<RecoveryPoint['kind']>([
  'pre_factory_reset',
  'pre_emergency_reset',
  'pre_clear_operational_data',
  'pre_restore',
  'pre_migration',
  'quarantined_open_failure',
]);

const formatWhen = (value?: string | null) => {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatBytes = (bytes?: number | null) => {
  const safe = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
};

const kindLabel = (kind: RecoveryPoint['kind']) =>
  kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const VISIBLE_RECOVERY_POINTS = 5;
const RECOVERY_POINT_CARD_HEIGHT = 108;
const RECOVERY_POINT_GAP = 8;
const RECOVERY_PANEL_MAX_HEIGHT =
  VISIBLE_RECOVERY_POINTS * RECOVERY_POINT_CARD_HEIGHT +
  (VISIBLE_RECOVERY_POINTS - 1) * RECOVERY_POINT_GAP;

export function RecoveryPanel({ className = '', compact = false }: RecoveryPanelProps) {
  const { t } = useTranslation();
  const bridge = getBridge();
  const { runWithPrivilegedConfirmation, confirmationModal } =
    usePrivilegedActionConfirmation();
  const [points, setPoints] = useState<RecoveryPoint[]>([]);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastOpenedPath, setLastOpenedPath] = useState<string | null>(null);

  const selectedPoint = useMemo(
    () => points.find((point) => point.id === selectedPointId) ?? null,
    [points, selectedPointId],
  );

  const latestAutomatic = useMemo(
    () => points.find((point) => point.kind === 'scheduled' || point.kind === 'manual') ?? null,
    [points],
  );
  const latestDestructive = useMemo(
    () => points.find((point) => destructiveKinds.has(point.kind)) ?? null,
    [points],
  );

  const loadPoints = async () => {
    setLoading(true);
    try {
      const result = await bridge.recovery.listPoints();
      const nextPoints = result?.points ?? [];
      setPoints(nextPoints);
      setSelectedPointId((current) =>
        current && nextPoints.some((point) => point.id === current)
          ? current
          : nextPoints[0]?.id ?? null,
      );
    } catch (error) {
      console.error('Failed to load recovery points:', error);
      toast.error(
        t('settings.recovery.loadFailed', 'Failed to load local recovery points'),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPoints();
  }, []);

  const handleCreateSnapshot = async () => {
    setBusyAction('snapshot');
    try {
      await bridge.recovery.createSnapshot();
      toast.success(
        t('settings.recovery.snapshotCreated', 'Recovery snapshot created'),
      );
      await loadPoints();
    } catch (error) {
      console.error('Failed to create recovery snapshot:', error);
      toast.error(
        t('settings.recovery.snapshotCreateFailed', 'Failed to create recovery snapshot'),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleExportCurrent = async () => {
    setBusyAction('export-current');
    try {
      const result = await runWithPrivilegedConfirmation({
        scope: 'system_control',
        action: () => bridge.recovery.exportCurrent(),
        title: t('settings.recovery.exportPinTitle', 'Confirm recovery export'),
        subtitle: t(
          'settings.recovery.exportPinSubtitle',
          'Enter the admin PIN to export the local recovery bundle.',
        ),
      });
      if (result?.path) {
        setLastOpenedPath(result.path);
      }
      toast.success(
        t('settings.recovery.exportCreated', 'Recovery export created'),
      );
    } catch (error) {
      console.error('Failed to export current recovery bundle:', error);
      toast.error(
        t('settings.recovery.exportFailed', 'Failed to export recovery bundle'),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleExportPoint = async () => {
    if (!selectedPoint) return;
    setBusyAction('export-point');
    try {
      const result = await runWithPrivilegedConfirmation({
        scope: 'system_control',
        action: () => bridge.recovery.exportPoint(selectedPoint.id),
        title: t('settings.recovery.exportPointPinTitle', 'Confirm recovery export'),
        subtitle: t(
          'settings.recovery.exportPointPinSubtitle',
          'Enter the admin PIN to export the selected recovery point.',
        ),
      });
      if (result?.path) {
        setLastOpenedPath(result.path);
      }
      toast.success(
        t('settings.recovery.exportPointCreated', 'Recovery point export created'),
      );
    } catch (error) {
      console.error('Failed to export recovery point:', error);
      toast.error(
        t('settings.recovery.exportPointFailed', 'Failed to export recovery point'),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestorePoint = async () => {
    if (!selectedPoint) return;
    setBusyAction('restore');
    try {
      await runWithPrivilegedConfirmation({
        scope: 'system_control',
        action: async () => {
          const result = await bridge.recovery.restorePoint(selectedPoint.id);
          await bridge.app.restart();
          return result;
        },
        title: t('settings.recovery.restorePinTitle', 'Confirm restore'),
        subtitle: t(
          'settings.recovery.restorePinSubtitle',
          'Enter the admin PIN to restore the selected recovery point and restart the POS. Any restored pending print jobs will be cancelled instead of replaying automatically.',
        ),
      });
    } catch (error) {
      console.error('Failed to stage recovery restore:', error);
      toast.error(
        t('settings.recovery.restoreFailed', 'Failed to stage recovery restore'),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      const result = await bridge.recovery.openDir(lastOpenedPath ?? selectedPoint?.path ?? undefined);
      if (result?.path) {
        setLastOpenedPath(result.path);
      }
    } catch (error) {
      console.error('Failed to open recovery folder:', error);
      toast.error(
        t('settings.recovery.openFolderFailed', 'Failed to open the recovery folder'),
      );
    }
  };

  return (
    <>
      <div className={className}>
        <div className="rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="font-medium liquid-glass-modal-text">
                {t('settings.recovery.title', 'Local Recovery')}
              </div>
              <div className="text-xs liquid-glass-modal-text-muted">
                {t(
                  'settings.recovery.help',
                  'Keeps local SQLite recovery points and export bundles for up to 7 days.',
                )}
              </div>
              <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
                <div className="rounded-md border liquid-glass-modal-border bg-black/10 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide liquid-glass-modal-text-muted">
                    {t('settings.recovery.latestAutomatic', 'Latest automatic snapshot')}
                  </div>
                  <div className="mt-1 text-sm liquid-glass-modal-text">
                    {latestAutomatic ? formatWhen(latestAutomatic.createdAt) : t('common.none', 'None')}
                  </div>
                </div>
                <div className="rounded-md border liquid-glass-modal-border bg-black/10 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide liquid-glass-modal-text-muted">
                    {t('settings.recovery.latestDestructive', 'Latest protective snapshot')}
                  </div>
                  <div className="mt-1 text-sm liquid-glass-modal-text">
                    {latestDestructive ? formatWhen(latestDestructive.createdAt) : t('common.none', 'None')}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void loadPoints()}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-lg border liquid-glass-modal-border px-3 py-2 text-sm liquid-glass-modal-text hover:bg-white/10 disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('common.actions.refresh', 'Refresh')}
              </button>
              <button
                onClick={handleCreateSnapshot}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-2 rounded-lg border liquid-glass-modal-border px-3 py-2 text-sm liquid-glass-modal-text hover:bg-white/10 disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {t('settings.recovery.createSnapshot', 'Create snapshot')}
              </button>
              <button
                onClick={handleExportCurrent}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-2 rounded-lg border liquid-glass-modal-border px-3 py-2 text-sm liquid-glass-modal-text hover:bg-white/10 disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                {t('settings.recovery.exportCurrent', 'Export current data')}
              </button>
              <button
                onClick={handleOpenFolder}
                className="inline-flex items-center gap-2 rounded-lg border liquid-glass-modal-border px-3 py-2 text-sm liquid-glass-modal-text hover:bg-white/10"
              >
                <FolderOpen className="h-4 w-4" />
                {t('settings.recovery.openFolder', 'Open recovery folder')}
              </button>
            </div>
          </div>
          <div className="mt-3 border-t liquid-glass-modal-border pt-3">
            <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]'}`}>
              <div
                className={`space-y-2 ${points.length > VISIBLE_RECOVERY_POINTS ? 'overflow-y-auto pr-1 scrollbar-hide' : ''}`}
                style={{ maxHeight: `${RECOVERY_PANEL_MAX_HEIGHT}px` }}
              >
                {points.length === 0 ? (
                  <div className="rounded-lg border liquid-glass-modal-border bg-white/5 px-4 py-5 text-sm liquid-glass-modal-text-muted">
                    {t('settings.recovery.noPoints', 'No local recovery points are available yet.')}
                  </div>
                ) : (
                  points.map((point) => {
                    const isSelected = point.id === selectedPointId;
                    return (
                      <button
                        key={point.id}
                        onClick={() => setSelectedPointId(point.id)}
                        className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                          isSelected
                            ? 'border-cyan-400/60 bg-cyan-500/10'
                            : 'liquid-glass-modal-border bg-white/5 hover:bg-white/10'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium liquid-glass-modal-text">
                              {kindLabel(point.kind)}
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-xs liquid-glass-modal-text-muted">
                              <Clock3 className="h-3.5 w-3.5" />
                              {formatWhen(point.createdAt)}
                            </div>
                          </div>
                          <div className="text-xs liquid-glass-modal-text-muted">
                            {formatBytes(point.snapshotSizeBytes)}
                          </div>
                        </div>
                        <div className="mt-2 text-xs liquid-glass-modal-text-muted">
                          {`${point.tableCounts.orders ?? 0} orders • ${point.tableCounts.staff_shifts ?? 0} shifts • ${point.tableCounts.cash_drawer_sessions ?? 0} drawers`}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <div
                className="rounded-lg border liquid-glass-modal-border bg-white/5 px-4 py-4 overflow-y-auto scrollbar-hide"
                style={{ maxHeight: `${RECOVERY_PANEL_MAX_HEIGHT}px` }}
              >
                {selectedPoint ? (
                  <div className="space-y-3">
                    <div>
                      <div className="font-medium liquid-glass-modal-text">
                        {kindLabel(selectedPoint.kind)}
                      </div>
                      <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                        {selectedPoint.id}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-md border liquid-glass-modal-border bg-black/10 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide liquid-glass-modal-text-muted">Orders</div>
                        <div className="mt-1 liquid-glass-modal-text">{selectedPoint.tableCounts.orders ?? 0}</div>
                      </div>
                      <div className="rounded-md border liquid-glass-modal-border bg-black/10 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide liquid-glass-modal-text-muted">Shifts</div>
                        <div className="mt-1 liquid-glass-modal-text">{selectedPoint.tableCounts.staff_shifts ?? 0}</div>
                      </div>
                      <div className="rounded-md border liquid-glass-modal-border bg-black/10 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide liquid-glass-modal-text-muted">Drawers</div>
                        <div className="mt-1 liquid-glass-modal-text">{selectedPoint.tableCounts.cash_drawer_sessions ?? 0}</div>
                      </div>
                      <div className="rounded-md border liquid-glass-modal-border bg-black/10 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide liquid-glass-modal-text-muted">Snapshot</div>
                        <div className="mt-1 liquid-glass-modal-text">{formatBytes(selectedPoint.snapshotSizeBytes)}</div>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs liquid-glass-modal-text-muted">
                      <div>{`Terminal: ${selectedPoint.terminalId || 'Unknown'}`}</div>
                      <div>{`Branch: ${selectedPoint.branchId || 'Unknown'}`}</div>
                      <div>{`Business day: ${selectedPoint.activeReportDate || selectedPoint.latestZReportDate || 'Unknown'}`}</div>
                    </div>

                    {selectedPoint.error ? (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        {selectedPoint.error}
                      </div>
                    ) : null}

                    <div className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
                      Restored print jobs in <code>pending</code> or <code>printing</code> state will
                      be cancelled during recovery so the POS does not replay historical tickets after
                      restart.
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        onClick={handleExportPoint}
                        disabled={!selectedPoint || busyAction !== null}
                        className="inline-flex items-center gap-2 rounded-lg border liquid-glass-modal-border px-3 py-2 text-sm liquid-glass-modal-text hover:bg-white/10 disabled:opacity-60"
                      >
                        <Download className="h-4 w-4" />
                        {t('settings.recovery.exportSelected', 'Export selected')}
                      </button>
                      <button
                        onClick={handleRestorePoint}
                        disabled={!selectedPoint || busyAction !== null}
                        className="inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 hover:bg-amber-500/20 disabled:opacity-60"
                      >
                        <RotateCcw className="h-4 w-4" />
                        {t('settings.recovery.restoreSelected', 'Restore selected')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm liquid-glass-modal-text-muted">
                    {t('settings.recovery.selectPoint', 'Select a recovery point to inspect or restore it.')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {confirmationModal}
    </>
  );
}

export default RecoveryPanel;
