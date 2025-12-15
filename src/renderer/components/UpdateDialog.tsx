import React from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal, POSGlassButton } from './ui/pos-glass-components';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';

/**
 * UpdateDialog Component
 * 
 * A unified dialog for displaying all update states:
 * - checking: Checking for updates
 * - available: Update available with version info and release notes
 * - downloading: Download in progress with progress bar
 * - downloaded: Update ready to install
 * - error: Error occurred during update process
 * - up-to-date: Application is up to date
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

export type UpdateStatus = 
  | 'idle'
  | 'checking' 
  | 'available' 
  | 'not-available' 
  | 'downloading' 
  | 'downloaded' 
  | 'error';

export interface UpdateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  status: UpdateStatus;
  updateInfo?: UpdateInfo | null;
  progress?: ProgressInfo;
  error?: string | null;
  currentVersion?: string;
  onDownload: () => void;
  onCancel: () => void;
  onInstall: () => void;
  onRetry: () => void;
}

export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  isOpen,
  onClose,
  status,
  updateInfo,
  progress,
  error,
  currentVersion,
  onDownload,
  onCancel,
  onInstall,
  onRetry,
}) => {
  const { t } = useTranslation();

  const getTitle = (): string => {
    switch (status) {
      case 'checking':
        return t('updates.title.checking');
      case 'available':
        return t('updates.title.available');
      case 'downloading':
        return t('updates.title.downloading');
      case 'downloaded':
        return t('updates.title.downloaded');
      case 'error':
        return t('updates.title.error');
      case 'not-available':
      case 'idle':
      default:
        return t('updates.title.upToDate');
    }
  };

  const renderContent = () => {
    switch (status) {
      case 'checking':
        return <CheckingState />;
      case 'available':
        return (
          <AvailableState 
            updateInfo={updateInfo} 
            onDownload={onDownload}
            onClose={onClose}
            currentVersion={currentVersion}
          />
        );
      case 'downloading':
        return (
          <DownloadingState 
            progress={progress} 
            onCancel={onCancel}
          />
        );
      case 'downloaded':
        return (
          <DownloadedState 
            updateInfo={updateInfo}
            onInstall={onInstall}
            onClose={onClose}
          />
        );
      case 'error':
        return (
          <ErrorState 
            error={error} 
            onRetry={onRetry}
            onClose={onClose}
          />
        );
      case 'not-available':
      case 'idle':
      default:
        return <UpToDateState onClose={onClose} currentVersion={currentVersion} />;
    }
  };

  // Prevent closing during download
  const canClose = status !== 'downloading';

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={canClose ? onClose : () => {}}
      title={getTitle()}
      size="md"
      closeOnBackdrop={canClose}
      closeOnEscape={canClose}
    >
      {renderContent()}
    </LiquidGlassModal>
  );
};

// Checking state - spinner while checking for updates
const CheckingState: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-8 space-y-4">
      <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-gray-300 text-center">
        {t('updates.checking')}
      </p>
    </div>
  );
};

// Available state - shows version info and release notes
interface AvailableStateProps {
  updateInfo?: UpdateInfo | null;
  onDownload: () => void;
  onClose: () => void;
  currentVersion?: string;
}

const AvailableState: React.FC<AvailableStateProps> = ({ 
  updateInfo, 
  onDownload,
  onClose,
  currentVersion
}) => {
  const { t } = useTranslation();
  const releaseNotes = getReleaseNotesHtml(updateInfo?.releaseNotes);
  
  return (
    <div className="space-y-4">
      {/* Version info header */}
      <div className="flex items-center space-x-3 text-cyan-400">
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={2} 
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" 
          />
        </svg>
        <div>
          <h3 className="text-lg font-bold text-white">
            {t('updates.available.version', { version: updateInfo?.version || 'Unknown' })}
          </h3>
          {currentVersion && (
            <p className="text-sm text-gray-400">
              {t('updates.available.currentVersion', { current: currentVersion, new: updateInfo?.version })}
            </p>
          )}
          {updateInfo?.releaseDate && (
            <p className="text-sm text-gray-300">
              {t('updates.available.released', { date: new Date(updateInfo.releaseDate).toLocaleDateString() })}
            </p>
          )}
        </div>
      </div>

      {/* Release notes */}
      {releaseNotes && (
        <div className="bg-black/20 rounded-lg p-4 max-h-48 overflow-y-auto">
          <h4 className="text-sm font-semibold text-gray-300 mb-2">{t('updates.available.whatsNew')}</h4>
          <div
            className="text-sm text-gray-400 prose prose-invert prose-sm"
            dangerouslySetInnerHTML={{ __html: releaseNotes }}
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-white/10">
        <POSGlassButton
          variant="primary"
          onClick={onDownload}
          fullWidth
        >
          {t('updates.actions.download')}
        </POSGlassButton>
        <POSGlassButton
          variant="secondary"
          onClick={onClose}
          fullWidth
        >
          {t('updates.actions.later')}
        </POSGlassButton>
      </div>
    </div>
  );
};


// Downloading state - shows progress bar
interface DownloadingStateProps {
  progress?: ProgressInfo;
  onCancel: () => void;
}

const DownloadingState: React.FC<DownloadingStateProps> = ({ 
  progress, 
  onCancel 
}) => {
  const { t } = useTranslation();
  const percent = progress?.percent || 0;
  const speed = (progress?.bytesPerSecond || 0) / 1024 / 1024; // MB/s
  const transferred = (progress?.transferred || 0) / 1024 / 1024; // MB
  const total = (progress?.total || 0) / 1024 / 1024; // MB

  return (
    <div className="space-y-6 text-center py-4">
      {/* Progress bar */}
      <div className="relative w-full h-4 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="absolute top-0 left-0 h-full bg-cyan-500 transition-all duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="bg-white/5 p-3 rounded-lg">
          <span className="block text-gray-400">{t('updates.downloading.progress')}</span>
          <span className="block text-xl font-bold text-white">
            {percent.toFixed(0)}%
          </span>
        </div>
        <div className="bg-white/5 p-3 rounded-lg">
          <span className="block text-gray-400">{t('updates.downloading.speed')}</span>
          <span className="block text-xl font-bold text-white">
            {speed.toFixed(1)} MB/s
          </span>
        </div>
        <div className="col-span-2 bg-white/5 p-3 rounded-lg">
          <span className="block text-gray-400">{t('updates.downloading.downloaded')}</span>
          <span className="block text-xl font-bold text-white">
            {transferred.toFixed(1)} / {total.toFixed(1)} MB
          </span>
        </div>
      </div>

      {/* Cancel button */}
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
  );
};

// Downloaded state - ready to install
interface DownloadedStateProps {
  updateInfo?: UpdateInfo | null;
  onInstall: () => void;
  onClose: () => void;
}

const DownloadedState: React.FC<DownloadedStateProps> = ({ 
  updateInfo,
  onInstall,
  onClose 
}) => {
  const { t } = useTranslation();
  const version = updateInfo?.version || 'New Version';

  const handleInstall = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[UpdateDialog] Install button clicked - calling onInstall');
    try {
      onInstall();
      console.log('[UpdateDialog] onInstall called successfully');
    } catch (err) {
      console.error('[UpdateDialog] Error calling onInstall:', err);
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[UpdateDialog] Install Later button clicked - calling onClose');
    onClose();
  };

  return (
    <div className="space-y-6 text-center">
      {/* Success icon */}
      <div className="flex justify-center mb-4">
        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center text-green-400">
          <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M5 13l4 4L19 7" 
            />
          </svg>
        </div>
      </div>

      <h3 className="text-xl font-bold text-white">{t('updates.downloaded.ready', { version })}</h3>

      <p className="text-gray-300">
        {t('updates.downloaded.description')}
      </p>

      {/* Warning note */}
      <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-sm text-yellow-200">
        {t('updates.downloaded.warning')}
      </div>

      {/* Action buttons - using regular buttons for reliability */}
      <div className="flex flex-col gap-3 pt-4">
        <button
          type="button"
          onClick={handleInstall}
          className="w-full px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold transition-colors cursor-pointer"
        >
          {t('updates.actions.installNow')}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="w-full px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-xl transition-colors cursor-pointer"
        >
          {t('updates.actions.installLater')}
        </button>
      </div>
    </div>
  );
};

// Error state - shows error message with retry option
interface ErrorStateProps {
  error?: string | null;
  onRetry: () => void;
  onClose: () => void;
}

const ErrorState: React.FC<ErrorStateProps> = ({ 
  error, 
  onRetry,
  onClose 
}) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-6 text-center">
      {/* Error icon */}
      <div className="flex justify-center mb-4">
        <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center text-red-400">
          <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" 
            />
          </svg>
        </div>
      </div>

      <h3 className="text-xl font-bold text-white">{t('updates.error.title')}</h3>

      <p className="text-gray-300">
        {error || t('updates.error.generic')}
      </p>

      <p className="text-sm text-gray-400">
        {t('updates.error.network')}
      </p>

      {/* Action buttons */}
      <div className="flex flex-col sm:flex-row gap-3 pt-4">
        <POSGlassButton
          variant="primary"
          onClick={onRetry}
          fullWidth
        >
          {t('updates.actions.retry')}
        </POSGlassButton>
        <POSGlassButton
          variant="secondary"
          onClick={onClose}
          fullWidth
        >
          {t('updates.actions.close')}
        </POSGlassButton>
      </div>
    </div>
  );
};

// Up to date state - application is current
interface UpToDateStateProps {
  onClose: () => void;
  currentVersion?: string;
}

const UpToDateState: React.FC<UpToDateStateProps> = ({ onClose, currentVersion }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-6 text-center">
      {/* Check icon */}
      <div className="flex justify-center mb-4">
        <div className="w-16 h-16 bg-cyan-500/20 rounded-full flex items-center justify-center text-cyan-400">
          <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" 
            />
          </svg>
        </div>
      </div>

      <h3 className="text-xl font-bold text-white">{t('updates.upToDate.title')}</h3>

      <p className="text-gray-300">
        {t('updates.upToDate.description')}
      </p>

      {/* Current version display */}
      {currentVersion && (
        <div className="bg-white/5 rounded-lg p-3">
          <span className="text-sm text-gray-400">{t('updates.upToDate.currentVersion', { version: currentVersion })}</span>
        </div>
      )}

      {/* Close button */}
      <div className="pt-4">
        <POSGlassButton
          variant="primary"
          onClick={onClose}
          fullWidth
        >
          {t('updates.actions.ok')}
        </POSGlassButton>
      </div>
    </div>
  );
};

// Helper function to extract release notes as HTML
function getReleaseNotesHtml(
  releaseNotes?: UpdateInfo['releaseNotes']
): string {
  if (!releaseNotes) {
    return '';
  }
  
  if (typeof releaseNotes === 'string') {
    return releaseNotes;
  }
  
  // Array of release note objects (ReleaseNoteInfo[])
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map(note => `<p><strong>${note.version}</strong>: ${note.note || ''}</p>`)
      .join('');
  }
  
  return '';
}

export default UpdateDialog;
