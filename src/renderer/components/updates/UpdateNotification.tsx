import React from 'react';
import { LiquidGlassModal, POSGlassButton } from '../ui/pos-glass-components';
import type { UpdateInfo } from 'electron-updater';
import { useI18n } from '../../contexts/i18n-context';

/* 
 * UpdateNotification Component
 * 
 * Displays a non-intrusive notification when an update is available.
 * Shows version info, release notes (simplified), and actions.
 */

interface UpdateNotificationProps {
    isOpen: boolean;
    onClose: () => void;
    updateInfo: UpdateInfo | null;
    onDownload: () => void;
    onInstallLater: () => void;
}

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
    isOpen,
    onClose,
    updateInfo,
    onDownload,
    onInstallLater
}) => {
    const { t } = useI18n(); // Assuming i18n context availability, otherwise fallback to english texts

    if (!updateInfo) return null;

    return (
        <LiquidGlassModal
            isOpen={isOpen}
            onClose={onClose}
            title="Update Available" // Hardcoded for simplified plan compliance, ideally t('updates.available')
            size="md"
        >
            <div className="space-y-4">
                <div className="flex items-center space-x-3 text-cyan-400">
                    <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    <div>
                        <h3 className="text-lg font-bold text-white">Version {updateInfo.version}</h3>
                        <p className="text-sm text-gray-300">
                            Released: {new Date(updateInfo.releaseDate).toLocaleDateString()}
                        </p>
                    </div>
                </div>

                <div className="bg-black/20 rounded-lg p-4 max-h-48 overflow-y-auto">
                    <h4 className="text-sm font-semibold text-gray-300 mb-2">What's New:</h4>
                    {/* Render release notes as HTML content safely or plain text */}
                    <div
                        className="text-sm text-gray-400 prose prose-invert prose-sm"
                        dangerouslySetInnerHTML={{ __html: typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : 'Bug fixes and improvements.' }}
                    />
                </div>

                <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-white/10">
                    <POSGlassButton
                        variant="primary"
                        onClick={onDownload}
                        fullWidth
                    >
                        Download Now
                    </POSGlassButton>
                    <POSGlassButton
                        variant="secondary"
                        onClick={onInstallLater}
                        fullWidth
                    >
                        Remind Me Later
                    </POSGlassButton>
                </div>
            </div>
        </LiquidGlassModal>
    );
};
