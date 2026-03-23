import React, { useCallback, useEffect, useState } from 'react';
import { PauseCircle, PlayCircle, RefreshCw, Printer, XCircle, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
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

const formatTimestamp = (value?: string) => {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const PrintQueuePanel: React.FC = () => {
  const bridge = getBridge();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [pausedPrinterProfileIds, setPausedPrinterProfileIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await bridge.printer.listJobs()) as PrintQueueResponse;
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to load print queue');
      }
      setJobs(Array.isArray(result.jobs) ? result.jobs : []);
      setQueuePaused(result.queuePaused === true);
      setPausedPrinterProfileIds(
        Array.isArray(result.pausedPrinterProfileIds) ? result.pausedPrinterProfileIds : [],
      );
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to load print queue:', error);
      toast.error('Failed to load print queue');
    } finally {
      setLoading(false);
    }
  }, [bridge.printer]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const togglePause = async () => {
    setLoading(true);
    try {
      if (queuePaused) {
        await bridge.printer.resumeQueue();
        toast.success('Print queue resumed');
      } else {
        await bridge.printer.pauseQueue();
        toast.success('Print queue paused');
      }
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to toggle queue pause:', error);
      toast.error('Failed to update print queue');
      setLoading(false);
    }
  };

  const cancelAllPending = async () => {
    setLoading(true);
    try {
      await bridge.printer.cancelAllJobs({ statuses: ['pending', 'printing'] });
      toast.success('Cancelled queued print jobs');
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to cancel queued print jobs:', error);
      toast.error('Failed to cancel queued print jobs');
      setLoading(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    setBusyJobId(jobId);
    try {
      await bridge.printer.cancelJob(jobId);
      toast.success('Print job cancelled');
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to cancel print job:', error);
      toast.error('Failed to cancel print job');
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    setBusyJobId(jobId);
    try {
      await bridge.printer.retryJob(jobId);
      toast.success('Print job re-queued');
      await loadQueue();
    } catch (error) {
      console.error('[PrintQueuePanel] Failed to retry print job:', error);
      toast.error('Failed to retry print job');
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className="rounded-xl border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Printer className="h-4 w-4 text-sky-300" />
            <h3 className="text-sm font-semibold liquid-glass-modal-text">Print Queue</h3>
          </div>
          <p className="mt-1 text-xs liquid-glass-modal-text-muted">
            Jobs already sent to the LAN printer cannot be recalled from the device. These controls
            only stop or retry jobs still queued locally on this POS.
          </p>
          {pausedPrinterProfileIds.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-200/90">
              Profile pauses active for: {pausedPrinterProfileIds.join(', ')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void loadQueue()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs text-white/80 hover:bg-white/15 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => void togglePause()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100 hover:bg-sky-500/20 disabled:opacity-60"
          >
            {queuePaused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
            {queuePaused ? 'Resume queue' : 'Pause queue'}
          </button>
          <button
            onClick={() => void cancelAllPending()}
            disabled={loading || jobs.every((job) => !ACTIVE_JOB_STATUSES.has(job.status))}
            className="inline-flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100 hover:bg-rose-500/20 disabled:opacity-60"
          >
            <XCircle className="h-4 w-4" />
            Cancel pending
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-white/10">
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] gap-3 bg-white/5 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-white/45">
          <span>Job</span>
          <span>Status</span>
          <span>Printer</span>
          <span>Action</span>
        </div>
        <div className="max-h-72 overflow-y-auto divide-y divide-white/5">
          {jobs.length === 0 ? (
            <div className="px-3 py-5 text-sm liquid-glass-modal-text-muted">
              No local print jobs are queued right now.
            </div>
          ) : (
            jobs.slice(-20).reverse().map((job) => {
              const isActive = ACTIVE_JOB_STATUSES.has(job.status);
              const canRetry = job.status === 'failed';
              return (
                <div
                  key={job.id}
                  className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] gap-3 px-3 py-3 text-sm text-white/80"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-white/90">
                      {job.entityType.replace(/_/g, ' ')}
                    </div>
                    <div className="truncate text-xs text-white/45">{job.entityId}</div>
                    <div className="truncate text-[11px] text-white/35">
                      {formatTimestamp(job.createdAt)}
                    </div>
                    {job.warningMessage && (
                      <div className="mt-1 truncate text-[11px] text-amber-200/85">
                        {job.warningMessage}
                      </div>
                    )}
                    {job.lastError && !job.warningMessage && (
                      <div className="mt-1 truncate text-[11px] text-rose-200/85">
                        {job.lastError}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center text-xs uppercase tracking-[0.14em] text-white/60">
                    {job.status}
                  </div>
                  <div className="flex items-center text-xs text-white/55">
                    {job.printerProfileId || 'Default'}
                  </div>
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <button
                        onClick={() => void handleCancelJob(job.id)}
                        disabled={busyJobId === job.id}
                        className="inline-flex items-center gap-1 rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-100 hover:bg-rose-500/20 disabled:opacity-60"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Cancel
                      </button>
                    )}
                    {canRetry && (
                      <button
                        onClick={() => void handleRetryJob(job.id)}
                        disabled={busyJobId === job.id}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-60"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry
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
