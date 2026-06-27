import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Camera, CheckCircle, RefreshCw, ScanLine, X, XCircle } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { useBarcodeScannerContext, useOnBarcodeScan } from '../../contexts/barcode-scanner-context';
import { useHardwareManager } from '../../hooks/useHardwareManager';
import { renderModalPortal } from '../../utils/render-modal-portal';

type ScanSource = 'hardware' | 'camera' | 'manual';

type BarcodeDetectorLike = new (options?: { formats?: string[] }) => {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
};

interface ScanDevicePanelProps {
  open: boolean;
  title: string;
  description: string;
  manualPlaceholder: string;
  onClose: () => void;
  onScan: (code: string, source: ScanSource) => void | Promise<void>;
  includeLoyaltyReader?: boolean;
}

function getBarcodeDetector(): BarcodeDetectorLike | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorLike }).BarcodeDetector || null;
}

export const ScanDevicePanel: React.FC<ScanDevicePanelProps> = ({
  open,
  title,
  description,
  manualPlaceholder,
  onClose,
  onScan,
  includeLoyaltyReader = false,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const { state: scannerState } = useBarcodeScannerContext();
  const hardware = useHardwareManager(open, 5000);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [cameraCount, setCameraCount] = useState(0);
  const [detectingDevices, setDetectingDevices] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanningImage, setScanningImage] = useState(false);

  const panelClass = isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-gray-200 text-gray-950';
  const fieldClass = isDark
    ? 'bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-500'
    : 'bg-white border-gray-200 text-gray-950 placeholder:text-gray-400';
  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const actionClass = isDark
    ? 'border-zinc-700 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-900 active:bg-gray-100';

  const cameraDetectorAvailable = useMemo(() => Boolean(getBarcodeDetector()), []);
  const serialScannerConnected = Boolean(hardware.status?.serialScanner?.connected);
  const loyaltyReaderConnected = Boolean(hardware.status?.loyaltyReader?.connected);
  const scannerReady = serialScannerConnected || scannerState.scanCount > 0 || scannerState.isScanning;
  const canUseCamera = cameraCount > 0 && cameraDetectorAvailable;

  const detectDevices = useCallback(async () => {
    setDetectingDevices(true);
    setCameraError(null);
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setCameraCount(0);
        setCameraError(t('scannerPanel.cameraUnsupported', 'Camera detection is not available on this device.'));
        return;
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameraCount(devices.filter(device => device.kind === 'videoinput').length);
    } catch (error) {
      console.warn('[ScanDevicePanel] Device detection failed:', error);
      setCameraCount(0);
      setCameraError(t('scannerPanel.cameraDetectionFailed', 'Could not check connected cameras.'));
    } finally {
      setDetectingDevices(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    void detectDevices();
    const focusTimer = window.setTimeout(() => manualInputRef.current?.focus(), 50);
    return () => window.clearTimeout(focusTimer);
  }, [detectDevices, open]);

  const submitCode = useCallback(async (code: string, source: ScanSource) => {
    const cleanCode = code.trim();
    if (!cleanCode) return;

    await onScan(cleanCode, source);
    setManualCode('');
  }, [onScan]);

  useOnBarcodeScan((barcode) => {
    if (!open) return;
    void submitCode(barcode, 'hardware');
  }, [open, submitCode]);

  const handleCameraFile = async (file: File) => {
    const Detector = getBarcodeDetector();
    if (!Detector) {
      toast.error(t('scannerPanel.cameraBarcodeUnavailable', 'Barcode detection is not available for this camera on this device.'));
      return;
    }

    setScanningImage(true);
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
      const matches = await detector.detect(bitmap);
      const barcode = matches.find(match => match.rawValue)?.rawValue?.trim();
      bitmap.close();

      if (!barcode) {
        toast.error(t('scannerPanel.noBarcodeFound', 'No barcode was found by the camera.'));
        return;
      }

      await submitCode(barcode, 'camera');
    } catch (error) {
      console.error('[ScanDevicePanel] Camera barcode scan failed:', error);
      toast.error(t('scannerPanel.cameraScanFailed', 'Unable to scan that barcode image.'));
    } finally {
      setScanningImage(false);
    }
  };

  if (!open) return null;

  return renderModalPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`w-full max-w-2xl rounded-2xl border shadow-2xl ${panelClass}`}
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
      >
        <div className={`flex items-start justify-between gap-4 border-b p-5 ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ScanLine className="h-5 w-5 text-amber-400" />
              <h2 className="text-lg font-bold">{title}</h2>
            </div>
            <p className={`mt-1 text-sm ${subtleClass}`}>{description}</p>
          </div>
          <button
            onClick={onClose}
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${actionClass}`}
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <div className={`rounded-2xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{t('scannerPanel.hardwareScanner', 'Barcode scanner')}</p>
                  <p className={`mt-1 text-xs ${subtleClass}`}>
                    {serialScannerConnected
                      ? t('scannerPanel.serialConnected', 'Serial scanner connected')
                      : t('scannerPanel.keyboardReady', 'USB keyboard scanner ready')}
                  </p>
                </div>
                {scannerReady ? (
                  <CheckCircle className="h-6 w-6 text-emerald-400" />
                ) : (
                  <ScanLine className={`h-6 w-6 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
                )}
              </div>
              {scannerState.lastBarcode && (
                <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${isDark ? 'border-zinc-800 bg-black text-zinc-300' : 'border-gray-200 bg-white text-gray-600'}`}>
                  {t('scannerPanel.lastScan', 'Last scan')}: <span className="font-mono font-semibold">{scannerState.lastBarcode}</span>
                </p>
              )}
            </div>

            <div className={`rounded-2xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{t('scannerPanel.camera', 'Camera')}</p>
                  <p className={`mt-1 text-xs ${subtleClass}`}>
                    {detectingDevices
                      ? t('scannerPanel.checkingDevices', 'Checking devices...')
                      : cameraCount > 0
                        ? t('scannerPanel.cameraCount', { count: cameraCount, defaultValue: '{{count}} camera detected' })
                        : cameraError || t('scannerPanel.noCamera', 'No camera detected')}
                  </p>
                </div>
                {canUseCamera ? (
                  <CheckCircle className="h-6 w-6 text-emerald-400" />
                ) : (
                  <XCircle className={`h-6 w-6 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
                )}
              </div>
              {!cameraDetectorAvailable && (
                <p className={`mt-3 text-xs ${subtleClass}`}>
                  {t('scannerPanel.cameraBarcodeUnavailable', 'Barcode detection is not available for this camera on this device.')}
                </p>
              )}
            </div>
          </div>

          {includeLoyaltyReader && (
            <div className={`rounded-2xl border px-4 py-3 text-sm ${isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              {loyaltyReaderConnected
                ? t('scannerPanel.loyaltyReaderConnected', 'Loyalty card reader connected')
                : t('scannerPanel.loyaltyReaderReady', 'Loyalty card reader will listen while this scanner is open')}
            </div>
          )}

          <div className={`rounded-2xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
            <p className="font-semibold">{t('scannerPanel.scanNow', 'Scan now')}</p>
            <p className={`mt-1 text-xs ${subtleClass}`}>
              {t('scannerPanel.scanHelp', 'Scan with a barcode scanner, use the camera, or type the code manually.')}
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                ref={manualInputRef}
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void submitCode(manualCode, 'manual');
                  }
                }}
                className={`min-h-11 min-w-0 flex-1 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                placeholder={manualPlaceholder}
              />
              <button
                onClick={() => void submitCode(manualCode, 'manual')}
                className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold ${actionClass}`}
              >
                <ScanLine className="h-4 w-4" />
                {t('scannerPanel.submit', 'Use code')}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!canUseCamera || scanningImage}
                className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${actionClass}`}
              >
                {scanningImage ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                {t('scannerPanel.cameraScan', 'Camera scan')}
              </button>
              <button
                onClick={() => void detectDevices()}
                disabled={detectingDevices}
                className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold disabled:opacity-50 ${actionClass}`}
              >
                <RefreshCw className={`h-4 w-4 ${detectingDevices ? 'animate-spin' : ''}`} />
                {t('scannerPanel.checkAgain', 'Check devices')}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleCameraFile(file);
                event.currentTarget.value = '';
              }}
            />
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default ScanDevicePanel;
