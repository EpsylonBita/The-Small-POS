import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError, IPCError, ErrorCodes } from '../utils/error-handler';
import { PrintService } from '../../services/PrintService';
import { generateZReportReceipt } from '../../templates/z-report-template';

export function registerReportHandlers() {
    // Today statistics
    ipcMain.handle('report:get-today-statistics', async (_e, { branchId }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            // Ensure reports service exists on db
            if (!db.reports) {
                throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            }
            return await db.reports.getTodayStatistics(branchId);
        }, 'report:get-today-statistics');
    });

    // Sales trend
    ipcMain.handle('report:get-sales-trend', async (_e, { branchId, days }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) {
                return []; // Maintain fallback behavior or throw? Original returned [] on error.
                // handleIPCError catches errors. 
                // Original: catch (err) { return []; }
                // Any error thrown inside handleIPCError will result in { success: false, error: ... }
                // If we want to return [] on error, we should trap it inside.
                // But "Standardize error handling" usually means returning errors properly.
                // Let's standardly throw errors if DB is missing.
                // If logic fails inside getSalesTrend, let it throw.
                throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            }
            return await db.reports.getSalesTrend(branchId, days);
        }, 'report:get-sales-trend');
    });

    // Top items
    ipcMain.handle('report:get-top-items', async (_e, { branchId, date, limit }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            return await db.reports.getTopItems(branchId, date, limit);
        }, 'report:get-top-items');
    });

    // Weekly top items for Featured/Selected category (last 7 days)
    ipcMain.handle('report:get-weekly-top-items', async (_e, { branchId, limit }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            return await db.reports.getWeeklyTopItems(branchId, limit || 20);
        }, 'report:get-weekly-top-items');
    });

    // Generate Z report
    ipcMain.handle('report:generate-z-report', async (_e, { branchId, date }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            const result = await db.reports.generateZReport(branchId, date);
            console.log('[report:generate-z-report] Returning cashDrawer:', result?.cashDrawer);
            return result;
        }, 'report:generate-z-report');
    });

    // Daily staff performance
    ipcMain.handle('report:get-daily-staff-performance', async (_e, { branchId, date }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');

            const results = await db.reports.getDailyStaffPerformance(branchId, date);
            // Ensure camelCase fields are used
            return results.map((r: any) => ({
                staffId: r.staffId,
                name: r.name,
                role: r.role,
                hours: r.hours,
                orders: r.orders,
                sales: r.sales,
                variance: r.variance,
                expenses: r.expenses,
                deliveries: r.deliveries
            }));
        }, 'report:get-daily-staff-performance');
    });

    // Hourly sales distribution
    ipcMain.handle('report:get-hourly-sales', async (_e, { branchId, date }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            return await db.reports.getHourlySales(branchId, date);
        }, 'report:get-hourly-sales');
    });

    // Payment method breakdown
    ipcMain.handle('report:get-payment-method-breakdown', async (_e, { branchId, date }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            return await db.reports.getPaymentMethodBreakdown(branchId, date);
        }, 'report:get-payment-method-breakdown');
    });

    // Order type breakdown
    ipcMain.handle('report:get-order-type-breakdown', async (_e, { branchId, date }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');
            return await db.reports.getOrderTypeBreakdown(branchId, date);
        }, 'report:get-order-type-breakdown');
    });

    // Submit Z report snapshot to Admin API and finalize end-of-day
    ipcMain.handle('report:submit-z-report', async (_e, { branchId, date }) => {
        return handleIPCError(async () => {
            // Step-by-step logging helper with elapsed time tracking
            const startTime = Date.now();
            const logStep = (step: number, msg: string) => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[Z-Report Submit] Step ${step}: ${msg} (${elapsed}s elapsed)`);
            };

            logStep(1, 'Starting Z-Report submission');

            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();
            const sync = serviceRegistry.syncService;
            const auth = serviceRegistry.authService;
            const featureService = serviceRegistry.featureService;
            const mainWindow = serviceRegistry.mainWindow;

            if (!db.reports) throw new IPCError('Reports service not initialized', 'SERVICE_UNAVAILABLE');

            const reportDate = (date && /\d{4}-\d{2}-\d{2}/.test(date)) ? date : new Date().toISOString().slice(0, 10);

            // Enforce feature flag: mobile/waiter terminals cannot execute Z-reports
            // Relaxed rule: Mobile waiters CAN submit Z-reports (which are just snapshots), but we might skip printing/cleanup logic below
            const termTypeNow = featureService?.getTerminalType?.() || 'main';
            if (featureService && !featureService.isFeatureEnabled('zReportExecution') && termTypeNow !== 'mobile_waiter') {
                console.warn('[report:submit-z-report] Blocked by feature flag', { terminalType: termTypeNow });
                throw new IPCError('Z-report execution is disabled for this terminal type. Only main POS terminals can execute Z-reports.', 'PERMISSION_DENIED');
            }

            logStep(2, 'Checking preconditions (canExecuteZReport)');
            // Preconditions: all checkouts executed (no active shifts, cash drawers closed)
            const can = await db.reports.canExecuteZReport(reportDate, branchId);
            if (!can?.ok) {
                throw new IPCError(can?.reason || 'All checkouts must be executed before running the Z report.', 'VALIDATION_ERROR');
            }

            logStep(3, 'Checking network status');
            // Ensure online and drain sync queue
            if (sync && !sync.getNetworkStatus()) {
                throw new IPCError('POS is offline. Connect to the internet and retry the Z report.', 'NETWORK_ERROR');
            }

            logStep(4, 'Re-queuing orphaned financial records');
            // Re-queue any orphaned financial records before syncing
            try {
                const dbService = dbManager.getDatabaseService();
                const requeued = dbService.sync.requeueOrphanedFinancialRecords();
                if (requeued > 0) {
                    console.log(`[Z-Report Submit] Re-queued ${requeued} orphaned financial records`);
                }
            } catch (e) {
                console.warn('[Z-Report Submit] Failed to requeue orphaned records:', e);
            }

            logStep(5, 'Draining sync queue (may take up to 20 seconds)');
            try {
                await sync?.forceSyncAndWaitForEmptyWithLogging(20000, logStep);
            } catch (e: any) {
                throw new IPCError(`Unable to flush pending sync before Z report: ${e?.message || String(e)}`, 'NETWORK_ERROR');
            }

            logStep(6, 'Verifying all orders are synced');
            // Verify no finalized orders are left unsynced
            const unsynced = await db.reports.countUnsyncedFinalOrders(reportDate);
            if (unsynced > 0) {
                throw new IPCError(
                    `${unsynced} finalized order${unsynced > 1 ? 's' : ''} not yet synced to cloud. Please wait for sync to complete or check your internet connection.`,
                    ErrorCodes.CONFLICT
                );
            }

            logStep(7, 'Verifying all financial transactions are synced');
            // Verify all financial transactions are synced
            const unsyncedFinancial = await db.reports.getUnsyncedFinancialSummary(reportDate);
            if (unsyncedFinancial.total > 0) {
                // Build detailed breakdown message
                const breakdown: string[] = [];
                if (unsyncedFinancial.driverEarnings > 0) {
                    breakdown.push(`${unsyncedFinancial.driverEarnings} driver earning${unsyncedFinancial.driverEarnings > 1 ? 's' : ''}`);
                }
                if (unsyncedFinancial.staffPayments > 0) {
                    breakdown.push(`${unsyncedFinancial.staffPayments} staff payment${unsyncedFinancial.staffPayments > 1 ? 's' : ''}`);
                }
                if (unsyncedFinancial.shiftExpenses > 0) {
                    breakdown.push(`${unsyncedFinancial.shiftExpenses} shift expense${unsyncedFinancial.shiftExpenses > 1 ? 's' : ''}`);
                }
                const breakdownStr = breakdown.join(', ');
                throw new IPCError(
                    `${unsyncedFinancial.total} unsynced financial transaction${unsyncedFinancial.total > 1 ? 's' : ''}: ${breakdownStr}. Please wait for sync to complete or check your internet connection.`,
                    ErrorCodes.CONFLICT
                );
            }

            // Optional: Validate financial data integrity
            if (featureService && featureService.isFeatureEnabled('financialIntegrityCheck')) {
                logStep(8, 'Validating financial data integrity');
                const integrityCheck = await db.reports.validateFinancialDataIntegrity(reportDate);
                if (!integrityCheck.valid) {
                    const discrepancyDetails = integrityCheck.discrepancies
                        .map((d: any) => `${d.table}: counts(l=${d.localCount},r=${d.remoteCount},d=${d.countDiff}); totals(l=${d.localTotal.toFixed(2)},r=${d.remoteTotal.toFixed(2)},d=${d.totalDiff.toFixed(2)})`)
                        .join('; ');
                    throw new IPCError(
                        `Financial data integrity check failed. Discrepancies: ${discrepancyDetails}. ${integrityCheck.errors.join('; ')}`,
                        'VALIDATION_ERROR'
                    );
                }
            }

            logStep(9, 'Generating Z-Report snapshot');
            let snapshot = await db.reports.generateZReport(branchId, reportDate);

            // Get admin URL from terminal settings first, then environment
            const adminUrlFromSettings = await db.settings.getSetting<string>('terminal', 'admin_dashboard_url', '');
            const adminBase = (adminUrlFromSettings || process.env.ADMIN_DASHBOARD_URL || 'http://localhost:3001').replace(/\/$/, '');

            // Log warning if using default localhost URL
            if (!adminUrlFromSettings && !process.env.ADMIN_DASHBOARD_URL) {
                console.warn('[report:submit-z-report] ADMIN_DASHBOARD_URL not configured, using default: http://localhost:3001');
            }

            const terminalId = (await db.settings.getSetting<string>('terminal', 'terminal_id', process.env.TERMINAL_ID || 'terminal-001')
                || process.env.TERMINAL_ID || 'terminal-001') as string;

            // IMPORTANT: Only use per-terminal API key from settings
            // Each terminal has its own unique API key for security
            const apiKey = ((await db.settings.getSetting<string>('terminal', 'pos_api_key', '')) || '') as string;

            // Debug logging for authentication
            console.log('🔑 [Z-Report] Auth debug:', {
                hasApiKey: !!apiKey,
                apiKeySource: 'terminal_settings',
                terminalId: terminalId,
                adminUrl: adminBase,
                terminalType: termTypeNow,
            });

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-terminal-id': terminalId
            };
            if (apiKey) headers['x-pos-api-key'] = apiKey;

            // Validate branch_id is a UUID before sending (skip local-branch)
            const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
            let validBranchId = branchId && isUuid(branchId) ? branchId : null;

            // If no valid branch_id from parameter, try to get from terminal settings
            if (!validBranchId) {
                const settingsBranchId = await db.settings.getSetting<string>('terminal', 'branch_id', '');
                if (settingsBranchId && isUuid(settingsBranchId)) {
                    validBranchId = settingsBranchId;
                }
            }

            // If main terminal, attempt to aggregate child terminals
            let childTerminalIds: string[] = [];
            let isAggregated = false;
            if (termTypeNow === 'main') {
                try {
                    // Fetch branch-scoped terminals via POS-auth endpoint
                    const tRes = await fetch(`${adminBase}/api/pos/terminals/list`, {
                        method: 'GET',
                        headers,
                        signal: AbortSignal.timeout(15000)
                    });
                    if (tRes.ok) {
                        const tJson: any = await tRes.json();
                        const terms = Array.isArray(tJson?.data?.terminals)
                            ? tJson.data.terminals
                            : (Array.isArray(tJson?.terminals) ? tJson.terminals : []);
                        const children = terms.filter((t: any) => {
                            const childId = t.terminal_id || t.id;
                            if (!childId) {return false;}
                            return (t.parent_terminal_id === terminalId || t.parent_terminal_id === terminalId.trim()) && (t.terminal_type === 'mobile_waiter');
                        });
                        childTerminalIds = children.map((c: any) => (c.terminal_id || c.id)).filter(Boolean);
                        const childReports: Array<{ terminalId: string; terminalName?: string; type?: string; report: any }> = [];
                        for (const child of children) {
                            const childTerminalId = child.terminal_id || child.id;
                            if (!childTerminalId) {continue;}
                            try {
                                const r = await fetch(`${adminBase}/api/pos/z-report?terminal_id=${encodeURIComponent(childTerminalId)}&report_date=${encodeURIComponent(reportDate)}`, {
                                    method: 'GET', headers, signal: AbortSignal.timeout(15000)
                                });
                                if (!r.ok) { console.warn('[Z-Report] Child report fetch failed', childTerminalId, r.status); continue; }
                                const rJson: any = await r.json();
                                if (rJson?.report_data) {
                                    childReports.push({ terminalId: childTerminalId, terminalName: child.name, type: child.terminal_type, report: rJson.report_data });
                                }
                            } catch (e) {
                                console.warn('[Z-Report] Failed to fetch child Z-report', childTerminalId, (e as any)?.message);
                            }
                        }
                        if (childReports.length > 0 && (db.reports as any)?.aggregateZReports) {
                            snapshot = (db.reports as any).aggregateZReports(
                                { terminalId, terminalName: await db.settings.getSetting<string>('terminal', 'name', '') || undefined, type: termTypeNow, report: snapshot },
                                childReports
                            );
                            isAggregated = true;
                        }
                    }
                } catch (e) {
                    console.warn('[Z-Report] Child aggregation skipped:', (e as any)?.message);
                }
            }

            const body = JSON.stringify({
                terminal_id: terminalId,
                branch_id: validBranchId,
                report_date: reportDate,
                report_data: snapshot,
                terminal_type: termTypeNow,
                child_terminal_ids: childTerminalIds,
                is_aggregated: isAggregated
            });

            logStep(10, `Submitting to Admin Dashboard (POST ${adminBase}/api/pos/z-report/submit)`);
            const res = await fetch(`${adminBase}/api/pos/z-report/submit`, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                let err: any = null;
                try { err = await res.json(); } catch { }
                console.log(`[Z-Report Submit] HTTP request failed: status=${res.status}`);
                throw new IPCError(err?.error || `HTTP ${res.status}`, 'NETWORK_ERROR');
            }
            console.log(`[Z-Report Submit] HTTP request successful: status=${res.status}`);

            // Parse response body for later use
            const json = await res.json().catch(() => ({}));

            logStep(11, 'Storing Z-Report timestamp (immediately after successful HTTP response)');
            // IMPORTANT: Store the Z-Report timestamp IMMEDIATELY after successful HTTP POST
            // This MUST happen BEFORE finalizeEndOfDay to prevent race conditions
            // where RealtimeOrderHandler might sync orders back while finalizeEndOfDay is deleting them
            // Uses full ISO timestamp (not just date) because business days don't align with calendar days
            // e.g., a store closing at 5am - orders from 00:00-05:00 belong to previous business day
            const zReportTimestamp = new Date().toISOString();
            try {
                db.settings.setSetting('system', 'last_z_report_timestamp', zReportTimestamp);
                db.settings.setSetting('system', 'last_z_report_date', reportDate); // Keep date for reference
                console.log(`[Z-Report Submit] ✅ Stored Z-Report timestamp: ${zReportTimestamp} (date: ${reportDate})`);
            } catch (e) {
                console.warn('[Z-Report Submit] Failed to store Z-Report timestamp:', e);
            }

            logStep(12, 'Printing Z-Report receipt');
            // Print Z Report receipt for local record before cleanup
            // Skip printing for mobile_waiter as per requirement
            if (termTypeNow !== 'mobile_waiter') {
                try {
                    const terminalName = await db.settings.getSetting<string>('terminal', 'name', '');
                    // Get PrinterManager from printer-manager-handlers module for proper printer routing
                    const { getPrinterManagerInstance } = require('../printer-manager-handlers');
                    const printer = new PrintService(db.settings);
                    const printerManager = getPrinterManagerInstance();
                    if (printerManager) {
                        printer.setPrinterManager(printerManager);
                        console.log('[Z-Report Submit] PrinterManager attached to PrintService');
                    } else {
                        console.log('[Z-Report Submit] No PrinterManager available, using direct printing');
                    }
                    await printer.printZReport(snapshot, terminalName || undefined);
                    console.log('[Z-Report Submit] Print completed successfully');
                } catch (printErr) {
                    console.warn('[Z-Report Submit] Printing failed (non-fatal):', printErr);
                }
            } else {
                console.log('[Z-Report Submit] Skipping print for mobile_waiter terminal');
            }

            // Note: Cashiers must manually count and enter opening amounts each day - no automatic carry-forward from previous day's closing

            logStep(13, 'Finalizing end-of-day (clearing orders, shifts, drawers)');
            // Finalize end-of-day: clear daily data and logout current user
            // Now that timestamp is set, RealtimeOrderHandler will reject any old orders
            console.log(`[Z-Report Submit] 🔄 BEFORE finalizeEndOfDay - about to clear data for date: ${reportDate}`);
            const cleanup = await db.reports.finalizeEndOfDay(reportDate);
            console.log(`[Z-Report Submit] ✅ AFTER finalizeEndOfDay - Cleanup result:`, {
                orders: cleanup.orders ?? 0,
                staff_shifts: cleanup.staff_shifts ?? 0,
                cash_drawer_sessions: cleanup.cash_drawer_sessions ?? 0,
                driver_earnings: cleanup.driver_earnings ?? 0,
                shift_expenses: cleanup.shift_expenses ?? 0,
                staff_payments: cleanup.staff_payments ?? 0,
                payment_transactions: cleanup.payment_transactions ?? 0,
                sync_queue: cleanup.sync_queue ?? 0
            });

            logStep(14, 'Logging out user and notifying UI');
            try { await auth?.logout(); } catch (e) { console.error('[Z-Report Submit] Logout after Z report failed', e); }
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    // Notify that orders were cleared so UI can refresh
                    mainWindow.webContents.send('orders-cleared', { reason: 'z-report', cleared: cleanup });
                    mainWindow.webContents.send('logout-success', { reason: 'z-report' });
                }
            } catch { }

            try { sync?.startAutoSync(); } catch { }

            const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Z-Report Submit] ✅ Complete! Total time: ${totalElapsed}s`);

            return { id: json?.id || null, cleanup };
        }, 'report:submit-z-report');
    });
}
