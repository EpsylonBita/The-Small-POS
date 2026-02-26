import React, { useState } from 'react';
import DOMPurify from 'dompurify';
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

    const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 2));
    const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.5));

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
                <div className="flex items-center justify-between bg-black/20 p-2 rounded-lg border border-white/5">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleZoomOut}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                            title="Zoom Out"
                        >
                            <ZoomOut className="w-4 h-4 text-white/70" />
                        </button>
                        <span className="text-xs font-mono text-white/50 w-12 text-center">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            onClick={handleZoomIn}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                            title="Zoom In"
                        >
                            <ZoomIn className="w-4 h-4 text-white/70" />
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        {onSavePdf && (
                            <POSGlassButton
                                size="default"
                                variant="secondary"
                                onClick={onSavePdf}
                                icon={<Download className="w-4 h-4" />}
                            >
                                PDF
                            </POSGlassButton>
                        )}
                    </div>
                </div>

                {/* Preview Area - Simulated 80mm Receipt */}
                <div className="flex-1 overflow-auto scrollbar-hide bg-black/40 rounded-lg p-8 flex justify-center border border-white/5 relative">
                    <div
                        className="bg-white text-black shadow-xl transition-transform origin-top duration-200 ease-out"
                        style={{
                            width: '80mm', // Standard thermal receipt width
                            minHeight: '100mm',
                            transform: `scale(${zoom})`,
                            padding: '10px' // minimal padding for thermal simulation
                        }}
                    >
                        {previewHtml ? (
                            <div
                                dangerouslySetInnerHTML={{
                                    __html: DOMPurify.sanitize(previewHtml, {
                                        ALLOWED_TAGS: ['div', 'span', 'p', 'br', 'strong', 'em', 'b', 'i', 'table', 'tr', 'td', 'th', 'hr'],
                                        ALLOWED_ATTR: ['class', 'style']
                                    })
                                }}
                                className="receipt-preview-content font-mono text-[10px] leading-tight"
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-400">
                                <Printer className="w-8 h-8 opacity-20" />
                                <span className="text-xs">Preview unavailable</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Action Footer */}
                <div className="flex justify-between items-center pt-4 border-t border-white/10 mt-auto">
                    <span className="text-sm text-white/40">
                        {/* Could add printer selection status here */}
                        Default Stylus Printer
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
