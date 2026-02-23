import React, { useState, useEffect, useRef, CSSProperties } from 'react';
import { useTheme } from '../contexts/theme-context';
import { useWindowState } from '../hooks/useWindowState';
import { getBridge } from '../../lib';
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
}

const CustomTitleBar: React.FC<CustomTitleBarProps> = ({ updateAvailable = false, onCheckForUpdates }) => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const bridge = getBridge();
  const { isMaximized, isFullScreen } = useWindowState();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [isWindows, setIsWindows] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Detect platform
  useEffect(() => {
    // Check if we're on Windows by trying to detect the platform
    // In Electron renderer, we can check the user agent or use a different method
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

  const handleMenuItemClick = async (item: MenuItemType) => {
    setActiveMenu(null);

    if (item.action) {
      await item.action();
    } else if (item.role) {
      // Handle built-in roles via document commands
      switch (item.role) {
        case 'undo':
          document.execCommand('undo');
          break;
        case 'redo':
          document.execCommand('redo');
          break;
        case 'cut':
          document.execCommand('cut');
          break;
        case 'copy':
          document.execCommand('copy');
          break;
        case 'paste':
          document.execCommand('paste');
          break;
        case 'selectAll':
          document.execCommand('selectAll');
          break;
        case 'delete':
          document.execCommand('delete');
          break;
      }
    }
  };

  const menus: Record<string, MenuItemType[]> = {
    File: [
      {
        label: 'Settings',
        accelerator: 'Ctrl+,',
        action: async () => {
          // Open settings modal - we'll need to emit an event or use global state
          console.log('Open settings');
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
          // Open documentation in external browser
          console.log('Open documentation');
        },
      },
      {
        label: 'Community',
        action: async () => {
          // Open community link
          console.log('Open community');
        },
      },
      { type: 'separator' },
      {
        label: 'Report Issue',
        action: async () => {
          // Open issue tracker
          console.log('Report issue');
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
      className={`flex items-center justify-between h-8 select-none fixed top-0 left-0 right-0 z-[9999] transition-colors ${
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
                    absolute top-full left-0 mt-0 min-w-[200px] py-1 shadow-lg rounded-md z-50
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
    </div>
  );
};

export default CustomTitleBar;
