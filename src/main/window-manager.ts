import { app, BrowserWindow, screen, shell, desktopCapturer } from 'electron';
import * as path from 'path';
import { AuthService } from './services/AuthService';

export class WindowManager {
    private mainWindow: BrowserWindow | null = null;
    private isDev: boolean;
    private authService: AuthService | null = null;

    constructor() {
        this.isDev = process.env.NODE_ENV === 'development';
    }

    public setAuthService(authService: AuthService) {
        this.authService = authService;
    }

    public getMainWindow(): BrowserWindow | null {
        return this.mainWindow;
    }

    public createWindow(): BrowserWindow {
        // Get primary display dimensions
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;

        console.log('[WindowManager] Creating window with dimensions:', { width, height });

        // Create the browser window with touch-optimized settings
        this.mainWindow = new BrowserWindow({
            width: Math.min(1200, width),
            height: Math.min(800, height),
            minWidth: 800,
            minHeight: 600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js'),
                // Touch and Windows optimizations
                experimentalFeatures: false, // Disabled experimental features to prevent security warnings
                scrollBounce: false,
                // Add sandbox for better security
                sandbox: true
            },
            // Custom titlebar - frameless on Windows, hiddenInset on macOS
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
            frame: false, // Frameless window for custom titlebar
            show: false, // Start hidden, show after content loads
            icon: path.join(__dirname, '../../public/icon.png'), // Add app icon
            // Touch-friendly window behavior
            resizable: true,
            maximizable: true,
            fullscreenable: true, // Allow fullscreen toggle via F11 or menu
            backgroundColor: '#000000' // Match dark theme default
        });

        console.log('[WindowManager] Window created, clearing cache...');

        // Clear cache on startup to prevent stale UI
        this.mainWindow.webContents.session.clearCache().then(() => {
            console.log('[WindowManager] Cache cleared successfully');
        }).catch((err) => {
            console.error('[WindowManager] Failed to clear cache:', err);
        });

        this.setupEventHandlers();
        this.loadContent();

        // Force show window after a short delay to ensure it appears
        setTimeout(() => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                console.log('[WindowManager] Force showing window after 2s delay');
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        }, 2000);

        return this.mainWindow;
    }

    private setupEventHandlers() {
        if (!this.mainWindow) return;

        // Show window when ready to prevent visual flash
        this.mainWindow.once('ready-to-show', () => {
            console.log('Window ready-to-show event fired');
            if (this.mainWindow) {
                this.mainWindow.show();
                console.log('Window shown');

                // Focus window for better UX
                if (this.isDev) {
                    this.mainWindow.focus();
                }
            }
        });

        // Fallback: Show window after timeout if ready-to-show never fires
        const showTimeout = setTimeout(() => {
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.warn('Window ready-to-show timeout - forcing show');
                this.mainWindow.show();
            }
        }, 10000); // 10 second timeout

        // Clear timeout if window is destroyed
        this.mainWindow.once('closed', () => {
            clearTimeout(showTimeout);
        });

        // Handle app cleanup
        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
        });

        // Handle window focus for activity tracking
        this.mainWindow.on('focus', () => {
            if (this.authService) {
                this.authService.updateActivity();
            }
        });

        // Handle window events for touch optimization and keyboard shortcuts
        this.mainWindow.webContents.on('before-input-event', (event, input) => {
            // Track user activity for session management
            if (this.authService && (input.type === 'keyDown' || input.type === 'mouseDown')) {
                this.authService.updateActivity();
            }

            // F11 to toggle fullscreen
            if (input.type === 'keyDown' && input.key === 'F11') {
                event.preventDefault();
                if (this.mainWindow) {
                    const isFullScreen = this.mainWindow.isFullScreen();
                    this.mainWindow.setFullScreen(!isFullScreen);
                }
            }
        });

        // Prevent navigation away from the app
        this.mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
            const parsedUrl = new URL(navigationUrl);
            if (!this.isDev) {
                // In production, only allow in-app file navigation
                if (parsedUrl.protocol !== 'file:') {
                    event.preventDefault();
                }
            } else {
                // In development, allow the dev server origins only
                const allowedOrigins = new Set(['http://localhost:3002', 'http://127.0.0.1:3002']);
                if (!allowedOrigins.has(parsedUrl.origin)) {
                    event.preventDefault();
                }
            }
        });

        // Handle external links with protocol allowlist
        this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            try {
                const u = new URL(url);
                const allowed = new Set(['http:', 'https:', 'mailto:']);
                if (allowed.has(u.protocol)) {
                    shell.openExternal(url);
                }
            } catch { }
            return { action: 'deny' };
        });

        // Set Content Security Policy
        // SECURITY: Strict CSP to prevent XSS attacks
        this.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
            const csp = this.isDev
                ? // Development: Allow unsafe-eval for HMR, unsafe-inline for styles only
                "default-src 'self'; " +
                "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://maps.googleapis.com; " +
                "style-src 'self' 'unsafe-inline'; " +
                "connect-src 'self' ws://localhost:3002 ws://127.0.0.1:3002 http://localhost:3002 http://127.0.0.1:3002 http://localhost:3001 http://127.0.0.1:3001 https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://www.googleapis.com https://ipapi.co https://ipwho.is https://*.vercel.app https://*.thesmall.com https://*.the-small.ai https://tomikroparisi.the-small.ai; " +
                "img-src 'self' data: https:; " +
                "font-src 'self' data:; " +
                "frame-src 'none';"
                : // Production: Strict CSP - unsafe-inline removed for scripts
                "default-src 'self'; " +
                "base-uri 'self'; " +
                "object-src 'none'; " +
                "frame-ancestors 'none'; " +
                "script-src 'self' https://maps.googleapis.com; " + // REMOVED unsafe-inline
                "style-src 'self' 'unsafe-inline'; " + // Styles still need inline for webpack CSS-in-JS
                "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://www.googleapis.com https://ipapi.co https://ipwho.is https://*.vercel.app https://*.thesmall.com https://*.the-small.ai https://tomikroparisi.the-small.ai; " +
                "img-src 'self' data: https:; " +
                "font-src 'self' data:; " +
                "frame-src 'none'; " +
                "upgrade-insecure-requests;"; // Force HTTPS for external resources

            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [csp],
                    // Additional security headers
                    'X-Content-Type-Options': ['nosniff'],
                    'X-Frame-Options': ['DENY'],
                    'X-XSS-Protection': ['1; mode=block'],
                }
            });
        });

        // Permission handling
        this.setupPermissionHandlers();
    }

    private setupPermissionHandlers() {
        if (!this.mainWindow) return;

        try {
            const ses = this.mainWindow.webContents.session;
            if (ses && typeof ses.setPermissionRequestHandler === 'function') {
                ses.setPermissionRequestHandler((webContents, permission, callback) => {
                    const allowed = new Set([
                        'geolocation',          // address autocomplete
                        'media',                // getUserMedia (camera/mic/screen w/ desktop constraint)
                        'display-capture',      // getDisplayMedia screen sharing
                        'videoCapture',         // older aliases on some Chromium builds
                        'bluetooth'             // Web Bluetooth API for printer discovery
                    ]);
                    if (allowed.has(permission)) {
                        console.log(`✅ Permission granted: ${permission}`);
                        return callback(true);
                    }
                    console.log(`❌ Permission denied: ${permission}`);
                    return callback(false);
                });
            }
            if (ses && typeof ses.setPermissionCheckHandler === 'function') {
                ses.setPermissionCheckHandler((_wc, permission, _details) => {
                    return ['geolocation', 'media', 'display-capture', 'videoCapture', 'bluetooth'].includes(permission);
                });
            }

            // Handle Web Bluetooth device selection
            // This must be attached to webContents, not session
            this.mainWindow.webContents.on('select-bluetooth-device', (event: any, deviceList: any[], callback: (deviceId: string) => void) => {
                event.preventDefault();
                console.log('[Bluetooth] Device selection requested, found', deviceList.length, 'devices');

                // Filter for devices that look like printers
                const printerDevices = deviceList.filter((device: any) => {
                    const name = device.deviceName || '';
                    const patterns = [
                        /printer/i, /thermal/i, /receipt/i, /pos/i,
                        /epson/i, /star/i, /bixolon/i, /citizen/i,
                        /zebra/i, /brother/i, /tsp/i, /tm-/i, /srp-/i, /ct-/i
                    ];
                    return patterns.some(pattern => pattern.test(name));
                });

                if (printerDevices.length > 0) {
                    console.log('[Bluetooth] Found printer devices:', printerDevices.map((d: any) => d.deviceName));
                    // Select the first printer device found
                    callback(printerDevices[0].deviceId);
                } else if (deviceList.length > 0) {
                    console.log('[Bluetooth] No printer-like devices found, selecting first device');
                    // If no printer-like devices, select the first one
                    callback(deviceList[0].deviceId);
                } else {
                    console.log('[Bluetooth] No devices found');
                    callback('');
                }
            });
            // Handle getDisplayMedia screen picking in Electron
            try {
                const sesAny: any = ses as any;
                if (sesAny && typeof sesAny.setDisplayMediaRequestHandler === 'function') {
                    sesAny.setDisplayMediaRequestHandler((_request: any, callback: any) => {
                        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
                            const chosen = (sources && sources.length > 0) ? sources[0] : null;
                            if (chosen) {
                                console.log('[ScreenCapture] setDisplayMediaRequestHandler: granting first screen');
                                callback({ video: chosen });
                            } else {
                                console.warn('[ScreenCapture] setDisplayMediaRequestHandler: no screen sources');
                                callback({});
                            }
                        }).catch((err) => {
                            console.error('[ScreenCapture] setDisplayMediaRequestHandler error', err);
                            try { callback({}); } catch (_) { /* noop */ }
                        });
                    }, { useSystemPicker: false } as any);
                }
            } catch (e) {
                console.warn('Failed to set display media handler:', e);
            }

        } catch (e) {
            console.warn('Failed to set permission handlers:', e);
        }
    }

    private loadContent() {
        if (!this.mainWindow) return;

        console.log('[WindowManager] loadContent called, isDev:', this.isDev);

        // Add error handling for content loading failures
        this.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            console.error('[WindowManager] Failed to load content:', { errorCode, errorDescription, validatedURL });
            // Show window anyway so user can see something
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.log('[WindowManager] Showing window after load failure');
                this.mainWindow.show();
            }
        });

        // Add successful load handler
        this.mainWindow.webContents.on('did-finish-load', () => {
            console.log('[WindowManager] Content finished loading successfully');
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.log('[WindowManager] Showing window after successful load');
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        });

        // Add crash handler
        this.mainWindow.webContents.on('render-process-gone', (event, details) => {
            console.error('[WindowManager] Renderer process gone:', details);
        });

        // Add console message handler for debugging - log ALL messages in production
        this.mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
            // Log all console messages to help debug
            const levelNames = ['verbose', 'info', 'warning', 'error'];
            console.log(`[Renderer:${levelNames[level] || level}] ${message}`);
        });

        // Load the app
        if (this.isDev) {
            // Development mode: Load from webpack-dev-server and open DevTools
            const loadContentAsync = async () => {
                try {
                    console.log('[WindowManager] Loading dev server URL...');
                    await this.mainWindow!.loadURL('http://localhost:3002');
                    this.mainWindow!.webContents.openDevTools();
                } catch (error) {
                    console.error('[WindowManager] Failed to load React app:', error);
                    // Show window anyway
                    if (this.mainWindow && !this.mainWindow.isVisible()) {
                        this.mainWindow.show();
                    }
                }
            };

            loadContentAsync();
        } else {
            // Production mode: Load built files with small delay to ensure IPC handlers are ready
            const loadProductionContent = async () => {
                // Small delay to ensure all IPC handlers are registered before renderer loads
                await new Promise(resolve => setTimeout(resolve, 500));

                const indexPath = path.join(__dirname, '../renderer/index.html');
                console.log('[WindowManager] Loading production content from:', indexPath);

                // Check if file exists
                const fs = require('fs');
                if (!fs.existsSync(indexPath)) {
                    console.error('[WindowManager] ERROR: index.html not found at:', indexPath);
                    console.log('[WindowManager] __dirname is:', __dirname);
                    console.log('[WindowManager] Listing directory contents...');
                    try {
                        const parentDir = path.join(__dirname, '..');
                        console.log('[WindowManager] Parent dir contents:', fs.readdirSync(parentDir));
                        const rendererDir = path.join(__dirname, '../renderer');
                        if (fs.existsSync(rendererDir)) {
                            console.log('[WindowManager] Renderer dir contents:', fs.readdirSync(rendererDir));
                        }
                    } catch (e) {
                        console.error('[WindowManager] Failed to list directories:', e);
                    }
                }

                try {
                    await this.mainWindow!.loadFile(indexPath);
                    console.log('[WindowManager] Production content loaded successfully');
                } catch (error) {
                    console.error('[WindowManager] Failed to load production content:', error);
                    // Show window anyway so user can see the error
                    if (this.mainWindow && !this.mainWindow.isVisible()) {
                        this.mainWindow.show();
                    }
                }
            };

            loadProductionContent();
        }
    }
}
