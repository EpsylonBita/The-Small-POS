import React, { useState } from 'react';
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components';
import type { UpdateInfo } from 'electron-updater';
import { AlertTriangle } from 'lucide-react';

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
    const version = updateInfo?.version || 'New Version';

    return (
        <LiquidGlassModal
            isOpen={isOpen}
            onClose={onInstallOnRestart}
            title="Update Ready to Install"
            size="md"
        >
            <div className="space-y-6 text-center">
                <div className="flex justify-center mb-4">
                    <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center text-green-400">
                        <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                </div>

                <h3 className="text-xl font-bold text-white">Version {version} is ready!</h3>

                <p className="text-gray-300">
                    The update has been downloaded successfully.
                    You can install it now (requires restart) or it will be installed automatically the next time you restart the app.
                </p>

                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-sm text-yellow-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 text-yellow-300" />
                    <span>Note: The application will restart immediately if you choose "Install Now".</span>
                </div>

                <div className="flex flex-col gap-3 pt-4">
                    <POSGlassButton
                        variant="success"
                        onClick={onInstallNow}
                        size="large"
                        fullWidth
                        className="font-bold"
                    >
                        Restart & Install Now
                    </POSGlassButton>

                    <POSGlassButton
                        variant="secondary"
                        onClick={onInstallOnRestart}
                        fullWidth
                    >
                        Install on Next Restart
                    </POSGlassButton>
                </div>
            </div>
        </LiquidGlassModal>
    );
};
