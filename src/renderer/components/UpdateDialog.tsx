import React from 'react';
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
  onDownload,
  onCancel,
  onInstall,
  onRetry,
}) => {
  const getTitle = (): string => {
    switch (status) {
      case 'checking':
        return 'Checking for Updates';
      case 'available':
        return 'Update Available';
      case 'downloading':
        return 'Downloading Update';
      case 'downloaded':
        return 'Update Ready';
      case 'error':
        return 'Update Error';
      case 'not-available':
      case 'idle':
      default:
        return 'Software Update';
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
        return <UpToDateState onClose={onClose} />;
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
const CheckingState: React.FC = () => (
  <div className="flex flex-col items-center justify-center py-8 space-y-4">
    <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
    <p className="text-gray-300 text-center">
      Checking for updates...
    </p>
  </div>
);

// Available state - shows version info and release notes
interface AvailableStateProps {
  updateInfo?: UpdateInfo | null;
  onDownload: () => void;
  onClose: () => void;
}

const AvailableState: React.FC<AvailableStateProps> = ({ 
  updateInfo, 
  onDownload,
  onClose 
}) => {
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
            Version {updateInfo?.version || 'Unknown'}
          </h3>
          {updateInfo?.releaseDate && (
            <p className="text-sm text-gray-300">
              Released: {new Date(updateInfo.releaseDate).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>

      {/* Release notes */}
      {releaseNotes && (
        <div className="bg-black/20 rounded-lg p-4 max-h-48 overflow-y-auto">
          <h4 className="text-sm font-semibold text-gray-300 mb-2">What's New:</h4>
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
          Download Update
        </POSGlassButton>
        <POSGlassButton
          variant="secondary"
          onClick={onClose}
          fullWidth
        >
          Later
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
          <span className="block text-gray-400">Progress</span>
          <span className="block text-xl font-bold text-white">
            {percent.toFixed(0)}%
          </span>
        </div>
        <div className="bg-white/5 p-3 rounded-lg">
          <span className="block text-gray-400">Speed</span>
          <span className="block text-xl font-bold text-white">
            {speed.toFixed(1)} MB/s
          </span>
        </div>
        <div className="col-span-2 bg-white/5 p-3 rounded-lg">
          <span className="block text-gray-400">Downloaded</span>
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
          Cancel Download
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
  const version = updateInfo?.version || 'New Version';

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

      <h3 className="text-xl font-bold text-white">Version {version} is ready!</h3>

      <p className="text-gray-300">
        The update has been downloaded successfully.
        You can install it now (requires restart) or it will be installed automatically the next time you restart the app.
      </p>

      {/* Warning note */}
      <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-sm text-yellow-200">
        ⚠️ Note: The application will restart immediately if you choose "Install Now".
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-3 pt-4">
        <POSGlassButton
          variant="success"
          onClick={onInstall}
          size="large"
          fullWidth
          className="font-bold"
        >
          Restart & Install Now
        </POSGlassButton>
        <POSGlassButton
          variant="secondary"
          onClick={onClose}
          fullWidth
        >
          Install on Next Restart
        </POSGlassButton>
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
}) => (
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

    <h3 className="text-xl font-bold text-white">Update Failed</h3>

    <p className="text-gray-300">
      {error || 'An error occurred while checking for or downloading updates.'}
    </p>

    <p className="text-sm text-gray-400">
      Please check your internet connection and try again.
    </p>

    {/* Action buttons */}
    <div className="flex flex-col sm:flex-row gap-3 pt-4">
      <POSGlassButton
        variant="primary"
        onClick={onRetry}
        fullWidth
      >
        Retry
      </POSGlassButton>
      <POSGlassButton
        variant="secondary"
        onClick={onClose}
        fullWidth
      >
        Close
      </POSGlassButton>
    </div>
  </div>
);

// Up to date state - application is current
interface UpToDateStateProps {
  onClose: () => void;
}

const UpToDateState: React.FC<UpToDateStateProps> = ({ onClose }) => (
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

    <h3 className="text-xl font-bold text-white">You're Up to Date!</h3>

    <p className="text-gray-300">
      The Small POS is running the latest version.
    </p>

    {/* Close button */}
    <div className="pt-4">
      <POSGlassButton
        variant="primary"
        onClick={onClose}
        fullWidth
      >
        OK
      </POSGlassButton>
    </div>
  </div>
);

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
