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

            // Preconditions: all checkouts executed (no active shifts, cash drawers closed)
            const can = await db.reports.canExecuteZReport(reportDate);
            if (!can?.ok) {
                throw new IPCError(can?.reason || 'All checkouts must be executed before running the Z report.', 'VALIDATION_ERROR');
            }

            // Ensure online and drain sync queue
            if (sync && !sync.getNetworkStatus()) {
                throw new IPCError('POS is offline. Connect to the internet and retry the Z report.', 'NETWORK_ERROR');
            }

            // Re-queue any orphaned financial records before syncing
            try {
                const dbService = dbManager.getDatabaseService();
                const requeued = dbService.sync.requeueOrphanedFinancialRecords();
                if (requeued > 0) {
                    console.log(`[Z-Report] Re-queued ${requeued} orphaned financial records`);
                }
            } catch (e) {
                console.warn('[Z-Report] Failed to requeue orphaned records:', e);
            }

            try {
                await sync?.forceSyncAndWaitForEmpty(20000);
            } catch (e: any) {
                throw new IPCError(`Unable to flush pending sync before Z report: ${e?.message || String(e)}`, 'NETWORK_ERROR');
            }

            // Verify no finalized orders are left unsynced
            const unsynced = await db.reports.countUnsyncedFinalOrders(reportDate);
            if (unsynced > 0) {
                throw new IPCError(`There are ${unsynced} finalized orders not yet synced. Please retry.`, ErrorCodes.CONFLICT);
            }

            // Verify all financial transactions are synced
            const unsyncedFinancial = await db.reports.getUnsyncedFinancialSummary(reportDate);
            if (unsyncedFinancial.total > 0) {
                throw new IPCError(
                    `There are ${unsyncedFinancial.total} unsynced financial transactions. Driver earnings: ${unsyncedFinancial.driverEarnings}, Staff payments: ${unsyncedFinancial.staffPayments}, Expenses: ${unsyncedFinancial.shiftExpenses}. Please retry sync.`,
                    ErrorCodes.CONFLICT
                );
            }

            // Optional: Validate financial data integrity
            if (featureService && featureService.isFeatureEnabled('financialIntegrityCheck')) {
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
                apiKeyLength: apiKey.length,
                apiKeyLast4: apiKey ? apiKey.slice(-4) : 'NONE',
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
            if (termTypeNow === 'main' && validBranchId) {
                try {
                    // Fetch terminals in branch
                    const tRes = await fetch(`${adminBase}/api/pos/terminals?branchId=${encodeURIComponent(validBranchId)}`, {
                        method: 'GET',
                        headers,
                        signal: AbortSignal.timeout(15000)
                    });
                    if (tRes.ok) {
                        const tJson: any = await tRes.json();
                        const terms = Array.isArray(tJson?.terminals) ? tJson.terminals : [];
                        const children = terms.filter((t: any) => (t.parent_terminal_id === terminalId || t.parent_terminal_id === terminalId.trim()) && (t.terminal_type === 'mobile_waiter'));
                        childTerminalIds = children.map((c: any) => c.terminal_id);
                        const childReports: Array<{ terminalId: string; terminalName?: string; type?: string; report: any }> = [];
                        for (const child of children) {
                            try {
                                const r = await fetch(`${adminBase}/api/pos/z-report?terminal_id=${encodeURIComponent(child.terminal_id)}&report_date=${encodeURIComponent(reportDate)}`, {
                                    method: 'GET', headers, signal: AbortSignal.timeout(15000)
                                });
                                if (!r.ok) { console.warn('[Z-Report] Child report fetch failed', child.terminal_id, r.status); continue; }
                                const rJson: any = await r.json();
                                if (rJson?.report_data) {
                                    childReports.push({ terminalId: child.terminal_id, terminalName: child.name, type: child.terminal_type, report: rJson.report_data });
                                }
                            } catch (e) {
                                console.warn('[Z-Report] Failed to fetch child Z-report', child.terminal_id, (e as any)?.message);
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

            const res = await fetch(`${adminBase}/api/pos/z-report/submit`, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                let err: any = null;
                try { err = await res.json(); } catch { }
                throw new IPCError(err?.error || `HTTP ${res.status}`, 'NETWORK_ERROR');
            }

            // Print Z Report receipt for local record before cleanup
            // Skip printing for mobile_waiter as per requirement
            if (termTypeNow !== 'mobile_waiter') {
                try {
                    const terminalName = await db.settings.getSetting<string>('terminal', 'name', '');
                    const printer = new PrintService(db.settings);
                    await printer.printZReport(snapshot, terminalName || undefined);
                } catch (printErr) {
                    console.warn('Z report printing failed (fallback to console log only):', printErr);
                }
            }

            // Note: Cashiers must manually count and enter opening amounts each day - no automatic carry-forward from previous day's closing

            const json = await res.json().catch(() => ({}));

            // IMPORTANT: Store the Z-Report timestamp BEFORE finalizeEndOfDay
            // This prevents race condition where RealtimeOrderHandler might sync orders back
            // while finalizeEndOfDay is deleting them
            // Uses full ISO timestamp (not just date) because business days don't align with calendar days
            // e.g., a store closing at 5am - orders from 00:00-05:00 belong to previous business day
            const zReportTimestamp = new Date().toISOString();
            try {
                db.settings.setSetting('system', 'last_z_report_timestamp', zReportTimestamp);
                db.settings.setSetting('system', 'last_z_report_date', reportDate); // Keep date for reference
                console.log(`✅ Stored Z-Report timestamp: ${zReportTimestamp} (date: ${reportDate})`);
            } catch (e) {
                console.warn('Failed to store Z-Report timestamp:', e);
            }

            // Finalize end-of-day: clear daily data and logout current user
            // Now that timestamp is set, RealtimeOrderHandler will reject any old orders
            const cleanup = await db.reports.finalizeEndOfDay(reportDate);
            console.log(`✅ Z-Report finalized. Cleared: orders=${cleanup.orders ?? 0}, shifts=${cleanup.staff_shifts ?? 0}, drawers=${cleanup.cash_drawer_sessions ?? 0}`);

            try { await auth?.logout(); } catch (e) { console.error('Logout after Z report failed', e); }
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    // Notify that orders were cleared so UI can refresh
                    mainWindow.webContents.send('orders-cleared', { reason: 'z-report', cleared: cleanup });
                    mainWindow.webContents.send('logout-success', { reason: 'z-report' });
                }
            } catch { }

            try { sync?.startAutoSync(); } catch { }

            return { id: json?.id || null, cleanup };
        }, 'report:submit-z-report');
    });
}
