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
            // Windows-specific optimizations
            titleBarStyle: process.platform === 'win32' ? 'default' : 'hiddenInset',
            frame: true,
            show: true, // Show immediately for debugging - will show blank then content
            icon: path.join(__dirname, '../../public/icon.png'), // Add app icon
            // Touch-friendly window behavior
            resizable: true,
            maximizable: true,
            fullscreenable: true // Allow fullscreen toggle via F11 or menu
        });

        this.setupEventHandlers();
        this.loadContent();

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
        this.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
            const csp = this.isDev
                ? // Development: Allow unsafe-eval for HMR, unsafe-inline for styles
                "default-src 'self'; " +
                "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://maps.googleapis.com; " +
                "style-src 'self' 'unsafe-inline'; " +
                "connect-src 'self' ws://localhost:3002 ws://127.0.0.1:3002 http://localhost:3002 http://127.0.0.1:3002 http://localhost:3001 http://127.0.0.1:3001 https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://www.googleapis.com https://ipapi.co https://ipwho.is https://*.vercel.app https://*.thesmall.com https://*.the-small.ai https://tomikroparisi.the-small.ai; " +
                "img-src 'self' data: https:; " +
                "font-src 'self' data:; " +
                "frame-src 'none';"
                : // Production: Allow inline for webpack bundles, allow Vercel for multi-tenant admin dashboards
                "default-src 'self'; " +
                "base-uri 'self'; " +
                "object-src 'none'; " +
                "frame-ancestors 'none'; " +
                "script-src 'self' 'unsafe-inline' https://maps.googleapis.com; " +
                "style-src 'self' 'unsafe-inline'; " +
                "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://www.googleapis.com https://ipapi.co https://ipwho.is https://*.vercel.app https://*.thesmall.com https://*.the-small.ai https://tomikroparisi.the-small.ai; " +
                "img-src 'self' data: https:; " +
                "font-src 'self' data:; " +
                "frame-src 'none';";

            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [csp]
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
                        'videoCapture'          // older aliases on some Chromium builds
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
                    return ['geolocation', 'media', 'display-capture', 'videoCapture'].includes(permission);
                });
            }
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

        // Add error handling for content loading failures
        this.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            console.error('Failed to load content:', { errorCode, errorDescription, validatedURL });
            // Show window anyway so user can see something
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                this.mainWindow.show();
            }
        });

        // Add crash handler
        this.mainWindow.webContents.on('render-process-gone', (event, details) => {
            console.error('Renderer process gone:', details);
        });

        // Add console message handler for debugging
        this.mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
            if (level >= 2) { // Warning and above
                console.log(`[Renderer ${level}] ${message}`);
            }
        });

        // Load the app
        if (this.isDev) {
            // Development mode: Load from webpack-dev-server and open DevTools
            const loadContentAsync = async () => {
                try {
                    await this.mainWindow!.loadURL('http://localhost:3002');
                    this.mainWindow!.webContents.openDevTools();
                } catch (error) {
                    console.error('Failed to load React app:', error);
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
                console.log('Loading production content from:', indexPath);
                
                try {
                    await this.mainWindow!.loadFile(indexPath);
                    console.log('Production content loaded successfully');
                } catch (error) {
                    console.error('Failed to load production content:', error);
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
