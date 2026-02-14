import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError, IPCError } from '../utils/error-handler';
import type { RecordStaffPaymentParams, RecordStaffPaymentResponse, StaffPayment } from '../../../renderer/types/shift';
import { getSupabaseClient, SUPABASE_CONFIG } from '../../../shared/supabase-config';

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

    // Handler: shift:list-staff-for-checkin
    /**
     * List staff members available for check-in at a specific branch
     * This runs in the main process where Supabase config is available
     */
    ipcMain.handle('shift:list-staff-for-checkin', async (_event, branchId: string) => {
        return handleIPCError(async () => {
            const supabaseUrl = SUPABASE_CONFIG.url;
            const supabaseKey = SUPABASE_CONFIG.anonKey;

            console.log('[shift:list-staff-for-checkin] Supabase config:', {
                url: supabaseUrl?.substring(0, 30) + '...',
                hasKey: !!supabaseKey,
                branchId
            });

            if (!supabaseUrl || !supabaseKey) {
                throw new IPCError('Supabase configuration missing', 'SERVICE_UNAVAILABLE');
            }

            if (!branchId) {
                throw new IPCError('Branch ID is required', 'VALIDATION_ERROR');
            }

            // Call the RPC function to list staff for check-in
            const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_list_staff_for_checkin`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ p_branch_id: branchId })
            });

            if (!rpcRes.ok) {
                const txt = await rpcRes.text();
                throw new IPCError(`Failed to fetch staff: ${rpcRes.status} ${rpcRes.statusText} - ${txt}`, 'NETWORK_ERROR');
            }

            const data = await rpcRes.json();
            console.log('[shift:list-staff-for-checkin] Fetched', data?.length || 0, 'staff members');

            // Map to consistent format
            const staffList = (data || []).map((s: any) => ({
                id: s.id,
                name: (s.name || `${s.first_name ?? ''} ${s.last_name ?? ''}` || 'Staff').trim(),
                first_name: s.first_name,
                last_name: s.last_name,
                email: s.email,
                role_id: s.role_id,
                role_name: s.role_name || s.roles?.name || 'staff',
                role_display_name: s.role_display_name || s.roles?.display_name || 'Staff',
                roles: Array.isArray(s.roles)
                    ? s.roles.map((role: any) => ({
                        role_id: role?.role_id || role?.id || s.role_id,
                        role_name: role?.role_name || role?.name || s.role_name || 'staff',
                        role_display_name: role?.role_display_name || role?.display_name || s.role_display_name || 'Staff',
                        role_color: role?.role_color || role?.color || '#6B7280',
                        is_primary: !!role?.is_primary
                    }))
                    : [], // Will be loaded separately when absent
                can_login_pos: (s.can_login_pos ?? true),
                is_active: (s.is_active ?? true),
                hourly_rate: s.hourly_rate
            }));

            return staffList;
        }, 'shift:list-staff-for-checkin');
    });

    // Handler: shift:get-staff-roles
    /**
     * Get all roles for a list of staff members
     * This runs in the main process where Supabase config is available
     */
    ipcMain.handle('shift:get-staff-roles', async (_event, staffIds: string[]) => {
        return handleIPCError(async () => {
            const supabaseUrl = SUPABASE_CONFIG.url;
            const supabaseKey = SUPABASE_CONFIG.anonKey;
            const settingsService = serviceRegistry.get('settingsService');
            const organizationId = (settingsService?.getSetting<string>('terminal', 'organization_id', '') || '').trim();
            const branchId = (settingsService?.getSetting<string>('terminal', 'branch_id', '') || '').trim();

            if (!supabaseUrl || !supabaseKey) {
                throw new IPCError('Supabase configuration missing', 'SERVICE_UNAVAILABLE');
            }

            if (!staffIds || staffIds.length === 0) {
                return {};
            }

            const scopedHeaders: Record<string, string> = {};
            if (organizationId) scopedHeaders['x-organization-id'] = organizationId;
            if (branchId) scopedHeaders['x-branch-id'] = branchId;

            // First, fetch all roles for lookup
            const rolesLookupUrl = `${supabaseUrl}/rest/v1/roles?select=id,name,display_name,color&is_active=eq.true`;
            const rolesLookupRes = await fetch(rolesLookupUrl, {
                method: 'GET',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    ...scopedHeaders
                }
            });

            const rolesMap = new Map<string, { name: string; display_name: string; color: string }>();
            if (rolesLookupRes.ok) {
                const allRoles = await rolesLookupRes.json();
                allRoles.forEach((r: any) => {
                    rolesMap.set(r.id, {
                        name: r.name || 'staff',
                        display_name: r.display_name || 'Staff',
                        color: r.color || '#6B7280'
                    });
                });
            }

            const rolesByStaff: Record<string, any[]> = {};
            let rolesData: any[] = [];

            // Prefer SECURITY DEFINER RPC for stable multi-role access across RLS variants.
            const rolesRpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_get_staff_roles_by_ids`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    ...scopedHeaders
                },
                body: JSON.stringify({ p_staff_ids: staffIds })
            });

            if (rolesRpcRes.ok) {
                rolesData = await rolesRpcRes.json();
                console.log('[shift:get-staff-roles] RPC returned role rows:', rolesData.length);
            } else {
                const rpcErr = await rolesRpcRes.text().catch(() => '');
                console.warn('[shift:get-staff-roles] RPC unavailable, falling back to direct staff_roles query', {
                    status: rolesRpcRes.status,
                    rpcErr
                });

                // Fallback for environments where the RPC migration is not applied yet.
                const fetchUrl = `${supabaseUrl}/rest/v1/staff_roles?staff_id=in.(${staffIds.join(',')})&select=staff_id,role_id,is_primary`;
                const rolesRes = await fetch(fetchUrl, {
                    method: 'GET',
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json',
                        ...scopedHeaders
                    }
                });

                if (rolesRes.ok) {
                    rolesData = await rolesRes.json();
                    console.log('[shift:get-staff-roles] Fallback returned role rows:', rolesData.length);
                } else {
                    const fallbackErr = await rolesRes.text().catch(() => '');
                    console.warn('[shift:get-staff-roles] Fallback staff_roles query failed', {
                        status: rolesRes.status,
                        fallbackErr
                    });
                }
            }

            rolesData.forEach((sr: any) => {
                if (!rolesByStaff[sr.staff_id]) {
                    rolesByStaff[sr.staff_id] = [];
                }

                const roleDetails = rolesMap.get(sr.role_id);
                const normalizedRole = {
                    role_id: sr.role_id,
                    role_name: sr.role_name || roleDetails?.name || 'staff',
                    role_display_name: sr.role_display_name || roleDetails?.display_name || 'Staff',
                    role_color: sr.role_color || roleDetails?.color || '#6B7280',
                    is_primary: sr.is_primary || false
                };

                const alreadyExists = rolesByStaff[sr.staff_id].some((existing) => existing.role_id === normalizedRole.role_id);
                if (!alreadyExists) {
                    rolesByStaff[sr.staff_id].push(normalizedRole);
                }
            });

            return rolesByStaff;
        }, 'shift:get-staff-roles');
    });

    // Handler: shift:get-scheduled-shifts
    /**
     * Fetch scheduled shifts from admin dashboard (salon_staff_shifts table)
     * This syncs the pre-planned schedules from admin dashboard to POS
     */
    ipcMain.handle('shift:get-scheduled-shifts', async (_event, params: {
        branchId: string;
        startDate: string;  // ISO date string
        endDate: string;    // ISO date string
        staffId?: string;   // Optional filter by staff
    }) => {
        return handleIPCError(async () => {
            const supabaseUrl = SUPABASE_CONFIG.url;
            const supabaseKey = SUPABASE_CONFIG.anonKey;

            if (!supabaseUrl || !supabaseKey) {
                throw new IPCError('Supabase configuration missing', 'SERVICE_UNAVAILABLE');
            }

            if (!params.branchId) {
                throw new IPCError('Branch ID is required', 'VALIDATION_ERROR');
            }

            console.log('[shift:get-scheduled-shifts] Fetching scheduled shifts:', {
                branchId: params.branchId,
                startDate: params.startDate,
                endDate: params.endDate,
                staffId: params.staffId
            });

            // Build query for salon_staff_shifts with staff details
            let query = `${supabaseUrl}/rest/v1/salon_staff_shifts?select=id,staff_id,branch_id,start_time,end_time,break_start,break_end,status,notes,staff(id,first_name,last_name,staff_code)&branch_id=eq.${params.branchId}&start_time=gte.${params.startDate}&start_time=lte.${params.endDate}`;

            if (params.staffId) {
                query += `&staff_id=eq.${params.staffId}`;
            }

            const response = await fetch(query, {
                method: 'GET',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                const txt = await response.text();
                throw new IPCError(`Failed to fetch scheduled shifts: ${response.status} ${response.statusText} - ${txt}`, 'NETWORK_ERROR');
            }

            const data = await response.json();
            console.log('[shift:get-scheduled-shifts] Fetched', data?.length || 0, 'scheduled shifts');

            // Map to consistent format for POS
            const scheduledShifts = (data || []).map((shift: any) => ({
                id: shift.id,
                staffId: shift.staff_id,
                branchId: shift.branch_id,
                startTime: shift.start_time,
                endTime: shift.end_time,
                breakStart: shift.break_start,
                breakEnd: shift.break_end,
                status: shift.status,
                notes: shift.notes,
                staffName: shift.staff ? `${shift.staff.first_name || ''} ${shift.staff.last_name || ''}`.trim() : 'Unknown',
                staffCode: shift.staff?.staff_code || ''
            }));

            return scheduledShifts;
        }, 'shift:get-scheduled-shifts');
    });

    // Handler: shift:get-today-scheduled-shifts
    /**
     * Get scheduled shifts for today for a specific branch
     * Convenience handler for quick access to today's schedule
     */
    ipcMain.handle('shift:get-today-scheduled-shifts', async (_event, branchId: string) => {
        return handleIPCError(async () => {
            const supabaseUrl = SUPABASE_CONFIG.url;
            const supabaseKey = SUPABASE_CONFIG.anonKey;

            if (!supabaseUrl || !supabaseKey) {
                throw new IPCError('Supabase configuration missing', 'SERVICE_UNAVAILABLE');
            }

            if (!branchId) {
                throw new IPCError('Branch ID is required', 'VALIDATION_ERROR');
            }

            // Calculate today's date range
            const today = new Date();
            const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
            const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();

            console.log('[shift:get-today-scheduled-shifts] Fetching today\'s shifts:', {
                branchId,
                startOfDay,
                endOfDay
            });

            const query = `${supabaseUrl}/rest/v1/salon_staff_shifts?select=id,staff_id,branch_id,start_time,end_time,break_start,break_end,status,notes,staff(id,first_name,last_name,staff_code)&branch_id=eq.${branchId}&start_time=gte.${startOfDay}&start_time=lte.${endOfDay}&order=start_time.asc`;

            const response = await fetch(query, {
                method: 'GET',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                const txt = await response.text();
                throw new IPCError(`Failed to fetch today's scheduled shifts: ${response.status} ${response.statusText} - ${txt}`, 'NETWORK_ERROR');
            }

            const data = await response.json();
            console.log('[shift:get-today-scheduled-shifts] Fetched', data?.length || 0, 'scheduled shifts for today');

            // Map to consistent format
            return (data || []).map((shift: any) => ({
                id: shift.id,
                staffId: shift.staff_id,
                branchId: shift.branch_id,
                startTime: shift.start_time,
                endTime: shift.end_time,
                breakStart: shift.break_start,
                breakEnd: shift.break_end,
                status: shift.status,
                notes: shift.notes,
                staffName: shift.staff ? `${shift.staff.first_name || ''} ${shift.staff.last_name || ''}`.trim() : 'Unknown',
                staffCode: shift.staff?.staff_code || ''
            }));
        }, 'shift:get-today-scheduled-shifts');
    });
}
