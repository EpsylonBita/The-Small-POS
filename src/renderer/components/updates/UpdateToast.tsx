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
      className="flex cursor-pointer items-start gap-3 rounded-2xl p-3 transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      <RefreshCw className="w-6 h-6 text-amber-200" />
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
        } pointer-events-auto w-full max-w-md rounded-2xl border border-amber-300/35 bg-zinc-950/90 shadow-[0_18px_48px_rgba(0,0,0,0.32)] backdrop-blur-xl`}
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
