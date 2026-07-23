import React from 'react';
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components';
import type { UpdateInfo } from '../../../lib/update-contracts';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface UpdateReadyModalProps {
    isOpen: boolean;
    updateInfo: UpdateInfo | null;
    onInstallNow: () => void;
    onInstallOnRestart: () => void;
}

export const UpdateReadyModal: React.FC<UpdateReadyModalProps> = ({
    isOpen,
    updateInfo,
    onInstallNow,
    onInstallOnRestart
}) => {
    const { t } = useTranslation();
    const version = updateInfo?.version;

    return (
        <LiquidGlassModal
            isOpen={isOpen}
            onClose={onInstallOnRestart}
            title={t('updates.title.downloaded')}
            size="md"
            className="!max-w-lg"
        >
            <div className="space-y-6 text-center">
                <div className="flex justify-center mb-4">
                    <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center text-green-400">
                        <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                </div>

                <h3 className="text-xl font-bold text-white">
                    {version
                        ? t('updates.downloaded.ready', { version })
                        : t('updates.downloaded.readyGeneric')}
                </h3>

                <p className="text-gray-300">
                    {t('updates.downloaded.description')}
                </p>

                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-2xl p-3 text-sm text-yellow-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 text-yellow-300" />
                    <span>{t('updates.downloaded.warning')}</span>
                </div>

                <div className="flex flex-col gap-3 pt-4">
                    <POSGlassButton
                        variant="success"
                        onClick={onInstallNow}
                        size="large"
                        fullWidth
                        className="font-bold"
                    >
                        {t('updates.actions.installNow')}
                    </POSGlassButton>

                    <POSGlassButton
                        variant="secondary"
                        onClick={onInstallOnRestart}
                        fullWidth
                    >
                        {t('updates.actions.installLater')}
                    </POSGlassButton>
                </div>
            </div>
        </LiquidGlassModal>
    );
};
