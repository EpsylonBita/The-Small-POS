import React from 'react';
import { toast, Toast } from 'react-hot-toast';
import { useI18n } from '../../contexts/i18n-context';
import { RefreshCw } from 'lucide-react';

/**
 * UpdateToast Component
 *
 * A clickable toast notification for background update availability.
 * When clicked, it dismisses the toast and triggers the onOpenDialog callback.
 *
 * Requirements: 3.3, 3.4
 */

interface UpdateToastProps {
  t: Toast;
  version: string;
  onOpenDialog: () => void;
}

export const UpdateToast: React.FC<UpdateToastProps> = ({ t, version, onOpenDialog }) => {
  const { t: translate } = useI18n();

  const handleClick = () => {
    toast.dismiss(t.id);
    onOpenDialog();
  };

  return (
    <div
      onClick={handleClick}
      className="cursor-pointer flex items-start gap-3 p-1"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick();
        }
      }}
    >
      <RefreshCw className="w-6 h-6 text-white" />
      <div>
        <div className="font-semibold text-white">{translate('updates.title.available')}</div>
        <div className="text-sm text-white/80">
          {translate('updates.toast.readyToDownload', { version })}
        </div>
        <div className="text-xs text-white/60 mt-1">{translate('updates.toast.clickToView')}</div>
      </div>
    </div>
  );
};

/**
 * Show an update notification toast
 * 
 * @param version - The version number of the available update
 * @param onOpenDialog - Callback to open the UpdateDialog when toast is clicked
 * @returns The toast ID
 */
export function showUpdateToast(version: string, onOpenDialog: () => void): string {
  return toast.custom(
    (t) => (
      <div
        className={`${
          t.visible ? 'animate-enter' : 'animate-leave'
        } max-w-md w-full bg-cyan-600/90 backdrop-blur-sm shadow-lg rounded-xl pointer-events-auto border border-white/20`}
      >
        <UpdateToast t={t} version={version} onOpenDialog={onOpenDialog} />
      </div>
    ),
    {
      duration: 10000, // Show for 10 seconds
      position: 'top-right',
    }
  );
}

export default UpdateToast;
