import React, { useState, useEffect, useRef, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useBlockerRegistration } from '../hooks/useBlockerRegistration';
import { useWindowState } from '../hooks/useWindowState';
import { getBridge } from '../../lib';
import { getResetStartingMessage, startResetAction } from '../utils/reset-actions';
import { openExternalUrl } from '../utils/external-url';
import {
  Minus,
  Square,
  X,
  Maximize2,
  RotateCw,
  RotateCcw,
  Search,
  Settings,
  Home,
  Users,
  Package,
  FileText,
  BarChart3,
  HelpCircle,
  Book,
  MessageSquare,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  Code,
  ZoomIn,
  ZoomOut,
  Maximize,
} from 'lucide-react';

// Extend CSSProperties to support -webkit-app-region
interface ExtendedCSSProperties extends CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

interface MenuItemType {
  label?: string;
  accelerator?: string;
  role?: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'delete';
  type?: 'separator';
  action?: () => void | Promise<void>;
  submenu?: MenuItemType[];
  hasNotification?: boolean;
}

interface CustomTitleBarProps {
  updateAvailable?: boolean;
  onCheckForUpdates?: () => void;
  onOpenSettings?: () => void;
}

type EditRole = NonNullable<MenuItemType['role']>;
type TextEditElement = HTMLInputElement | HTMLTextAreaElement;

const HELP_LINKS = {
  documentation: 'https://github.com/EpsylonBita/The-Small-POS/tree/main/docs',
  community: 'https://github.com/EpsylonBita/The-Small-POS/discussions',
  issue: 'https://github.com/EpsylonBita/The-Small-POS/issues/new/choose',
} as const;

const EDITABLE_INPUT_TYPES = new Set([
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

const isTextEditElement = (element: Element | null): element is TextEditElement => {
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }

  if (element instanceof HTMLInputElement) {
    const inputType = element.type ? element.type.toLowerCase() : 'text';
    return !element.disabled && !element.readOnly && EDITABLE_INPUT_TYPES.has(inputType);
  }

  return false;
};

const getEditableRoot = (): TextEditElement | HTMLElement | null => {
  const activeElement = document.activeElement;

  if (isTextEditElement(activeElement)) {
    return activeElement;
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return activeElement;
  }

  return null;
};

const dispatchEditableInput = (element: Element, inputType: string) => {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
};

const replaceTextSelection = (element: TextEditElement, replacement: string, inputType: string) => {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;

  element.setRangeText(replacement, start, end, 'end');
  dispatchEditableInput(element, inputType);
};

const getEditableSelection = (element: HTMLElement): Selection | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  return element.contains(container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement)
    ? selection
    : null;
};

const CustomTitleBar: React.FC<CustomTitleBarProps> = ({
  updateAvailable = false,
  onCheckForUpdates,
  onOpenSettings,
}) => {
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation();
  const isDark = resolvedTheme === 'dark';
  const bridge = getBridge();
  const { isMaximized, isFullScreen } = useWindowState();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [isWindows, setIsWindows] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const editHistoryRef = useRef(new WeakMap<TextEditElement, { undoStack: string[]; redoStack: string[]; lastValue: string }>());
  const applyingHistoryRef = useRef(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const resetDialogMetadata = React.useMemo(
    () => ({
      isResetting,
      confirmationLength: resetConfirmText.length,
    }),
    [isResetting, resetConfirmText.length],
  );

  useBlockerRegistration({
    id: 'custom-titlebar-reset-dialog',
    label: 'Reset terminal dialog',
    source: 'custom-titlebar',
    active: showResetDialog,
    metadata: resetDialogMetadata,
  });

  // Detect platform
  useEffect(() => {
    // Check if we're on Windows by trying to detect the platform
    // In the desktop renderer, we can check the user agent or use a different method
    const platform = navigator.platform || navigator.userAgent;
    const isWin = platform.toLowerCase().includes('win');
    console.log('[CustomTitleBar] Platform detected:', platform, 'isWindows:', isWin);
    setIsWindows(isWin);
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };

    if (activeMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeMenu]);

  const handleMinimize = async () => {
    await bridge.window.minimize();
  };

  const handleMaximize = async () => {
    await bridge.window.maximize();
    // State will be updated automatically by useWindowState hook polling
  };

  const handleClose = async () => {
    await bridge.window.close();
  };

  const handleMenuClick = (menuName: string) => {
    setActiveMenu(activeMenu === menuName ? null : menuName);
  };

  const ensureEditHistory = (element: TextEditElement) => {
    const existing = editHistoryRef.current.get(element);
    if (existing) {
      return existing;
    }

    const created = {
      undoStack: [] as string[],
      redoStack: [] as string[],
      lastValue: element.value,
    };
    editHistoryRef.current.set(element, created);
    return created;
  };

  useEffect(() => {
    const captureFocusedInput = (event: FocusEvent) => {
      if (isTextEditElement(event.target as Element | null)) {
        ensureEditHistory(event.target as TextEditElement);
      }
    };

    const captureInputHistory = (event: Event) => {
      if (applyingHistoryRef.current || !isTextEditElement(event.target as Element | null)) {
        return;
      }

      const element = event.target as TextEditElement;
      const history = ensureEditHistory(element);
      if (history.lastValue === element.value) {
        return;
      }

      history.undoStack.push(history.lastValue);
      if (history.undoStack.length > 100) {
        history.undoStack.shift();
      }
      history.redoStack = [];
      history.lastValue = element.value;
    };

    document.addEventListener('focusin', captureFocusedInput, true);
    document.addEventListener('input', captureInputHistory, true);

    return () => {
      document.removeEventListener('focusin', captureFocusedInput, true);
      document.removeEventListener('input', captureInputHistory, true);
    };
  }, []);

  const applyHistoryValue = (element: TextEditElement, value: string) => {
    applyingHistoryRef.current = true;
    element.value = value;
    element.setSelectionRange(value.length, value.length);
    dispatchEditableInput(element, 'historyUndo');
    applyingHistoryRef.current = false;
  };

  const performEditCommand = async (role: EditRole): Promise<boolean> => {
    const appCommandEvent = new CustomEvent('pos:edit-command', {
      cancelable: true,
      detail: { role },
    });
    if (!window.dispatchEvent(appCommandEvent)) {
      return true;
    }

    const editable = getEditableRoot();
    if (!editable) {
      return false;
    }

    if (isTextEditElement(editable)) {
      const history = ensureEditHistory(editable);
      const start = editable.selectionStart ?? editable.value.length;
      const end = editable.selectionEnd ?? start;
      const selectedText = editable.value.slice(start, end);

      if (role === 'undo') {
        const previous = history.undoStack.pop();
        if (previous === undefined) return false;
        history.redoStack.push(editable.value);
        history.lastValue = previous;
        applyHistoryValue(editable, previous);
        return true;
      }

      if (role === 'redo') {
        const next = history.redoStack.pop();
        if (next === undefined) return false;
        history.undoStack.push(editable.value);
        history.lastValue = next;
        applyHistoryValue(editable, next);
        return true;
      }

      if (role === 'selectAll') {
        editable.select();
        return true;
      }

      if (role === 'copy' || role === 'cut') {
        await bridge.clipboard.writeText(selectedText);
        if (role === 'cut' && selectedText) {
          replaceTextSelection(editable, '', 'deleteByCut');
        }
        return true;
      }

      if (role === 'paste') {
        const clipboardText = await bridge.clipboard.readText();
        replaceTextSelection(editable, clipboardText, 'insertFromPaste');
        return true;
      }

      if (role === 'delete') {
        if (start === end && start < editable.value.length) {
          editable.setSelectionRange(start, start + 1);
        }
        replaceTextSelection(editable, '', 'deleteContentForward');
        return true;
      }
    }

    const selection = getEditableSelection(editable);
    if (!selection) {
      return false;
    }

    if (role === 'selectAll') {
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }

    if (role === 'copy' || role === 'cut') {
      const selectedText = selection.toString();
      await bridge.clipboard.writeText(selectedText);
      if (role === 'cut' && selectedText) {
        selection.deleteFromDocument();
        dispatchEditableInput(editable, 'deleteByCut');
      }
      return true;
    }

    if (role === 'paste') {
      const clipboardText = await bridge.clipboard.readText();
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(clipboardText);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      dispatchEditableInput(editable, 'insertFromPaste');
      return true;
    }

    if (role === 'delete') {
      selection.deleteFromDocument();
      dispatchEditableInput(editable, 'deleteContentForward');
      return true;
    }

    return false;
  };

  useEffect(() => {
    const handleEditShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      const role: EditRole | null =
        key === 'z' && !event.shiftKey ? 'undo'
          : (key === 'y' || (key === 'z' && event.shiftKey)) ? 'redo'
            : key === 'x' ? 'cut'
              : key === 'c' ? 'copy'
                : key === 'v' ? 'paste'
                  : key === 'a' ? 'selectAll'
                    : null;

      if (!role) {
        return;
      }

      event.preventDefault();
      void performEditCommand(role);
    };

    window.addEventListener('keydown', handleEditShortcut, true);
    return () => window.removeEventListener('keydown', handleEditShortcut, true);
  }, [performEditCommand]);

  const openHelpLink = async (url: string) => {
    const opened = await openExternalUrl(url);
    if (!opened) {
      toast.error(t('common.openLinkFailed', 'Could not open link'));
    }
  };

  const handleMenuItemClick = async (item: MenuItemType) => {
    setActiveMenu(null);

    if (item.action) {
      await item.action();
    } else if (item.role) {
      await performEditCommand(item.role);
    }
  };

  const menus: Record<string, MenuItemType[]> = {
    File: [
      {
        label: 'Settings',
        accelerator: 'Ctrl+,',
        action: async () => {
          onOpenSettings?.();
        },
      },
      { type: 'separator' },
      {
        label: 'Exit',
        accelerator: 'Alt+F4',
        action: handleClose,
      },
    ],
    Edit: [
      { label: 'Undo', role: 'undo', accelerator: 'Ctrl+Z' },
      { label: 'Redo', role: 'redo', accelerator: 'Ctrl+Y' },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', accelerator: 'Ctrl+X' },
      { label: 'Copy', role: 'copy', accelerator: 'Ctrl+C' },
      { label: 'Paste', role: 'paste', accelerator: 'Ctrl+V' },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll', accelerator: 'Ctrl+A' },
    ],
    View: [
      {
        label: 'Reload',
        accelerator: 'Ctrl+R',
        action: async () => {
          await bridge.window.reload();
        },
      },
      {
        label: 'Force Reload',
        accelerator: 'Ctrl+Shift+R',
        action: async () => {
          await bridge.window.forceReload();
        },
      },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'Ctrl+Shift+I',
        action: async () => {
          await bridge.window.toggleDevtools();
        },
      },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'Ctrl+0',
        action: async () => {
          await bridge.window.zoomReset();
        },
      },
      {
        label: 'Zoom In',
        accelerator: 'Ctrl+=',
        action: async () => {
          await bridge.window.zoomIn();
        },
      },
      {
        label: 'Zoom Out',
        accelerator: 'Ctrl+-',
        action: async () => {
          await bridge.window.zoomOut();
        },
      },
      { type: 'separator' },
      {
        label: 'Toggle Fullscreen',
        accelerator: 'F11',
        action: async () => {
          await bridge.window.toggleFullscreen();
        },
      },
    ],
    Window: [
      {
        label: 'Minimize',
        accelerator: 'Ctrl+M',
        action: handleMinimize,
      },
      {
        label: isMaximized ? 'Restore' : 'Maximize',
        action: handleMaximize,
      },
      { type: 'separator' },
      {
        label: 'Reset Terminal',
        action: async () => {
          setShowResetDialog(true);
          setResetConfirmText('');
        },
      },
      { type: 'separator' },
      {
        label: 'Close',
        accelerator: 'Ctrl+W',
        action: handleClose,
      },
    ],
    Help: [
      ...(updateAvailable ? [{
        label: 'New Update Available',
        hasNotification: true,
        action: async () => {
          try {
            console.log('[CustomTitleBar] Opening update dialog for available update');
            if (onCheckForUpdates) {
              onCheckForUpdates();
            } else {
              await bridge.menu.triggerCheckForUpdates();
            }
          } catch (error) {
            console.error('[CustomTitleBar] Failed to open update dialog:', error);
          }
        },
      }, { type: 'separator' as const }] : []),
      {
        label: 'Documentation',
        action: async () => {
          await openHelpLink(HELP_LINKS.documentation);
        },
      },
      {
        label: 'Community',
        action: async () => {
          await openHelpLink(HELP_LINKS.community);
        },
      },
      { type: 'separator' },
      {
        label: 'Report Issue',
        action: async () => {
          await openHelpLink(HELP_LINKS.issue);
        },
      },
      { type: 'separator' },
      {
        label: 'Check for Updates',
        action: async () => {
          try {
            console.log('[CustomTitleBar] Triggering menu check for updates event');
            if (onCheckForUpdates) {
              onCheckForUpdates();
            } else {
              // Trigger the menu event that useAutoUpdater listens for
              await bridge.menu.triggerCheckForUpdates();
            }
          } catch (error) {
            console.error('[CustomTitleBar] Failed to trigger update check:', error);
          }
        },
      },
    ],
  };

  const dragRegionStyle: ExtendedCSSProperties = {
    WebkitAppRegion: 'drag',
  };

  const noDragRegionStyle: ExtendedCSSProperties = {
    WebkitAppRegion: 'no-drag',
  };

  // Hide title bar when in fullscreen mode
  if (isFullScreen) {
    return null;
  }

  return (
    <div
      className={`flex items-center justify-between h-8 select-none fixed top-0 left-0 right-0 z-[2147483646] transition-colors ${
        isDark
          ? 'bg-black border-b border-gray-900'
          : 'bg-white border-b border-gray-200'
      }`}
      style={dragRegionStyle}
    >
      {/* Left: Menus */}
      <div className="flex items-center h-full">
        {/* Menu Bar */}
        <div className="flex items-center h-full" ref={menuRef} style={noDragRegionStyle}>
          {Object.keys(menus).map((menuName) => (
            <div key={menuName} className="relative">
              <button
                className={`
                  px-3 h-8 text-xs font-medium transition-colors relative
                  ${isDark
                    ? `${activeMenu === menuName ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'}`
                    : `${activeMenu === menuName ? 'bg-gray-100 text-gray-900' : 'text-gray-700 hover:bg-gray-100'}`
                  }
                `}
                onClick={() => handleMenuClick(menuName)}
              >
                {menuName}
                {/* Orange dot notification for Help menu when update is available */}
                {menuName === 'Help' && updateAvailable && (
                  <span className="absolute top-1 right-1 w-2 h-2 bg-orange-500 rounded-full"></span>
                )}
              </button>

              {/* Dropdown Menu */}
              {activeMenu === menuName && (
                <div
                  className={`
                    absolute top-full left-0 mt-0 min-w-[200px] py-1 shadow-lg rounded-md z-[2147483647]
                    ${isDark
                      ? 'bg-[#1a1a1a] border border-gray-800'
                      : 'bg-white border border-gray-200'
                    }
                  `}
                >
                  {menus[menuName].map((item, index) => {
                    if (item.type === 'separator') {
                      return (
                        <div
                          key={`separator-${index}`}
                          className={`my-1 h-px ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}
                        />
                      );
                    }

                    return (
                      <button
                        key={item.label}
                        className={`
                          w-full px-3 py-1.5 text-left text-xs flex items-center justify-between relative
                          ${isDark
                            ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                          }
                        `}
                        onClick={() => handleMenuItemClick(item)}
                      >
                        <span className="flex items-center gap-2">
                          {item.hasNotification && (
                            <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
                          )}
                          {item.label}
                        </span>
                        {item.accelerator && (
                          <span className={`ml-8 text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {item.accelerator}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Right: Window controls (Windows only) */}
      {isWindows && (
        <div className="flex items-center h-full" style={noDragRegionStyle}>
          <button
            onClick={handleMinimize}
            className={`h-8 w-12 flex items-center justify-center transition-colors ${
              isDark
                ? 'hover:bg-gray-700 text-gray-300'
                : 'hover:bg-gray-100 text-gray-700'
            }`}
            aria-label="Minimize"
          >
            <Minus size={14} strokeWidth={2} />
          </button>
          <button
            onClick={handleMaximize}
            className={`h-8 w-12 flex items-center justify-center transition-colors ${
              isDark
                ? 'hover:bg-gray-700 text-gray-300'
                : 'hover:bg-gray-100 text-gray-700'
            }`}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <Square size={12} strokeWidth={2} /> : <Maximize2 size={12} strokeWidth={2} />}
          </button>
          <button
            onClick={handleClose}
            className={`h-8 w-12 flex items-center justify-center transition-colors hover:bg-red-600 hover:text-white ${
              isDark
                ? 'text-gray-300'
                : 'text-gray-700'
            }`}
            aria-label="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Emergency Reset Confirmation Dialog */}
      {showResetDialog && createPortal(
        <div className="fixed inset-0 z-[2147483647] flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => { if (!isResetting) { setShowResetDialog(false); } }}
          />
          {/* Dialog */}
          <div className={`relative w-full max-w-md mx-4 p-6 rounded-xl shadow-2xl border ${
            isDark
              ? 'bg-gray-900 border-gray-700 text-white'
              : 'bg-white border-gray-200 text-gray-900'
          }`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-red-500/20">
                <AlertTriangle size={20} className="text-red-500" />
              </div>
              <h3 className="text-lg font-bold">Reset Terminal</h3>
            </div>

            <p className={`text-sm mb-3 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              This will completely erase all local data and disconnect this terminal. The app will restart and require a new connection code to set up again.
            </p>

            <ul className={`text-xs mb-4 space-y-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              <li>&#8226; All local orders and transaction history will be deleted</li>
              <li>&#8226; All settings and PIN will be cleared</li>
              <li>&#8226; Terminal configuration and credentials will be removed</li>
              <li>&#8226; You will need a new connection code from the admin dashboard</li>
            </ul>

            <div className="mb-4">
              <label className={`text-xs font-medium block mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Type <span className="font-bold text-red-500">RESET</span> to confirm
              </label>
              <input
                type="text"
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                disabled={isResetting}
                placeholder="RESET"
                autoFocus
                className={`w-full px-3 py-2 rounded-lg border text-sm font-mono ${
                  isDark
                    ? 'bg-gray-800 border-gray-600 text-white placeholder-gray-500'
                    : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400'
                } focus:outline-none focus:ring-2 focus:ring-red-500/50`}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setShowResetDialog(false); setResetConfirmText(''); }}
                disabled={isResetting}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isDark
                    ? 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (resetConfirmText !== 'RESET') return;
                  setIsResetting(true);
                  let resetStarted = false;
                  try {
                    const result = await startResetAction(() => bridge.settings.emergencyReset(), t);
                    if (!result?.success) {
                      throw new Error(result?.error || 'Failed to start emergency reset');
                    }
                    resetStarted = true;
                    localStorage.clear();
                    setShowResetDialog(false);
                    toast.success(getResetStartingMessage(t));
                  } catch (err) {
                    console.error('[CustomTitleBar] Emergency reset failed:', err);
                    if (!resetStarted) {
                      setIsResetting(false);
                    }
                  }
                }}
                disabled={resetConfirmText !== 'RESET' || isResetting}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  resetConfirmText === 'RESET' && !isResetting
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-red-600/30 text-red-300 cursor-not-allowed'
                }`}
              >
                {isResetting ? 'Resetting...' : 'Reset Terminal'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default CustomTitleBar;
