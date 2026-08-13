/**
 * Scan settings — the one place a terminal's capture sources are managed.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**. Requirements R1.3, R1.4, R2.1-R2.6, R3.1, R3.9, R12.5, R14.4,
 * R15.5.
 *
 * Two add flows, each five steps or fewer, each ending in something the user
 * can *see* working:
 *
 * - **Scanner**: pick from the list this terminal can see → one test page,
 *   shown as an image → name it → save (R2.1-R2.3). An empty list is not an
 *   error; it points at the scan folder, which is the zero-driver path (R2.4).
 * - **Scan folder**: pick the folder → save it, which is what starts it being
 *   watched → "press Scan on your machine now", and the arrival of a real file
 *   is the confirmation (R3.1, R3.9).
 *
 * Sources live in `local_settings` category `capture`, so they belong to this
 * terminal and to nothing else (R14.4). Forgetting one removes the source and
 * touches no captured document (R2.6) — captures outlive the device that made
 * them, which is the whole point of keeping the evidence.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle,
  FolderOpen,
  Loader2,
  Plus,
  Printer,
  RefreshCw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { offEvent, onEvent } from '../../../lib';
import { renderModalPortal } from '../../utils/render-modal-portal';
import {
  getCaptureTestPreview,
  listScanners,
  loadCaptureSources,
  loadDefaultCaptureSourceId,
  saveCaptureSources,
  testScanner,
  type ScannerDevice,
} from '../../services/capture-client';
import { deviceKey, sourceKindKey, sourceStatusKey } from '../../utils/capture-review';
import type { CaptureSourceConfig } from '../../types/supplier-capture';

/** Live status of one source, as reported by the watched-folder engine. */
type SourceLiveStatus = 'ready' | 'unavailable' | 'watching';

type Step =
  | { kind: 'list' }
  | { kind: 'pick_scanner' }
  | { kind: 'test_scanner'; device: ScannerDevice }
  | { kind: 'name_scanner'; device: ScannerDevice }
  | { kind: 'folder_test'; source: CaptureSourceConfig };

interface CaptureScanSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called whenever the saved source list changes, so callers can re-read it. */
  onSourcesChanged?: (sources: CaptureSourceConfig[], defaultSourceId: string | null) => void;
}

function newSourceId(): string {
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Last path segment, which is what a user recognises a folder by. */
export function folderDisplayName(folderPath: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || trimmed || 'Scan folder';
}

export const CaptureScanSettingsModal: React.FC<CaptureScanSettingsModalProps> = ({
  isOpen,
  onClose,
  onSourcesChanged,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const [sources, setSources] = useState<CaptureSourceConfig[]>([]);
  const [defaultSourceId, setDefaultSourceId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<Record<string, SourceLiveStatus>>({});
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [devices, setDevices] = useState<ScannerDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [testImage, setTestImage] = useState<string | null>(null);
  const [friendlyName, setFriendlyName] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [folderArrived, setFolderArrived] = useState(false);
  const [confirmForgetId, setConfirmForgetId] = useState<string | null>(null);

  const panelClass = isDark
    ? 'bg-zinc-950 border-zinc-800 text-white'
    : 'bg-white border-gray-200 text-gray-950';
  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const fieldClass = isDark
    ? 'bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-500'
    : 'bg-white border-gray-200 text-gray-950 placeholder:text-gray-400';
  const cardClass = isDark
    ? 'border-zinc-800 bg-zinc-900/70'
    : 'border-gray-200 bg-gray-50';
  const secondaryButtonClass = isDark
    ? 'border-zinc-800 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-800 active:bg-gray-100';
  const primaryButtonClass = isDark
    ? 'border-yellow-400/70 text-white active:bg-yellow-400/10'
    : 'border-yellow-400 text-gray-950 active:bg-yellow-50';

  const refreshSources = useCallback(async () => {
    const [loaded, storedDefault] = await Promise.all([
      loadCaptureSources(),
      loadDefaultCaptureSourceId(),
    ]);
    // Functional updates with an identity check: the polling-free reload still
    // runs on every open, and replacing an equal array would re-render every
    // row and restart the status chips for nothing.
    setSources((current) =>
      JSON.stringify(current) === JSON.stringify(loaded) ? current : loaded,
    );
    setDefaultSourceId((current) => (current === storedDefault ? current : storedDefault));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refreshSources();
  }, [isOpen, refreshSources]);

  // Reset the flow whenever the modal closes, so reopening never resumes a
  // half-finished add the user walked away from.
  useEffect(() => {
    if (isOpen) return;
    setStep({ kind: 'list' });
    setProblem(null);
    setTestImage(null);
    setFolderArrived(false);
    setConfirmForgetId(null);
  }, [isOpen]);

  // Live source status from the watched-folder engine (R1.4). Only real
  // changes are written: an unchanged status must not re-render the list.
  useEffect(() => {
    if (!isOpen) return;

    const handleSourceStatus = (payload: {
      sourceId?: string;
      status?: string;
    }) => {
      const sourceId = payload?.sourceId;
      const status = payload?.status;
      if (!sourceId || (status !== 'ready' && status !== 'unavailable' && status !== 'watching')) {
        return;
      }
      setLiveStatus((current) =>
        current[sourceId] === status ? current : { ...current, [sourceId]: status },
      );
    };

    onEvent('capture:source-status', handleSourceStatus);
    return () => offEvent('capture:source-status', handleSourceStatus);
  }, [isOpen]);

  // Guided folder test: the arrival of a real file is the confirmation (R3.9).
  useEffect(() => {
    if (!isOpen || step.kind !== 'folder_test') return;

    const handleArrived = () => setFolderArrived(true);
    onEvent('capture:document-arrived', handleArrived);
    return () => offEvent('capture:document-arrived', handleArrived);
  }, [isOpen, step]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== dialogRef.current) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const persist = useCallback(
    async (nextSources: CaptureSourceConfig[], nextDefault: string | null) => {
      await saveCaptureSources(nextSources, nextDefault);
      const resolved = nextSources.some((source) => source.id === nextDefault)
        ? nextDefault
        : (nextSources[0]?.id ?? null);
      const normalized = nextSources.map((source) => ({
        ...source,
        isDefault: source.id === resolved,
      }));
      setSources(normalized);
      setDefaultSourceId(resolved);
      onSourcesChanged?.(normalized, resolved);
    },
    [onSourcesChanged],
  );

  const startScannerFlow = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    setStep({ kind: 'pick_scanner' });
    try {
      const outcome = await listScanners();
      if (!outcome.ok) {
        setDevices([]);
        setProblem(t(deviceKey(outcome.code), t('suppliers.capture.device.device_error', 'The scanner did not answer. Check it is on and connected.')));
        return;
      }
      setDevices(outcome.devices);
    } finally {
      setBusy(false);
    }
  }, [t]);

  const runTestScan = useCallback(
    async (device: ScannerDevice) => {
      setBusy(true);
      setProblem(null);
      setTestImage(null);
      setStep({ kind: 'test_scanner', device });
      try {
        const outcome = await testScanner(device.deviceId);
        if (!outcome.ok) {
          setProblem(t(deviceKey(outcome.code), t('suppliers.capture.device.device_error', 'The scanner did not answer. Check it is on and connected.')));
          return;
        }
        setTestImage(await getCaptureTestPreview(outcome.path));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const saveScanner = useCallback(
    async (device: ScannerDevice) => {
      const id = newSourceId();
      const next: CaptureSourceConfig = {
        id,
        kind: 'connected_scanner',
        name: friendlyName.trim() || device.name,
        isDefault: makeDefault || sources.length === 0,
        deviceId: device.deviceId,
      };
      await persist([...sources, next], next.isDefault ? id : defaultSourceId);
      toast.success(t('suppliers.capture.settings.saved', 'Saved. You can scan from here now.'));
      setStep({ kind: 'list' });
      setTestImage(null);
      setFriendlyName('');
    },
    [defaultSourceId, friendlyName, makeDefault, persist, sources, t],
  );

  const addWatchedFolder = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      const folderPath = typeof picked === 'string' ? picked : null;
      if (!folderPath) return;

      const id = newSourceId();
      const next: CaptureSourceConfig = {
        id,
        kind: 'watched_folder',
        name: folderDisplayName(folderPath),
        isDefault: sources.length === 0,
        folderPath,
        housekeeping: 'none',
      };
      // Saved before the guided test on purpose: saving is what starts the
      // folder being watched, and the test needs a live watcher to notice the
      // file the user is about to make (R3.9).
      await persist([...sources, next], next.isDefault ? id : defaultSourceId);
      setFolderArrived(false);
      setStep({ kind: 'folder_test', source: next });
    } catch (error) {
      console.error('[capture] folder pick failed:', error);
      setProblem(
        t(
          'suppliers.capture.settings.folderPickFailed',
          'Could not open the folder picker. Try again.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [defaultSourceId, persist, sources, t]);

  const forgetSource = useCallback(
    async (sourceId: string) => {
      const remaining = sources.filter((source) => source.id !== sourceId);
      await persist(remaining, defaultSourceId === sourceId ? null : defaultSourceId);
      setConfirmForgetId(null);
      toast.success(
        t('suppliers.capture.settings.forgotten', 'Removed. Your scanned invoices are untouched.'),
      );
    },
    [defaultSourceId, persist, sources, t],
  );

  const makeSourceDefault = useCallback(
    async (sourceId: string) => {
      await persist(sources, sourceId);
    },
    [persist, sources],
  );

  const statusOf = useCallback(
    (source: CaptureSourceConfig): SourceLiveStatus => {
      const live = liveStatus[source.id];
      if (live) return live;
      return source.kind === 'watched_folder' ? 'watching' : 'ready';
    },
    [liveStatus],
  );

  const emptyDiscovery = useMemo(
    () => step.kind === 'pick_scanner' && !busy && devices.length === 0 && !problem,
    [busy, devices.length, problem, step],
  );

  if (!isOpen) return null;

  const renderList = () => (
    <div className="space-y-4">
      {sources.length === 0 ? (
        <div className={`rounded-2xl border p-4 text-sm ${cardClass}`}>
          <p className="font-semibold">
            {t('suppliers.capture.settings.emptyTitle', 'No scanner set up yet')}
          </p>
          <p className={`mt-1 ${subtleClass}`}>
            {t(
              'suppliers.capture.settings.emptyDescription',
              'Add the scanner sitting next to this till, or point us at the folder your machine saves scans into.',
            )}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {sources.map((source) => {
            const status = statusOf(source);
            const isDefault = source.id === defaultSourceId;
            return (
              <li key={source.id} className={`rounded-2xl border p-3 ${cardClass}`}>
                <div className="flex flex-wrap items-center gap-3">
                  {source.kind === 'watched_folder' ? (
                    <FolderOpen className="h-5 w-5 shrink-0 text-amber-500" />
                  ) : (
                    <Printer className="h-5 w-5 shrink-0 text-amber-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{source.name}</p>
                    <p className={`truncate text-xs ${subtleClass}`}>
                      {t(sourceKindKey(source.kind), source.kind)}
                      {source.folderPath ? ` · ${source.folderPath}` : ''}
                    </p>
                  </div>
                  <span
                    data-testid={`capture-source-status-${source.id}`}
                    className={`shrink-0 rounded-2xl border px-2 py-1 text-xs font-semibold ${
                      status === 'unavailable'
                        ? isDark
                          ? 'border-red-900 text-red-200'
                          : 'border-red-200 text-red-700'
                        : isDark
                          ? 'border-emerald-900 text-emerald-200'
                          : 'border-emerald-200 text-emerald-700'
                    }`}
                  >
                    {t(sourceStatusKey(status), status)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void makeSourceDefault(source.id)}
                    aria-label={t('suppliers.capture.settings.makeDefault', 'Use this one by default')}
                    className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
                      isDefault ? primaryButtonClass : secondaryButtonClass
                    }`}
                  >
                    <Star className={`h-4 w-4 ${isDefault ? 'text-amber-500' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmForgetId(source.id)}
                    aria-label={t('suppliers.capture.settings.forget', 'Remove')}
                    className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {confirmForgetId === source.id && (
                  <div className={`mt-3 rounded-2xl border p-3 text-sm ${cardClass}`}>
                    <p>
                      {t(
                        'suppliers.capture.settings.forgetConfirm',
                        'Remove this from the till? Invoices you already scanned stay exactly where they are.',
                      )}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void forgetSource(source.id)}
                        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                      >
                        {t('suppliers.capture.settings.forget', 'Remove')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmForgetId(null)}
                        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${secondaryButtonClass}`}
                      >
                        {t('common.cancel', 'Cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => void startScannerFlow()}
          className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold ${primaryButtonClass}`}
        >
          <Printer className="h-4 w-4" />
          {t('suppliers.capture.settings.addScanner', 'Add a scanner')}
        </button>
        <button
          type="button"
          onClick={() => void addWatchedFolder()}
          disabled={busy}
          className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold ${secondaryButtonClass}`}
        >
          <FolderOpen className="h-4 w-4" />
          {t('suppliers.capture.settings.addFolder', 'Watch a scan folder')}
        </button>
      </div>
    </div>
  );

  const renderPickScanner = () => (
    <div className="space-y-4">
      <p className={`text-sm ${subtleClass}`}>
        {t('suppliers.capture.settings.pickScanner', 'Pick the machine you want to scan from.')}
      </p>

      {busy && (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('suppliers.capture.settings.looking', 'Looking for machines…')}
        </div>
      )}

      {devices.map((device) => (
        <button
          key={device.deviceId}
          type="button"
          onClick={() => void runTestScan(device)}
          className={`flex w-full min-h-10 items-center gap-3 rounded-2xl border p-3 text-left ${cardClass}`}
        >
          <Printer className="h-5 w-5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate font-semibold">{device.name}</span>
          <Plus className="h-4 w-4 shrink-0" />
        </button>
      ))}

      {emptyDiscovery && (
        <div className={`rounded-2xl border p-4 text-sm ${cardClass}`}>
          <p className="font-semibold">
            {t('suppliers.capture.settings.noDevices', 'We could not find a scanner here.')}
          </p>
          <p className={`mt-1 ${subtleClass}`}>
            {t(
              'suppliers.capture.settings.noDevicesHint',
              'No problem — most machines can save scans straight into a folder. Point us at that folder instead.',
            )}
          </p>
          <button
            type="button"
            onClick={() => void addWatchedFolder()}
            className={`mt-3 inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
          >
            <FolderOpen className="h-4 w-4" />
            {t('suppliers.capture.settings.addFolder', 'Watch a scan folder')}
          </button>
        </div>
      )}
    </div>
  );

  const renderTestScanner = (device: ScannerDevice) => (
    <div className="space-y-4">
      <p className={`text-sm ${subtleClass}`}>
        {t('suppliers.capture.settings.testing', 'We asked it for one test page. Here it is:')}
      </p>

      {busy && (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('suppliers.capture.settings.testInProgress', 'Scanning a test page…')}
        </div>
      )}

      {testImage && (
        <img
          src={testImage}
          alt={t('suppliers.capture.settings.testImageAlt', 'Test page')}
          className={`max-h-64 w-full rounded-2xl border object-contain ${cardClass}`}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !testImage}
          onClick={() => {
            setFriendlyName(device.name);
            setStep({ kind: 'name_scanner', device });
          }}
          className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
        >
          <Check className="h-4 w-4" />
          {t('suppliers.capture.settings.testLooksRight', 'That looks right')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void runTestScan(device)}
          className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${secondaryButtonClass}`}
        >
          <RefreshCw className="h-4 w-4" />
          {t('suppliers.capture.settings.testAgain', 'Try again')}
        </button>
      </div>
    </div>
  );

  const renderNameScanner = (device: ScannerDevice) => (
    <div className="space-y-4">
      <label className="block text-sm font-semibold" htmlFor={`${titleId}-name`}>
        {t('suppliers.capture.settings.nameLabel', 'What should we call it?')}
      </label>
      <input
        id={`${titleId}-name`}
        value={friendlyName}
        onChange={(event) => setFriendlyName(event.target.value)}
        placeholder={device.name}
        className={`h-10 w-full rounded-2xl border px-3 text-sm outline-none ${fieldClass}`}
      />

      <label className="flex min-h-10 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={makeDefault}
          onChange={(event) => setMakeDefault(event.target.checked)}
          className="h-5 w-5"
        />
        {t('suppliers.capture.settings.useByDefault', 'Use this one when I press Scan invoice')}
      </label>

      <button
        type="button"
        onClick={() => void saveScanner(device)}
        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
      >
        <Check className="h-4 w-4" />
        {t('suppliers.capture.settings.finish', 'Done')}
      </button>
    </div>
  );

  const renderFolderTest = (source: CaptureSourceConfig) => (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 text-sm ${cardClass}`}>
        <p className="font-semibold">{source.name}</p>
        <p className={`mt-1 break-all ${subtleClass}`}>{source.folderPath}</p>
      </div>

      {folderArrived ? (
        <div className="flex items-center gap-2 text-sm font-semibold">
          <CheckCircle className="h-5 w-5 text-emerald-500" />
          {t('suppliers.capture.settings.folderArrived', 'It worked — your scan came through.')}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t(
            'suppliers.capture.settings.folderWaiting',
            'Now press Scan on your machine. We are watching this folder and will say when it arrives.',
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setStep({ kind: 'list' })}
        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${
          folderArrived ? primaryButtonClass : secondaryButtonClass
        }`}
      >
        <Check className="h-4 w-4" />
        {folderArrived
          ? t('suppliers.capture.settings.finish', 'Done')
          : t('suppliers.capture.settings.finishLater', 'I will test it later')}
      </button>
    </div>
  );

  return renderModalPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border shadow-2xl ${panelClass}`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-inherit p-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-2xl font-bold">
              {t('suppliers.capture.settings.title', 'Scan settings')}
            </h2>
            <p className={`mt-1 text-sm ${subtleClass}`}>
              {t(
                'suppliers.capture.settings.subtitle',
                'Where this till gets scanned invoices from.',
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
          {problem && (
            <div
              className={`mb-4 flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm ${
                isDark ? 'border-red-900 bg-red-950/30 text-red-100' : 'border-red-200 bg-red-50 text-red-700'
              }`}
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{problem}</span>
            </div>
          )}

          {step.kind === 'list' && renderList()}
          {step.kind === 'pick_scanner' && renderPickScanner()}
          {step.kind === 'test_scanner' && renderTestScanner(step.device)}
          {step.kind === 'name_scanner' && renderNameScanner(step.device)}
          {step.kind === 'folder_test' && renderFolderTest(step.source)}
        </div>

        {step.kind !== 'list' && (
          <div className="shrink-0 border-t border-inherit p-4">
            <button
              type="button"
              onClick={() => {
                setStep({ kind: 'list' });
                setProblem(null);
                setTestImage(null);
              }}
              className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${secondaryButtonClass}`}
            >
              {t('suppliers.capture.settings.back', 'Back')}
            </button>
          </div>
        )}
      </div>
    </div>,
  );
};

export default CaptureScanSettingsModal;
