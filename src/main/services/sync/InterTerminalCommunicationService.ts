import * as http from 'http';
import * as crypto from 'crypto';
import { Bonjour, Browser, Service } from 'bonjour-service';
import { FeatureService } from '../FeatureService';
import { BaseService } from '../BaseService';
import { DatabaseManager } from '../../database';
import { BrowserWindow } from 'electron';

export interface TerminalDiscoveryInfo {
    terminal_id: string;
    ip_address: string;
    port: number;
    terminal_type: string;
    branch_id: string | null;
    name?: string;
}

export interface OrderForwardRequest {
    orderData: any;
    source_terminal_id: string;
    timestamp: string;
}

export interface OrderForwardResponse {
    success: boolean;
    order_id?: string;
    error?: string;
}

export class InterTerminalCommunicationService extends BaseService {
    private httpServer: http.Server | null = null;
    private bonjourService: Bonjour | null = null;
    private parentTerminalInfo: TerminalDiscoveryInfo | null = null;
    private isServerRunning = false;
    private port: number;
    private featureService: FeatureService;
    private dbManager: DatabaseManager;
    private mainWindow: BrowserWindow | null = null;
    private browser: Browser | null = null;

    // OrderSyncService will be injected later to avoid circular dependency
    private orderHandler: ((orderData: any, sourceTerminalId: string) => Promise<void>) | null = null;

    private lastReachable: boolean = false;
    private lastReachableTime: number = 0;

    constructor(
        dbManager: DatabaseManager,
        featureService: FeatureService,
        port: number = 8765
    ) {
        // BaseService expects the raw database instance
        // We access it via dbManager.db assuming it exists
        super(dbManager.db);
        this.dbManager = dbManager;
        this.featureService = featureService;
        this.port = port;
    }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public setOrderHandler(handler: (orderData: any, sourceTerminalId: string) => Promise<void>) {
        this.orderHandler = handler;
    }

    public async initialize(): Promise<void> {
        // Ensure cleanup if re-initializing
        this.cleanup();

        const isMain = this.featureService.isMainTerminal();
        const isMobile = this.featureService.isMobileWaiter();

        // Get configurable timeout
        const discoveryTimeout = this.dbManager.getDatabaseService().settings.getParentDiscoveryTimeoutMs();

        console.log(`[InterTerminal] Initializing. Type: ${isMain ? 'Main' : 'Mobile'}, Port: ${this.port}, Timeout: ${discoveryTimeout}`);

        if (isMain) {
            await this.startHttpServer();
            this.publishService();
        } else if (isMobile) {
            this.startParentDiscovery();
        }
    }

    public resetDiscovery(): void {
        if (this.browser) {
            this.browser.stop();
            this.browser = null;
        }
        if (this.bonjourService) {
            this.bonjourService.destroy();
            this.bonjourService = null;
        }
        this.parentTerminalInfo = null;
        this.lastReachable = false;
        // Optionally notify UI
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('parent-terminal-discovered', null);
        }
    }

    private getTerminalId(): string {
        const dbSvc = this.dbManager.getDatabaseService();
        return dbSvc.settings.getSetting('terminal', 'terminal_id', 'unknown') as string;
    }

    private getBranchId(): string | null {
        const dbSvc = this.dbManager.getDatabaseService();
        return dbSvc.settings.getSetting('terminal', 'branch_id', null) as string | null;
    }

    private publishService(): void {
        this.bonjourService = new Bonjour();
        const terminalId = this.getTerminalId();
        const branchId = this.getBranchId();

        console.log(`[InterTerminal] Publishing service _pos-main._tcp for terminal ${terminalId}`);

        this.bonjourService.publish({
            name: `POS Main: ${terminalId}`,
            type: 'pos-main',
            port: this.port,
            txt: {
                terminal_id: terminalId,
                branch_id: branchId || '',
                version: '1.0.0'
            }
        });
    }

    private startParentDiscovery(): void {
        this.bonjourService = new Bonjour();
        const myBranchId = this.getBranchId();
        const configuredParentId = this.featureService.getParentTerminalId();
        const discoveryTimeout = this.dbManager.getDatabaseService().settings.getParentDiscoveryTimeoutMs();

        console.log(`[InterTerminal] Starting parent discovery. Branch: ${myBranchId}, Configured Parent: ${configuredParentId}, Timeout: ${discoveryTimeout}ms`);

        this.browser = this.bonjourService.find({ type: 'pos-main' }, (service: Service) => {
            console.log('[InterTerminal] Discovered service:', service.name, service.txt);

            // Filter logic
            const discoveredTerminalId = service.txt?.terminal_id;
            const discoveredBranchId = service.txt?.branch_id;

            // If we have a configured parent ID, only connect to that one
            if (configuredParentId && discoveredTerminalId !== configuredParentId) {
                return;
            }

            // If we have a branch ID, ensure parent matches (optional security check)
            if (myBranchId && discoveredBranchId && myBranchId !== discoveredBranchId) {
                console.log('[InterTerminal] Ignoring parent from different branch');
                return;
            }

            // Found a valid parent
            this.parentTerminalInfo = {
                terminal_id: discoveredTerminalId,
                ip_address: service.addresses?.[0] || service.host, // addresses[0] is usually IPv4
                port: service.port,
                terminal_type: 'main',
                branch_id: discoveredBranchId,
                name: service.name
            };

            // Assume reachable initially upon fresh discovery
            this.lastReachable = true;
            this.lastReachableTime = Date.now();

            console.log('[InterTerminal] Parent terminal discovered:', this.parentTerminalInfo);

            // Emit event to UI
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('parent-terminal-discovered', this.parentTerminalInfo);
            }

            // Stop discovery once found to save resources? 
            // The requirement didn't explicitly say stop ONCE found, but usually "discovery timeout" implies "give up if not found by X". 
            // If found, we might want to keep monitoring or stop. 
            // Usually we stop if we found our target. 
            if (this.parentTerminalInfo) {
                // If we found a parent, we can potentially stop searching provided we are happy with this one.
                // However, the timeout instruction specifically said "stop browser after discoveryTimeout if no parent found".
                // It didn't say what to do if found. But stopping if found is also good practice unless we expect it to change.
                // For now, I will NOT stop immediately on find to match "stop after timeout" strictly, implies it runs for the duration.
                // Actually, if we found it, we probably don't need to timeout-fail.
            }
        });

        // Implement discovery timeout wrapper
        if (discoveryTimeout > 0) {
            setTimeout(() => {
                if (!this.parentTerminalInfo && this.browser) {
                    console.warn(`[InterTerminal] Parent discovery timed out after ${discoveryTimeout}ms. Stopping browser.`);
                    this.browser.stop();
                    this.browser = null;
                    // Optionally notify UI of failure/timeout
                }
            }, discoveryTimeout);
        }
    }

    private generateSignature(payload: string, secret: string): string {
        return crypto.createHmac('sha256', secret).update(payload).digest('hex');
    }

    private async startHttpServer(): Promise<void> {
        if (this.isServerRunning) return;

        return new Promise((resolve) => {
            this.httpServer = http.createServer(async (req, res) => {
                // Enable CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-terminal-signature, x-terminal-key');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                if (req.method === 'POST' && req.url === '/api/orders/forward') {
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk.toString();
                    });

                    req.on('end', async () => {
                        try {
                            // 0. Verify Signature
                            const signature = req.headers['x-terminal-signature'] as string | undefined;
                            const secret = this.dbManager.getDatabaseService().settings.getInterTerminalSecret();

                            if (signature) {
                                const expectedSignature = this.generateSignature(body, secret);
                                if (signature !== expectedSignature) {
                                    console.warn(`[InterTerminal] Invalid Signature. IP=${req.socket.remoteAddress}`);
                                    res.writeHead(401, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid signature' }));
                                    return;
                                }
                            } else {
                                // For backward compatibility or transition, you might log warning or reject
                                // Rejecting is safer
                                console.warn(`[InterTerminal] Missing Signature. IP=${req.socket.remoteAddress}`);
                                res.writeHead(401, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Unauthorized: Missing signature' }));
                                return;
                            }

                            const data = JSON.parse(body) as OrderForwardRequest;

                            // 1. Internal Auth & Validation
                            const myBranchId = this.getBranchId();
                            const sourceBranchId = data.orderData?.branch_id;

                            if (myBranchId && sourceBranchId && myBranchId !== sourceBranchId) {
                                console.warn(`[InterTerminal] Unauthorized Access Attempt: Branch Mismatch. local=${myBranchId}, remote=${sourceBranchId}, ip=${req.socket.remoteAddress}`);
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Unauthorized: Branch mismatch' }));
                                return;
                            }

                            console.log(`[InterTerminal] Received forwarded order from ${data.source_terminal_id}`);

                            if (this.orderHandler) {
                                await this.orderHandler(data.orderData, data.source_terminal_id);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                const response: OrderForwardResponse = { success: true, order_id: data.orderData.id };
                                res.end(JSON.stringify(response));
                            } else {
                                console.warn('[InterTerminal] No order handler registered');
                                res.writeHead(503, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Service unavailable' }));
                            }
                        } catch (err: any) {
                            console.error('[InterTerminal] Error processing forwarded order:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: err.message }));
                        }
                    });
                } else if (req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', terminal_id: this.getTerminalId() }));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            this.httpServer.on('error', (err: any) => {
                console.error('[InterTerminal] HTTP Server error:', err);
                if (err.code === 'EADDRINUSE') {
                    console.error(`[InterTerminal] Port ${this.port} is already in use.`);
                    // Retry with incremented port? Or just fail?
                    // For now, fail but log heavily.
                }
            });

            this.httpServer.listen(this.port, () => {
                console.log(`[InterTerminal] HTTP Server listening on port ${this.port}`);
                this.isServerRunning = true;
                resolve();
            });
        });
    }

    public async forwardOrderToParent(orderData: any): Promise<OrderForwardResponse> {
        if (!this.parentTerminalInfo) {
            console.warn('[InterTerminal] Cannot forward order: No parent terminal connected');
            return { success: false, error: 'No parent terminal connected' };
        }

        // Use configurable timeout
        const requestTimeout = this.dbManager.getDatabaseService().settings.getParentConnectionRetryIntervalMs() || 5000;

        const payload: OrderForwardRequest = {
            orderData,
            source_terminal_id: this.getTerminalId(),
            timestamp: new Date().toISOString()
        };

        const data = JSON.stringify(payload);
        const secret = this.dbManager.getDatabaseService().settings.getInterTerminalSecret();
        const signature = this.generateSignature(data, secret);

        return new Promise((resolve) => {
            const options = {
                hostname: this.parentTerminalInfo!.ip_address,
                port: this.parentTerminalInfo!.port,
                path: '/api/orders/forward',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'x-terminal-signature': signature
                },
                timeout: requestTimeout // Configurable timeout
            };

            const req = http.request(options, (res) => {

                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(body);
                            this.lastReachable = true;
                            this.lastReachableTime = Date.now();
                            resolve(response);
                        } catch (e) {
                            resolve({ success: false, error: 'Invalid response from parent' });
                        }
                    } else {
                        // Might be reachable but erroring, or unreachable (503)
                        this.lastReachable = res.statusCode !== 503;
                        resolve({ success: false, error: `Parent returned ${res.statusCode}` });
                    }
                });
            });

            req.on('error', (err) => {
                console.error('[InterTerminal] Failed to forward order:', err);
                this.lastReachable = false;
                resolve({ success: false, error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                this.lastReachable = false;
                resolve({ success: false, error: 'Connection timed out' });
            });

            req.write(data);
            req.end();
        });
    }

    public getParentTerminalInfo(): TerminalDiscoveryInfo | null {
        return this.parentTerminalInfo;
    }

    public isParentReachableSync(): boolean {
        return this.lastReachable;
    }

    public async isParentReachable(): Promise<boolean> {
        if (!this.parentTerminalInfo) {
            this.lastReachable = false;
            return false;
        }

        const healthTimeout = this.dbManager.getDatabaseService().settings.getParentConnectionRetryIntervalMs() || 2000;
        return new Promise((resolve) => {
            const options = {
                hostname: this.parentTerminalInfo!.ip_address,
                port: this.parentTerminalInfo!.port,
                path: '/health',
                method: 'GET',
                timeout: healthTimeout
            };

            const req = http.request(options, (res) => {
                const reachable = res.statusCode === 200;
                this.lastReachable = reachable;
                if (reachable) this.lastReachableTime = Date.now();
                resolve(reachable);
            });

            req.on('error', () => {
                this.lastReachable = false;
                resolve(false);
            });
            req.on('timeout', () => {
                req.destroy();
                this.lastReachable = false;
                resolve(false);
            });
            req.end();
        });
    }

    public cleanup(): void {
        this.resetDiscovery(); // Use resetDiscovery for bonjour/discovery cleanup

        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
        this.isServerRunning = false;
    }
}
