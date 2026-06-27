import React, { useCallback, useEffect, useState } from 'react';
import { PauseCircle, PlayCircle, RefreshCw, Printer, XCircle, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { getBridge } from '../../../lib';

type PrintJob = {
  id: string;
  entityType: string;
  entityId: string;
  printerProfileId?: string | null;
  status: string;
  createdAt?: string;
  warningMessage?: string | null;
  lastError?: string | null;
};

type PrintQueueResponse = {
  success?: boolean;
  jobs?: PrintJob[];
  queuePaused?: boolean;
  pausedPrinterProfileIds?: string[];
  error?: string;
};

const ACTIVE_JOB_STATUSES = new Set(['pending', 'printing']);
const TECHNICAL_IDENTIFIER_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z0-9_-]{24,})$/i;
const TECHNICAL_IDENTIFIER_IN_TEXT_PATTERN =
  /(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z0-9_-]{24,})/i;

const toTitleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
const normalizeEntityTypeKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'print_job';

const PrintQueuePanel: React.FC = () => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [pausedPrinterProfileIds, setPausedPrinterProfileIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const formatTimestamp = useCallback(
    (value?: string) => {
      if (!value) return t('settings.printQueue.unknown', 'Unknown');
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
    },
    [t],
  );
  const getStatusLabel = useCallback(
    (status: string) =>
      t(`settings.printQueue.status.${status.toLowerCase()}`, {
        defaultValue: status,
      }),
    [t],
  );
  const getJobTypeLabel = useCallback(
    (entityType: string) =>
      t(`settings.printQueue.entityType.${normalizeEntityTypeKey(entityType)}`, {
        defaultValue: toTitleCase(entityType || 'print_job'),
      }),
    [t],
  );
  const getJobReferenceLabel = useCallback(
    (job: PrintJob) => {
      const reference = String(job.entityId || '').trim();
      if (!reference || TECHNICAL_IDENTIFIER_PATTERN.test(reference)) {
        return t('settings.printQueue.localJob', 'Local print job');
      }
      return t('settings.printQueue.reference', {
        reference,
        defaultValue: 'Reference {{reference}}',
      });
    },
    [t],
  );
  const getPrinterLabel = useCallback(
    (printerProfileId?: string | null) =>
      printerProfileId
        ? t('settings.printQueue.configuredPrinter', 'Configured printer')
        : t('settings.printQueue.defaultPrinter', 'Default'),
    [t],
  );
  const getJobIssueLabel = useCallback(
    (job: PrintJob) => {
      if (job.warningMessage) {
        return job.warningMessage;
      }
      const rawError = String(job.lastError || '').trim();
      if (!rawError) {
        return null;
      }
      if (/hardware printer profile|printer profile resolved|profile resolved for entity/i.test(rawError)) {
        return t(
          'settings.printQueue.issue.hardwareProfileMissing',
          'Choose a printer for this job, then retry.',
        );
      }
      if (
        TECHNICAL_IDENTIFIER_IN_TEXT_PATTERN.test(rawError) ||
        /\b(entity|uuid|profile_id|printer_profile|payload|stack)\b/i.test(rawError)
      ) {
        return t(
          'settings.printQueue.issue.needsAttention',
          'This print job needs printer setup before it can print.',
        );
      }
      return rawError;
    },
    [t],
  );

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await bridge.printer.listJobs()) as PrintQueueResponse;
      if (!result?.success) {
        throw new Error(
          result?.error || t('settings.printQueue.loadFailed', 'Failed to load print queue'),
        );
      }
      setJobs(Array.isArray(result.jobs) ? result.jobs : []);
      setQueuePaused(result.queuePaused === true);
      setPausedPrinterProfileIds(
        Array.isArray(result.pausedPrinterProfileIds) ? result.pausedPrinterProfileIds : [],
      );
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to load print queue:', error);
      toast.error(t('settings.printQueue.loadFailed', 'Failed to load print queue'));
    } finally {
      setLoading(false);
    }
  }, [bridge.printer, t]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const togglePause = useCallback(async () => {
    setLoading(true);
    try {
      if (queuePaused) {
        await bridge.printer.resumeQueue();
        toast.success(t('settings.printQueue.resumed', 'Print queue resumed'));
      } else {
        await bridge.printer.pauseQueue();
        toast.success(t('settings.printQueue.paused', 'Print queue paused'));
      }
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to toggle queue pause:', error);
      toast.error(t('settings.printQueue.updateFailed', 'Failed to update print queue'));
      setLoading(false);
    }
  }, [bridge.printer, loadQueue, queuePaused, t]);

  const cancelAllPending = async () => {
    setLoading(true);
    try {
      await bridge.printer.cancelAllJobs({ statuses: ['pending', 'printing'] });
      toast.success(t('settings.printQueue.cancelledAll', 'Cancelled queued print jobs'));
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to cancel queued print jobs:', error);
      toast.error(
        t('settings.printQueue.cancelAllFailed', 'Failed to cancel queued print jobs'),
      );
      setLoading(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    setBusyJobId(jobId);
    try {
      await bridge.printer.cancelJob(jobId);
      toast.success(t('settings.printQueue.cancelled', 'Print job cancelled'));
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to cancel print job:', error);
      toast.error(t('settings.printQueue.cancelFailed', 'Failed to cancel print job'));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    setBusyJobId(jobId);
    try {
      await bridge.printer.retryJob(jobId);
      toast.success(t('settings.printQueue.retried', 'Print job re-queued'));
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to retry print job:', error);
      toast.error(t('settings.printQueue.retryFailed', 'Failed to retry print job'));
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Printer className="h-4 w-4 text-amber-300" />
            <h3 className="text-sm font-semibold liquid-glass-modal-text">
              {t('settings.printQueue.title', 'Print Queue')}
            </h3>
          </div>
          <p className="mt-1 text-xs liquid-glass-modal-text-muted">
            {t(
              'settings.printQueue.helpText',
              'Jobs already sent to the LAN printer cannot be recalled from the device. These controls only stop or retry jobs still queued locally on this POS.',
            )}
          </p>
          {pausedPrinterProfileIds.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-200/90">
              {t('settings.printQueue.pausedProfiles', 'Profile pauses active for configured printers')}
            </p>
          )}
        </div>

        {/* Round 305 follow-up: a deliberate equal-width action cluster -- full-width stacked cards on
            narrow widths (grid-cols-1 w-full), a compact fixed-width column on desktop (md:w-48). Each
            button is w-full so the grid track (not the label) sets the width, keeping all three identical
            in every language instead of the old content-sized wrapping chips. */}
        <div className="grid w-full shrink-0 grid-cols-1 gap-2 md:w-48">
          <button
            onClick={() => void loadQueue()}
            disabled={loading}
            className="inline-flex w-full min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white/80 transition active:bg-white/20 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {t('settings.printQueue.refresh', 'Refresh')}
          </button>
          <button
            onClick={() => void togglePause()}
            disabled={loading}
            className="inline-flex w-full min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 transition active:bg-amber-500/20 disabled:opacity-60"
          >
            {queuePaused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
            {queuePaused
              ? t('settings.printQueue.resume', 'Resume queue')
              : t('settings.printQueue.pause', 'Pause queue')}
          </button>
          <button
            onClick={() => void cancelAllPending()}
            disabled={loading || jobs.every((job) => !ACTIVE_JOB_STATUSES.has(job.status))}
            className="inline-flex w-full min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100 transition active:bg-rose-500/20 disabled:opacity-60"
          >
            <XCircle className="h-4 w-4" />
            {t('settings.printQueue.cancelPending', 'Cancel pending')}
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] gap-3 bg-white/5 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-white/45">
          <span>{t('settings.printQueue.columns.job', 'Job')}</span>
          <span>{t('settings.printQueue.columns.status', 'Status')}</span>
          <span>{t('settings.printQueue.columns.printer', 'Printer')}</span>
          <span>{t('settings.printQueue.columns.action', 'Action')}</span>
        </div>
        <div className="max-h-72 overflow-y-auto scrollbar-hide divide-y divide-white/5">
          {jobs.length === 0 ? (
            <div className="px-3 py-5 text-sm liquid-glass-modal-text-muted">
              {t(
                'settings.printQueue.empty',
                'No local print jobs are queued right now.',
              )}
            </div>
          ) : (
            jobs.slice(-20).reverse().map((job) => {
              const isActive = ACTIVE_JOB_STATUSES.has(job.status);
              const canRetry = job.status === 'failed';
              const issueLabel = getJobIssueLabel(job);
              return (
                <div
                  key={job.id}
                  className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] gap-3 px-3 py-3 text-sm text-white/80"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-white/90">
                      {getJobTypeLabel(job.entityType)}
                    </div>
                    <div className="truncate text-xs text-white/45">{getJobReferenceLabel(job)}</div>
                    <div className="truncate text-[11px] text-white/35">
                      {formatTimestamp(job.createdAt)}
                    </div>
                    {issueLabel && (
                      <div className={`mt-1 truncate text-[11px] ${job.warningMessage ? 'text-amber-200/85' : 'text-rose-200/85'}`}>
                        {issueLabel}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center text-xs uppercase tracking-[0.14em] text-white/60">
                    {getStatusLabel(job.status)}
                  </div>
                  <div className="flex items-center text-xs text-white/55">
                    {getPrinterLabel(job.printerProfileId)}
                  </div>
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <button
                        onClick={() => void handleCancelJob(job.id)}
                        disabled={busyJobId === job.id}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-100 transition active:bg-rose-500/20 disabled:opacity-60"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        {t('settings.printQueue.cancel', 'Cancel')}
                      </button>
                    )}
                    {canRetry && (
                      <button
                        onClick={() => void handleRetryJob(job.id)}
                        disabled={busyJobId === job.id}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-100 transition active:bg-emerald-500/20 disabled:opacity-60"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t('settings.printQueue.retry', 'Retry')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default PrintQueuePanel;
