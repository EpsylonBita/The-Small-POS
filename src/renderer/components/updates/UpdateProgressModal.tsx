import React from 'react';
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components';
import type { ProgressInfo } from '../../../lib/update-contracts';
import { useI18n } from '../../contexts/i18n-context';

interface UpdateProgressModalProps {
    isOpen: boolean;
    progress: ProgressInfo | undefined;
    onCancel: () => void;
}

export const UpdateProgressModal: React.FC<UpdateProgressModalProps> = ({
    isOpen,
    progress,
    onCancel
}) => {
    const { t } = useI18n();
    const percent = progress?.percent || 0;
    const speed = (progress?.bytesPerSecond || 0) / 1024 / 1024; // MB/s
    const transferred = (progress?.transferred || 0) / 1024 / 1024; // MB
    const total = (progress?.total || 0) / 1024 / 1024; // MB

    return (
        <LiquidGlassModal
            isOpen={isOpen}
            onClose={() => { }} // Prevent closing via backdrop/esc during download
            title={t('updates.title.downloading')}
            size="md"
            className="!max-w-lg"
            closeOnBackdrop={false}
            closeOnEscape={false}
        >
            <div className="space-y-6 text-center py-4">
                {/* Progress Circle or Bar */}
                <div className="relative w-full h-4 bg-gray-700 rounded-full overflow-hidden">
                    <div
                        className="absolute top-0 left-0 h-full bg-cyan-500 transition-all duration-300 ease-out"
                        style={{ width: `${percent}%` }}
                    />
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-white/5 p-3 rounded-lg">
                        <span className="block text-gray-400">{t('updates.downloading.progress')}</span>
                        <span className="block text-xl font-bold text-white">{percent.toFixed(0)}%</span>
                    </div>
                    <div className="bg-white/5 p-3 rounded-lg">
                        <span className="block text-gray-400">{t('updates.downloading.speed')}</span>
                        <span className="block text-xl font-bold text-white">{speed.toFixed(1)} MB/s</span>
                    </div>
                    <div className="bg-white/5 p-3 rounded-lg">
                        <span className="block text-gray-400">{t('updates.downloading.downloaded')}</span>
                        <span className="block text-xl font-bold text-white">{transferred.toFixed(1)} / {total.toFixed(1)} MB</span>
                    </div>
                </div>

                <div className="pt-2">
                    <POSGlassButton
                        variant="secondary"
                        onClick={onCancel}
                        className="px-8"
                    >
                        {t('updates.actions.cancel')}
                    </POSGlassButton>
                </div>
            </div>
        </LiquidGlassModal>
    );
};
