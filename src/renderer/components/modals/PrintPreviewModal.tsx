import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Printer, ZoomIn, ZoomOut, Download, X } from 'lucide-react';
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';

interface PrintPreviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    onPrint: () => void;
    onSavePdf?: () => void;
    previewHtml?: string; // HTML string of the receipt
    title: string;
    isPrinting?: boolean;
}

export const PrintPreviewModal: React.FC<PrintPreviewModalProps> = ({
    isOpen,
    onClose,
    onPrint,
    onSavePdf,
    previewHtml,
    title,
    isPrinting = false
}) => {
    const { t } = useTranslation();
    const [zoom, setZoom] = useState(1);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const zoomOutLabel = t('modals.printPreview.zoomOut', { defaultValue: 'Zoom out' });
    const zoomInLabel = t('modals.printPreview.zoomIn', { defaultValue: 'Zoom in' });
    const receiptPreviewLabel = t('modals.printPreview.receiptFrame', { defaultValue: 'Receipt preview' });

    const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 2));
    const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.5));

    // Auto-resize iframe to match content height
    const handleIframeLoad = useCallback(() => {
        const iframe = iframeRef.current;
        if (!iframe?.contentDocument?.body) return;
        // Let the content determine its natural height
        const contentHeight = iframe.contentDocument.body.scrollHeight;
        iframe.style.height = `${contentHeight + 16}px`;
    }, []);

    // Re-trigger resize when zoom changes
    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe?.contentDocument?.body) return;
        const contentHeight = iframe.contentDocument.body.scrollHeight;
        iframe.style.height = `${contentHeight + 16}px`;
    }, [zoom]);

    return (
        <LiquidGlassModal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            size="lg"
            className="!max-w-2xl h-[90vh] flex flex-col"
        >
            <div className="flex flex-col h-full gap-4">
                {/* Toolbar */}
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/24 p-2 backdrop-blur-xl">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleZoomOut}
                            aria-label={zoomOutLabel}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white/80 transition-transform duration-150 active:scale-95 active:bg-white/18"
                        >
                            <ZoomOut className="w-5 h-5" />
                        </button>
                        <span className="w-14 text-center font-mono text-sm font-semibold tabular-nums text-white/68">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            type="button"
                            onClick={handleZoomIn}
                            aria-label={zoomInLabel}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white/80 transition-transform duration-150 active:scale-95 active:bg-white/18"
                        >
                            <ZoomIn className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        {onSavePdf && (
                            <POSGlassButton
                                size="default"
                                variant="secondary"
                                onClick={onSavePdf}
                                aria-label={t('common.actions.downloadPdf', 'Download PDF')}
                                icon={<Download className="w-4 h-4" />}
                            >
                                PDF
                            </POSGlassButton>
                        )}
                    </div>
                </div>

                {/* Preview Area - Simulated 80mm Receipt */}
                <div className="relative flex flex-1 justify-center overflow-auto rounded-3xl border border-white/10 bg-black/42 p-8 scrollbar-hide">
                    <div
                        className="transition-transform origin-top duration-200 ease-out"
                        style={{
                            transform: `scale(${zoom})`,
                        }}
                    >
                        {previewHtml ? (
                            <iframe
                                ref={iframeRef}
                                srcDoc={previewHtml}
                                sandbox="allow-same-origin"
                                onLoad={handleIframeLoad}
                                style={{
                                    width: '340px',
                                    minHeight: '400px',
                                    border: 'none',
                                    background: 'white',
                                    display: 'block',
                                }}
                                title={receiptPreviewLabel}
                            />
                        ) : (
                            <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl text-zinc-500" style={{ width: '340px', minHeight: '400px', background: 'white' }}>
                                <Printer className="w-8 h-8 text-zinc-300" />
                                <span className="text-xs font-medium">{t('modals.printPreview.previewUnavailable', { defaultValue: 'Preview unavailable' })}</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Action Footer */}
                <div className="flex justify-between items-center pt-4 border-t border-white/10 mt-auto">
                    <span className="text-sm text-white/40">
                        {t('modals.printPreview.defaultPrinter', { defaultValue: 'Default receipt printer' })}
                    </span>
                    <div className="flex gap-3">
                        <POSGlassButton variant="secondary" onClick={onClose}>
                            {t('common.actions.cancel')}
                        </POSGlassButton>
                        <POSGlassButton
                            variant="primary"
                            onClick={onPrint}
                            icon={<Printer className="w-4 h-4" />}
                            loading={isPrinting}
                        >
                            {t('common.actions.print')}
                        </POSGlassButton>
                    </div>
                </div>
            </div>
        </LiquidGlassModal>
    );
};
