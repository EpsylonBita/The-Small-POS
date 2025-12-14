import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError, IPCError } from '../utils/error-handler';
import type { RecordStaffPaymentParams, RecordStaffPaymentResponse, StaffPayment } from '../../../renderer/types/shift';

export function registerShiftHandlers(): void {
    // Handler: shift:open
    ipcMain.handle('shift:open', async (_event, params: {
        staffId: string;
        branchId: string;
        terminalId: string;
        roleType: 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
        openingCash?: number;
        startingAmount?: number; // Optional starting amount for drivers
    }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }

            console.log('Opening shift with params:', params);
            const result = await db.staff.openShift(params);
            console.log('Open shift result:', result);
            return result;
        }, 'shift:open');
    });

    // Handler: shift:close
    /**
     * Close a shift with optional payment amount for driver wage recording
     * @param params.paymentAmount - Optional payment amount used for driver wage recording during checkout
     */
    ipcMain.handle('shift:close', async (_event, params: {
        shiftId: string;
        closingCash: number;
        closedBy: string;
        /** Optional payment amount for driver wage recording during checkout */
        paymentAmount?: number;
    }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const result = await db.staff.closeShift(params);
            return result;
        }, 'shift:close');
    });

    // Handler: shift:get-active
    ipcMain.handle('shift:get-active', async (_event, staffId: string) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            console.log('Getting active shift for staffId:', staffId);
            const shift = await db.staff.getActiveShift(staffId);
            console.log('Active shift result:', shift);
            return shift;
        }, 'shift:get-active');
    });

    // Handler: shift:get-active-by-terminal
    ipcMain.handle('shift:get-active-by-terminal', async (_event, branchId: string, terminalId: string) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            console.log('Getting active shift for branch/terminal:', { branchId, terminalId });
            const shift = await (db.staff as any).getActiveShiftByTerminal(branchId, terminalId);
            console.log('Active shift by terminal result:', shift);
            return shift;
        }, 'shift:get-active-by-terminal');
    });

    // Handler: shift:get-active-cashier-by-terminal
    ipcMain.handle('shift:get-active-cashier-by-terminal', async (_event, branchId: string, terminalId: string) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            console.log('Getting active cashier shift for branch/terminal:', { branchId, terminalId });
            const shift = await (db.staff as any).getActiveCashierShiftByTerminal(branchId, terminalId);
            console.log('Active cashier shift by terminal result:', shift);
            return shift;
        }, 'shift:get-active-cashier-by-terminal');
    });


    // Handler: shift:get-active-by-terminal-loose (terminal only)
    ipcMain.handle('shift:get-active-by-terminal-loose', async (_event, terminalId: string) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const shift = await db.staff.getActiveShiftByTerminalLoose(terminalId);
            console.log('Active shift by terminal (loose) result:', shift);
            return shift;
        }, 'shift:get-active-by-terminal-loose');
    });

    // Handler: shift:get-all-active (debugging utility)
    ipcMain.handle('shift:get-all-active', async () => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const shifts = db.staff.getAllActiveShifts();
            console.log(`Found ${shifts.length} active shifts locally`);
            return shifts;
        }, 'shift:get-all-active');
    });

    // Handler: shift:close-all-active (cleanup utility)
    ipcMain.handle('shift:close-all-active', async () => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const result = db.staff.closeAllActiveShifts();
            console.log(`Closed ${result.closed} active shifts`);
            return result;
        }, 'shift:close-all-active');
    });



    // Handler: shift:get-summary
    /**
     * Get shift summary with optional configuration
     * @param shiftId The shift ID to get summary for
     * @param options Optional configuration
     * @param options.skipBackfill If true, skips driver earnings backfill (faster for non-checkout reads)
     */
    ipcMain.handle('shift:get-summary', async (_event, shiftId: string, options?: { skipBackfill?: boolean }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const summary = await db.staff.getShiftSummary(shiftId, options);
            return summary;
        }, 'shift:get-summary');
    });

    // Handler: shift:record-expense
    ipcMain.handle('shift:record-expense', async (_event, params: {
        shiftId: string;
        staffId: string;
        branchId: string;
        expenseType: string;
        amount: number;
        description: string;
        receiptNumber?: string;
    }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const result = await db.staff.recordExpense(params);
            return result;
        }, 'shift:record-expense');
    });

    // Handler: shift:get-expenses
    ipcMain.handle('shift:get-expenses', async (_event, shiftId: string) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const expenses = await db.staff.getShiftExpenses(shiftId);
            return expenses;
        }, 'shift:get-expenses');
    });

    // Handler: shift:record-staff-payment
    /**
     * Record a staff payment from the cashier's drawer
     * Uses RecordStaffPaymentParams type for input and RecordStaffPaymentResponse for output
     */
    ipcMain.handle('shift:record-staff-payment', async (_event, params: RecordStaffPaymentParams): Promise<any> => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const result = await db.staff.recordStaffPayment(params);
            return result;
        }, 'shift:record-staff-payment');
    });

    // Handler: shift:get-staff-payments
    /**
     * Get all staff payments recorded by a specific cashier shift
     * Returns array of StaffPayment records
     */
    ipcMain.handle('shift:get-staff-payments', async (_event, cashierShiftId: string): Promise<any> => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const payments = await db.staff.getStaffPayments(cashierShiftId);
            return payments;
        }, 'shift:get-staff-payments');
    });

    // Handler: shift:get-staff-payments-by-staff
    /**
     * Get all payments made to a specific staff member within a date range
     */
    ipcMain.handle('shift:get-staff-payments-by-staff', async (_event, params: {
        staffId: string;
        dateFrom?: string;
        dateTo?: string;
    }): Promise<any> => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const payments = await db.staff.getStaffPaymentsByStaffAndDate(params);
            return payments;
        }, 'shift:get-staff-payments-by-staff');
    });

    // Handler: shift:get-staff-payment-total-for-date
    /**
     * Calculate total payments made to a staff member for a specific date
     */
    ipcMain.handle('shift:get-staff-payment-total-for-date', async (_event, staffId: string, date: string): Promise<any> => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const total = await db.staff.getStaffPaymentTotalForDate(staffId, date);
            return total;
        }, 'shift:get-staff-payment-total-for-date');
    });

    // Debug handler: get all shifts
    ipcMain.handle('shift:get-all-debug', async () => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }
            const rawDb = (dbManager as any).db;
            if (!rawDb) {
                throw new IPCError('Raw database not available', 'DATABASE_ERROR');
            }
            const stmt = rawDb.prepare('SELECT * FROM staff_shifts ORDER BY check_in_time DESC LIMIT 10');
            const shifts = stmt.all();
            console.log('All shifts in database:', shifts);
            return shifts;
        }, 'shift:get-all-debug');
    });

    // Maintenance handler: backfill driver earnings for a specific shift or date range
    /**
     * Manually trigger driver earnings backfill for maintenance purposes.
     * This allows admins to run backfill outside of interactive UI paths.
     * @param params.shiftId - Optional specific shift ID to backfill
     * @param params.date - Optional date string (YYYY-MM-DD) to backfill all driver shifts for that day
     * @returns Object with success status and count of shifts processed
     */
    ipcMain.handle('shift:backfill-driver-earnings', async (_event, params: { shiftId?: string; date?: string }) => {
        return handleIPCError(async () => {
            const dbManager = serviceRegistry.requireService('dbManager');
            const db = dbManager.getDatabaseService();

            if (!db.staff) {
                throw new IPCError('Staff service not initialized', 'SERVICE_UNAVAILABLE');
            }

            const rawDb = (dbManager as any).db;
            if (!rawDb) {
                throw new IPCError('Raw database not available', 'DATABASE_ERROR');
            }

            let shiftsToProcess: any[] = [];

            if (params.shiftId) {
                // Backfill specific shift
                const shift = rawDb.prepare('SELECT * FROM staff_shifts WHERE id = ? AND role_type = ?').get(params.shiftId, 'driver');
                if (shift) {
                    shiftsToProcess = [shift];
                } else {
                    throw new IPCError('Driver shift not found', 'NOT_FOUND');
                }
            } else if (params.date) {
                // Backfill all driver shifts for a specific date
                const stmt = rawDb.prepare(`
          SELECT * FROM staff_shifts
          WHERE role_type = 'driver'
            AND date(check_in_time) = ?
          ORDER BY check_in_time ASC
        `);
                shiftsToProcess = stmt.all(params.date) as any[];
            } else {
                throw new IPCError('Either shiftId or date must be provided', 'VALIDATION_ERROR');
            }

            if (shiftsToProcess.length === 0) {
                return { message: 'No driver shifts found to process', processed: 0 };
            }

            // Process each shift by calling getShiftSummary without skipBackfill
            // This triggers the backfillDriverEarnings method internally
            let processed = 0;
            for (const shift of shiftsToProcess) {
                try {
                    // Call getShiftSummary without skipBackfill to trigger backfill
                    await db.staff.getShiftSummary(shift.id, { skipBackfill: false });
                    processed++;
                } catch (e) {
                    console.warn(`[shift:backfill-driver-earnings] Failed to backfill shift ${shift.id}:`, e);
                }
            }

            console.log(`[shift:backfill-driver-earnings] Processed ${processed}/${shiftsToProcess.length} driver shifts`);
            return {
                message: `Backfilled ${processed} driver shift(s)`,
                processed,
                total: shiftsToProcess.length
            };
        }, 'shift:backfill-driver-earnings');
    });
}
