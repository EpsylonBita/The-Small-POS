import { DatabaseManager, SyncQueue } from '../../database';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BrowserWindow } from 'electron';
import { mapStatusForSupabase } from '../../../shared/types/order-status';
import { getSupabaseConfig } from '../../../shared/supabase-config';
import { InterTerminalCommunicationService } from './InterTerminalCommunicationService';
import { FeatureService } from '../FeatureService';
import { deriveOrderFinancials } from '../OrderService';
import * as crypto from 'crypto';

// Service role client for order operations (bypasses RLS)
let serviceRoleClient: SupabaseClient | null = null;

function getServiceRoleClient(): SupabaseClient | null {
    if (!serviceRoleClient) {
        const config = getSupabaseConfig('server');
        if (config.serviceRoleKey) {
            serviceRoleClient = createClient(config.url, config.serviceRoleKey, {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false,
                },
            });
        } else {
            console.warn('[OrderSyncService] Service role key not available, order sync may fail RLS');
        }
    }
    return serviceRoleClient;
}

export class OrderSyncService {
    private organizationId: string | null = null;
    private interTerminalService: InterTerminalCommunicationService | null = null;
    private featureService: FeatureService | null = null;

    constructor(
        private dbManager: DatabaseManager,
        private supabase: SupabaseClient,
        private terminalId: string
    ) { }

    /**
     * Get the Supabase client for order operations.
     * Prefers service role client for RLS bypass, falls back to anon client.
     */
    private getOrderClient(): SupabaseClient {
        return getServiceRoleClient() || this.supabase;
    }

    /**
     * Set the organization ID for RLS compliance.
     * This must be called after terminal settings are loaded.
     */
    public setOrganizationId(orgId: string | null): void {
        this.organizationId = orgId;
    }

    /**
     * Get the current organization ID
     */
    public getOrganizationId(): string | null {
        // Try to get from instance first, then fall back to settings
        if (this.organizationId) return this.organizationId;
        try {
            const dbSvc = this.dbManager.getDatabaseService();
            return (dbSvc.settings.getSetting('terminal', 'organization_id', null) as string | null) ?? null;
        } catch {
            return null;
        }
    }

    private mainWindow: BrowserWindow | null = null;

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public setInterTerminalService(service: InterTerminalCommunicationService): void {
        this.interTerminalService = service;
        // Register this service to handle orders received from other terminals
        service.setOrderHandler(this.handleForwardedOrder.bind(this));
    }

    public setFeatureService(service: FeatureService): void {
        this.featureService = service;
    }

    public async backfillMissingOrdersQueue(): Promise<void> {
        try {
            const localOrders = await this.dbManager.getAllOrders();
            const queue = await this.dbManager.getSyncQueue();
            const queuedOrderIds = new Set(
                queue
                    .filter((i: any) => i.table_name === 'orders')
                    .map((i: any) => i.record_id)
            );

            // Resolve terminal/branch/organization once for this backfill pass
            const dbSvc = this.dbManager.getDatabaseService();
            const rawTerminalId = (dbSvc.settings.getSetting('terminal', 'terminal_id', this.terminalId) as string) || this.terminalId || null;
            const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
            const terminalId = isUuid(rawTerminalId) ? rawTerminalId : null;
            const branchId = (dbSvc.settings.getSetting('terminal', 'branch_id', null) as string | null) ?? null;
            const organizationId = this.getOrganizationId();

            for (const o of localOrders) {
                if (!o.supabase_id && !queuedOrderIds.has(o.id)) {
                    // Use the low-level SyncService directly with lowercase 'insert' to satisfy CHECK constraint
                    const syncSvc = dbSvc.sync || this.dbManager.sync;
                    // Get financial breakdown - use explicit values if available, otherwise derive
                    const backfillFinancials = deriveOrderFinancials(
                        o.total_amount,
                        o.order_type,
                        o.discount_amount ?? 0,
                        {
                            subtotal: (o as any).subtotal,
                            tax_amount: (o as any).tax_amount,
                            tax_rate: (o as any).tax_rate,
                            delivery_fee: (o as any).delivery_fee
                        }
                    );

                    syncSvc.addToSyncQueue('orders', o.id, 'insert', {
                        organization_id: organizationId,
                        order_number: o.order_number,
                        customer_name: o.customer_name ?? null,
                        customer_email: o.customer_email ?? null,
                        customer_phone: o.customer_phone ?? null,
                        order_type: o.order_type ?? 'takeaway',
                        status: o.status,
                        // Financial fields - use explicit values if provided, otherwise derived
                        total_amount: o.total_amount,
                        tax_amount: backfillFinancials.tax_amount,
                        subtotal: backfillFinancials.subtotal,
                        discount_amount: o.discount_amount ?? 0,
                        delivery_fee: backfillFinancials.delivery_fee,
                        payment_status: o.payment_status ?? 'pending',
                        payment_method: o.payment_method ?? null,
                        notes: o.special_instructions ?? null,
                        // Delivery address fields - all six fields for complete address sync
                        delivery_address: (o as any).delivery_address ?? null,
                        delivery_city: (o as any).delivery_city ?? null,
                        delivery_postal_code: (o as any).delivery_postal_code ?? null,
                        delivery_floor: (o as any).delivery_floor ?? null,
                        delivery_notes: (o as any).delivery_notes ?? null,
                        name_on_ringer: (o as any).name_on_ringer ?? null,
                        table_number: o.table_number ?? null,
                        estimated_ready_time: o.estimated_time ?? null,
                        terminal_id: terminalId,
                        branch_id: branchId,
                        driver_id: (o as any).driver_id ?? null,
                        created_at: o.created_at,
                        updated_at: o.updated_at
                    });
                }
            }
        } catch (err) {
            console.warn('Backfill enqueue failed:', err);
        }
    }

    public async syncOrder(operation: string, recordId: string, data: any): Promise<void> {
        switch (operation) {
            case 'insert':
                await this.handleInsert(recordId, data);
                break;
            case 'update':
                await this.handleUpdate(recordId, data);
                break;
        }
    }

    private async handleInsert(recordId: string, data: any): Promise<void> {
        // Insert/update order in Supabase with idempotency via client_order_id.
        // Use local recordId as the stable client_order_id so restarts do not duplicate.
        // Get financial breakdown - use explicit values if provided, otherwise derive
        const insertFinancials = deriveOrderFinancials(
            data.total_amount,
            data.order_type,
            data.discount_amount || 0,
            {
                subtotal: data.subtotal,
                tax_amount: data.tax_amount,
                tax_rate: data.tax_rate,
                delivery_fee: data.delivery_fee
            }
        );
        const taxAmount = insertFinancials.tax_amount;
        const discountAmount = data.discount_amount || 0;
        const subtotal = insertFinancials.subtotal;
        const deliveryFee = insertFinancials.delivery_fee;

        // HYBRID SYNC: Check if valid mobile waiter and route to parent if possible
        let routedViaParent = false;
        let routingError = null;

        if (this.featureService?.isMobileWaiter() && this.interTerminalService) {
            try {
                if (await this.interTerminalService.isParentReachable()) {
                    const result = await this.interTerminalService.forwardOrderToParent(data);

                    if (result.success) {
                        routedViaParent = true;

                        // Update local order routing metadata (if columns exist)
                        try {
                            const db = this.dbManager.db;
                            const stmt = db.prepare(
                                "UPDATE orders SET routing_path = ?, forwarded_at = ? WHERE id = ?"
                            );
                            stmt.run('via_parent', new Date().toISOString(), recordId);
                        } catch (e) {
                            // Columns might not exist yet
                        }

                        // Emit event for UI
                        if (this.mainWindow) {
                            this.mainWindow.webContents.send('order-sync-route-changed', {
                                orderId: recordId,
                                route: 'via_parent',
                                timestamp: Date.now()
                            });
                        }
                    } else {
                        console.warn('[OrderSyncService] ⚠️ Forwarding failed:', result.error);
                        routingError = result.error;
                    }
                } else {
                    // Parent unreachable, falling back to direct cloud sync
                }
            } catch (err) {
                console.error('[OrderSyncService] Error during routing:', err);
            }

            if (!routedViaParent) {
                // Update routing status to direct (fallback)
                if (this.mainWindow) {
                    this.mainWindow.webContents.send('order-sync-route-changed', {
                        orderId: recordId,
                        route: 'direct_cloud',
                        timestamp: Date.now()
                    });
                }
            }
        }

        // Always sync to supabase as well (backup/primary depending on role)
        // If forwarded, it serves as backup. If not forwarded, it's the primary path.

        // Get organization_id - required for RLS
        const organizationId = data.organization_id || this.getOrganizationId();
        if (!organizationId) {
            console.error('[OrderSyncService] ❌ Cannot insert order: organization_id is required for RLS');
            throw new Error('Cannot insert order: organization_id is required');
        }

        // Sanitize UUID fields
        const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
        const branchId = isUuid(data.branch_id) ? data.branch_id : null;
        const terminalId = isUuid(data.terminal_id) ? data.terminal_id : null;

        // Parse estimated_ready_time as INTEGER (minutes) - database column is INTEGER
        let estimatedReadyTimeMinutes: number | null = null;
        if (data.estimated_ready_time != null) {
            if (typeof data.estimated_ready_time === 'number') {
                estimatedReadyTimeMinutes = data.estimated_ready_time;
            } else if (typeof data.estimated_ready_time === 'string') {
                if (/^\d+$/.test(data.estimated_ready_time)) {
                    estimatedReadyTimeMinutes = parseInt(data.estimated_ready_time, 10);
                }
                // Ignore ISO strings - can't convert back to minutes reliably
            }
        }

        // Parse table_number as INTEGER - database column is INTEGER
        let tableNumberInt: number | null = null;
        if (data.table_number != null) {
            if (typeof data.table_number === 'number') {
                tableNumberInt = data.table_number;
            } else if (typeof data.table_number === 'string' && /^\d+$/.test(data.table_number)) {
                tableNumberInt = parseInt(data.table_number, 10);
            }
        }

        // Try SECURITY DEFINER RPC function first (bypasses RLS)
        const { data: rpcResult, error: rpcError } = await this.supabase.rpc('pos_upsert_order', {
            p_client_order_id: recordId,
            p_organization_id: organizationId,
            p_order_number: data.order_number || null,
            p_customer_name: data.customer_name || null,
            p_customer_email: data.customer_email || null,
            p_customer_phone: data.customer_phone || null,
            p_order_type: data.order_type || 'takeaway',
            p_status: mapStatusForSupabase(data.status as any),
            p_subtotal: subtotal,
            p_total_amount: data.total_amount,
            p_tax_amount: taxAmount,
            p_discount_amount: discountAmount || 0,
            p_payment_status: data.payment_status || 'pending',
            p_payment_method: data.payment_method || null,
            p_special_instructions: data.special_instructions || data.notes || null,
            // Delivery address fields
            p_delivery_address: data.delivery_address || null,
            p_delivery_city: data.delivery_city || null,
            p_delivery_postal_code: data.delivery_postal_code || null,
            p_delivery_floor: data.delivery_floor || null,
            p_delivery_notes: data.delivery_notes || null,
            p_name_on_ringer: data.name_on_ringer || null,
            p_table_number: tableNumberInt,
            p_estimated_ready_time: estimatedReadyTimeMinutes,
            p_branch_id: branchId,
            p_terminal_id: terminalId,
            p_platform: 'pos'
        });

        if (!rpcError && rpcResult && rpcResult.length > 0) {
            const result = rpcResult[0];
            await this.dbManager.updateOrderSupabaseId(recordId, result.id);
            await this.ensureOrderItems(recordId, result.id);
            return;
        }

        // Log RPC error and fall back to direct table operations
        if (rpcError) {
            const msg = String(rpcError?.message || '');
            // If function doesn't exist, fall back silently
            if (!/42883|function .* does not exist/i.test(msg)) {
                console.warn('[OrderSyncService] RPC failed, falling back to direct operations:', rpcError);
            }
        }

        // Fallback: Direct table operations (requires service_role key or RLS bypass)
        const payload: any = {
            client_order_id: recordId,
            platform: 'pos',
            organization_id: organizationId,
            order_number: data.order_number || null,
            customer_name: data.customer_name,
            customer_email: data.customer_email || null,
            customer_phone: data.customer_phone || null,
            order_type: data.order_type || 'takeaway',
            status: mapStatusForSupabase(data.status as any),
            subtotal: subtotal,
            total_amount: data.total_amount,
            tax_amount: taxAmount,
            discount_amount: discountAmount || null,
            payment_status: data.payment_status || 'pending',
            payment_method: data.payment_method || null,
            special_instructions: data.special_instructions || data.notes || null,
            // Delivery address fields
            delivery_address: data.delivery_address || null,
            delivery_city: data.delivery_city || null,
            delivery_postal_code: data.delivery_postal_code || null,
            delivery_floor: data.delivery_floor || null,
            delivery_notes: data.delivery_notes || null,
            name_on_ringer: data.name_on_ringer || null,
            table_number: tableNumberInt,
            estimated_ready_time: estimatedReadyTimeMinutes,
            created_at: data.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        if (branchId) payload.branch_id = branchId;
        if (terminalId) payload.terminal_id = terminalId;
        if (data.driver_id) payload.driver_id = data.driver_id;
        if (data.driver_name) payload.driver_name = data.driver_name;

        const orderClient = this.getOrderClient();
        const tryUpsert = async (p: any) =>
            orderClient
                .from('orders')
                .upsert(p, { onConflict: 'client_order_id' })
                .select()
                .single();
        const tryInsert = async (p: any) =>
            orderClient
                .from('orders')
                .insert(p)
                .select()
                .single();

        let insertResp = await tryUpsert(payload);
        if (insertResp.error) {
            // Normalize common error cases and retry
            const msg = String(insertResp.error?.message || '');

            // 1) Invalid UUIDs for any field → drop offending values and retry
            if (/22P02|invalid input syntax for type uuid/i.test(msg)) {
                const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
                if ('branch_id' in payload && !isUuid(payload.branch_id)) delete payload.branch_id;
                if ('terminal_id' in payload && !isUuid(payload.terminal_id)) delete payload.terminal_id;
                if ('staff_shift_id' in payload && !isUuid(payload.staff_shift_id)) delete payload.staff_shift_id;
                if ('driver_id' in payload && !isUuid(payload.driver_id)) delete payload.driver_id;
                const m = msg.match(/invalid input syntax for type uuid:\s*\"([^\"]+)\"/i);
                if (m && m[1]) {
                    const bad = m[1];
                    Object.keys(payload).forEach((k) => {
                        const val = (payload as any)[k];
                        if (typeof val === 'string' && val === bad) delete (payload as any)[k];
                    });
                }
                insertResp = await tryUpsert(payload);
            }

            // 2b) Invalid Integer/Timestamp mismatch (e.g., sending ISO string to INTEGER column)
            if (insertResp.error) {
                const msg2b = String(insertResp.error?.message || '');
                if (/22P02|invalid input syntax for type integer/i.test(msg2b)) {
                    // Extract the bad value from error message
                    const m = msg2b.match(/invalid input syntax for type integer:\s*\"([^\"]+)\"/i);
                    if (m && m[1]) {
                        const bad = m[1];
                        Object.keys(payload).forEach((k) => {
                            const val = (payload as any)[k];
                            // Check for exact match or if the value contains the bad string (for potential partial matches)
                            if (val === bad || (typeof val === 'string' && val.includes(bad))) {
                                delete (payload as any)[k];
                            }
                        });
                        insertResp = await tryUpsert(payload);
                    }
                }
            }

            // 2) Missing columns on some environments → remove optional cols and retry
            if (insertResp.error) {
                const msg2 = String(insertResp.error?.message || msg);
                if (/42703|column .* does not exist|unknown column/i.test(msg2)) {
                    // Remove known optional columns first
                    ['branch_id', 'terminal_id', 'special_instructions', 'table_number', 'estimated_ready_time', 'payment_method', 'payment_status', 'discount_amount', 'tax_amount', 'subtotal', 'notes'].forEach((k) => {
                        if (k in payload && new RegExp(`\\b${k}\\b`, 'i').test(msg2)) delete (payload as any)[k];
                    });
                    // If client_order_id column is missing, drop it and fallback to insert (no ON CONFLICT)
                    if ('client_order_id' in payload && /client_order_id/i.test(msg2)) {
                        delete (payload as any).client_order_id;
                        insertResp = await tryInsert(payload);
                    } else {
                        // Retry upsert after stripping optional columns
                        insertResp = await tryUpsert(payload);
                    }
                }
            }

            // 3) ON CONFLICT not available yet → fallback to plain insert
            if (insertResp.error) {
                const msg3 = String(insertResp.error?.message || msg);
                if (/ON CONFLICT|unique or exclusion constraint/i.test(msg3) || /42P10/.test(msg3)) {
                    // Remove client_order_id to avoid conflict targeting a non-existent unique index
                    if ('client_order_id' in payload) delete (payload as any).client_order_id;
                    insertResp = await tryInsert(payload);
                }
            }
        }

        if (insertResp.error) throw insertResp.error;

        // Update local order with Supabase ID (idempotent)
        if (insertResp.data) {
            await this.dbManager.updateOrderSupabaseId(recordId, insertResp.data.id);
            // Ensure order_items exist remotely for this order (prevents empty items on pull)
            await this.ensureOrderItems(recordId, insertResp.data.id);
        }
    }

    private async ensureOrderItems(localOrderId: string, remoteOrderId: string) {
        try {
            const { data: existingItems, error: itemsCheckError } = await this.getOrderClient()
                .from('order_items')
                .select('id')
                .eq('order_id', remoteOrderId)
                .limit(1);
            const hasItems = !itemsCheckError && Array.isArray(existingItems) && existingItems.length > 0;
            if (!hasItems) {
                const localOrder = await this.dbManager.getOrderById(localOrderId);
                const localItems = Array.isArray((localOrder as any)?.items) ? (localOrder as any).items : [];
                if (localItems.length > 0) {
                    const rows = localItems.map((it: any) => {
                        // Get the menu item ID (stored in subcategories table)
                        // Handle both camelCase (menuItemId) and snake_case (menu_item_id)
                        const menuItemId = it.menuItemId || it.menu_item_id || it.subcategoryId || it.subcategory_id || it.id;
                        
                        // Get the menu item name - try multiple sources
                        // Priority: name > title > menuItemName > menu_item_name
                        // CRITICAL: Ensure menu_item_name is NEVER null (Requirements 1.3, 1.4)
                        let menuItemName = it.name || it.title || it.menuItemName || it.menu_item_name;
                        
                        // Validate the name is not a truncated ID pattern (Requirements 1.4, 1.5)
                        const isInvalidName = !menuItemName || 
                            typeof menuItemName !== 'string' ||
                            menuItemName.trim() === '' ||
                            /^Item [a-fA-F0-9]+/.test(menuItemName) ||
                            /^[a-f0-9]{8}-[a-f0-9]{4}/.test(menuItemName);
                        
                        if (isInvalidName) {
                            // Log error when item has no valid name source (Requirements 1.4, 1.5)
                            console.error('[OrderSyncService] ❌ Item missing valid name, using fallback:', {
                                menuItemId,
                                originalName: menuItemName,
                                orderId: localOrderId,
                                remoteOrderId
                            });
                            // Use a descriptive fallback that indicates the issue
                            menuItemName = `Item ${menuItemId?.substring(0, 8) || 'Unknown'}`;
                        }

                        return {
                            order_id: remoteOrderId,
                            menu_item_id: menuItemId,
                            menu_item_name: menuItemName, // MUST be populated (never null)
                            quantity: it.quantity || 1,
                            unit_price: it.unit_price || it.unitPrice || it.price || 0,
                            total_price: it.total_price || it.totalPrice || ((it.quantity || 1) * (it.unit_price || it.unitPrice || it.price || 0)),
                            notes: it.notes || null,
                            customizations: Array.isArray(it.customizations)
                                ? (() => {
                                    const result = it.customizations.reduce((acc: any, c: any, idx: number) => {
                                        // Generate a unique key for each customization
                                        // Priority: customizationId > optionId > name > ingredient.id > ingredient.name > fallback
                                        // IMPORTANT: Check customizationId/optionId/name FIRST since MenuPage format doesn't have ingredient object
                                        let key: string = `item-${idx}`;
                                        if (c.customizationId && typeof c.customizationId === 'string') key = c.customizationId;
                                        else if (c.optionId && typeof c.optionId === 'string') key = c.optionId;
                                        else if (c.name && typeof c.name === 'string') key = c.name;
                                        else if (c.ingredient?.id && typeof c.ingredient.id === 'string') key = c.ingredient.id;
                                        else if (c.ingredient?.name && typeof c.ingredient.name === 'string') key = c.ingredient.name;

                                        acc[key] = c;
                                        return acc;
                                    }, {});
                                    return result;
                                })()
                                : (it.customizations || null)
                        };
                    });
                    
                    // Final validation: ensure no items have null menu_item_name before insert
                    const itemsWithoutNames = rows.filter((r: any) => !r.menu_item_name);
                    if (itemsWithoutNames.length > 0) {
                        console.error('[OrderSyncService] ❌ CRITICAL: Items still have null menu_item_name after processing:', {
                            count: itemsWithoutNames.length,
                            orderId: localOrderId,
                            remoteOrderId
                        });
                    }
                    
                    // Best-effort insert; if schema differs or duplicates occur, swallow and continue
                    const ins = await this.getOrderClient().from('order_items').insert(rows);
                    if (ins.error) {
                        const msg = String(ins.error?.message || '');
                        if (/42P01|relation .* does not exist|42703|column .* does not exist/i.test(msg)) {
                            console.warn('[OrderSyncService] order_items insert skipped due to schema mismatch');
                        } else {
                            console.warn('[OrderSyncService] order_items insert error:', msg);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[OrderSyncService] Failed ensuring order_items for new order:', e);
        }
    }

    private async handleUpdate(recordId: string, data: any): Promise<void> {
        // Get the order from local database to get supabase_id and version
        const localOrder = await this.dbManager.getOrderById(recordId);
        if (!localOrder) {
            console.error('[OrderSyncService] Cannot update: Order not found in local DB', { recordId });
            throw new Error('Cannot update: Order not found');
        }

        // Fallback resolution: if supabase_id is missing (e.g., update queued before insert completes),
        // try to resolve the remote order by client_order_id (recordId) or order_number and cache it locally.
        if (!localOrder.supabase_id) {
            await this.resolveSupabaseId(localOrder, recordId);
        }

        // Get local version info for optimistic locking
        const localVersion = localOrder.version || 1;
        const remoteVersion = Number.isFinite(localOrder.remote_version) ? (localOrder.remote_version as number) : (parseInt(String(localOrder.remote_version)) || 0);
        const hasTrackedRemoteVersion = !!remoteVersion && remoteVersion > 0;

        // Attempt optimistic locking update with fallback if optional columns are missing
        // Sanitize known UUID fields in data before building payload
        const sanitizeUuidFields = (obj: any) => {
            const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
            ['branch_id', 'terminal_id', 'staff_shift_id', 'driver_id', 'cashier_id', 'staff_id'].forEach((k) => {
                const val = obj?.[k];
                if (val != null && !isUuid(val)) delete obj[k];
            });
            return obj;
        };
        const sanitizedData = sanitizeUuidFields({ ...data });

        // Keep estimated_ready_time as INTEGER (minutes) - database column is INTEGER
        if ('estimated_ready_time' in sanitizedData && sanitizedData.estimated_ready_time != null) {
            const ert = sanitizedData.estimated_ready_time;
            if (typeof ert === 'number') {
                sanitizedData.estimated_ready_time = ert;
            } else if (typeof ert === 'string' && /^\d+$/.test(ert)) {
                sanitizedData.estimated_ready_time = parseInt(ert, 10);
            } else {
                // Can't convert ISO string back to minutes reliably, remove it
                delete sanitizedData.estimated_ready_time;
            }
        }

        // Keep table_number as INTEGER - database column is INTEGER
        if ('table_number' in sanitizedData && sanitizedData.table_number != null) {
            const tn = sanitizedData.table_number;
            if (typeof tn === 'number') {
                sanitizedData.table_number = tn;
            } else if (typeof tn === 'string' && /^\d+$/.test(tn)) {
                sanitizedData.table_number = parseInt(tn, 10);
            } else {
                // Can't convert non-numeric string to integer, remove it
                delete sanitizedData.table_number;
            }
        }

        let updatePayload: any = {
            ...sanitizedData,
            // Include order_number so Admin API and server-side fallbacks can resolve ownership
            order_number: localOrder.order_number,
            client_order_id: localOrder.id,
            updated_at: new Date().toISOString(),
            updated_by: localOrder.updated_by
        };

        // Normalize status to Supabase-allowed values
        if ('status' in updatePayload && updatePayload.status) {
            const originalStatus = updatePayload.status;
            updatePayload.status = mapStatusForSupabase(updatePayload.status as any);
            // Attach branch/terminal identifiers if available to satisfy server-side guards
            try {
                const dbSvc = this.dbManager.getDatabaseService();
                const rawTerminalId = (dbSvc.settings.getSetting('terminal', 'terminal_id', this.terminalId) as string) || this.terminalId || null;
                const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
                const terminalId = isUuid(rawTerminalId) ? rawTerminalId : null;
                const branchId = (dbSvc.settings.getSetting('terminal', 'branch_id', null) as string | null) ?? null;
                if (terminalId) updatePayload.terminal_id = terminalId;
                if (branchId) updatePayload.branch_id = branchId;
            } catch { }

            // Avoid regressions: if local has progressed further, override queued one
            try {
                const rank: Record<string, number> = { pending: 0, confirmed: 1, preparing: 2, ready: 3, out_for_delivery: 4, delivered: 5, completed: 6, cancelled: 7 };
                const localSupabase = mapStatusForSupabase(localOrder.status || '');
                if (updatePayload.status && localSupabase && (rank[localSupabase] ?? -1) > (rank[updatePayload.status] ?? -1)) {
                    updatePayload.status = localSupabase;
                }
            } catch { }
        }

        // Ensure essential non-null fields exist for possible UPSERT fallback
        try {
            const num = (v: any) => v == null ? undefined : Number(v);
            if (!('total_amount' in updatePayload) && localOrder.total_amount != null) updatePayload.total_amount = num(localOrder.total_amount);
            // Get financial fields - use explicit values if available, otherwise derive
            if (!('subtotal' in updatePayload) || !('tax_amount' in updatePayload) || !('delivery_fee' in updatePayload)) {
                const updateFallbackFinancials = deriveOrderFinancials(
                    localOrder.total_amount,
                    (localOrder as any).order_type,
                    (localOrder as any).discount_amount ?? 0,
                    {
                        subtotal: (localOrder as any).subtotal,
                        tax_amount: (localOrder as any).tax_amount,
                        tax_rate: (localOrder as any).tax_rate,
                        delivery_fee: (localOrder as any).delivery_fee
                    }
                );
                if (!('subtotal' in updatePayload)) updatePayload.subtotal = updateFallbackFinancials.subtotal;
                if (!('tax_amount' in updatePayload)) (updatePayload as any).tax_amount = updateFallbackFinancials.tax_amount;
                if (!('delivery_fee' in updatePayload)) (updatePayload as any).delivery_fee = updateFallbackFinancials.delivery_fee;
            }
            if (!('order_type' in updatePayload) && (localOrder as any).order_type) (updatePayload as any).order_type = (localOrder as any).order_type;
        } catch { }

        // Pre-sanitize invalid UUID fields before first UPDATE attempt to avoid 22P02
        try {
            const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
            (['branch_id', 'terminal_id', 'staff_shift_id', 'driver_id'] as const).forEach((k) => {
                const val = (updatePayload as any)[k];
                if (val != null && !isUuid(val)) {
                    delete (updatePayload as any)[k];
                }
            });
        } catch { }


        // Try optimistic-locking update when remote supports version column
        const orderClient = this.getOrderClient();
        let versionSupported = true;
        const tryUpdate = async (p: any) =>
            orderClient
                .from('orders')
                .update(p)
                .eq('id', localOrder.supabase_id)
                .eq('version', remoteVersion) // Optimistic lock
                .select()
                .maybeSingle();
        // Fallback updater when remote does not have a 'version' column
        const tryUpdateNoVersion = async (p: any) =>
            orderClient
                .from('orders')
                .update(p)
                .eq('id', localOrder.supabase_id)
                .select()
                .maybeSingle();

        // First attempt: only use optimistic lock if remote version is known and version column seems supported
        let updateResp = hasTrackedRemoteVersion ? await tryUpdate(updatePayload) : await tryUpdateNoVersion(updatePayload);

        if (updateResp.error) {
            const msg = String(updateResp.error?.message || '');
            // If remote does not support version column, retry without optimistic lock
            if (/42703|column\s+\"?version\"?\s+does not exist/i.test(msg)) {
                versionSupported = false;
                updateResp = await tryUpdateNoVersion(updatePayload);
            }
            if (/42703|column .* does not exist|unknown column/i.test(msg)) {
                delete updatePayload.branch_id;
                delete updatePayload.terminal_id;
                updateResp = versionSupported ? await tryUpdate(updatePayload) : await tryUpdateNoVersion(updatePayload);
            } else if (/22P02|invalid input syntax for type uuid/i.test(msg)) {
                const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
                if ('branch_id' in updatePayload && !isUuid(updatePayload.branch_id)) delete updatePayload.branch_id;
                if ('terminal_id' in updatePayload && !isUuid(updatePayload.terminal_id)) delete updatePayload.terminal_id;
                if ('staff_shift_id' in updatePayload && !isUuid(updatePayload.staff_shift_id)) delete updatePayload.staff_shift_id;
                if ('driver_id' in updatePayload && !isUuid(updatePayload.driver_id)) delete updatePayload.driver_id;
                // If error string includes the offending value, strip any field carrying that value
                const m = msg.match(/invalid input syntax for type uuid:\s*\"([^\"]+)\"/i);
                if (m && m[1]) {
                    const bad = m[1];
                    Object.keys(updatePayload).forEach((k) => {
                        const val = (updatePayload as any)[k];
                        if (typeof val === 'string' && val === bad) {
                            delete (updatePayload as any)[k];
                        }
                    });
                }
                updateResp = versionSupported ? await tryUpdate(updatePayload) : await tryUpdateNoVersion(updatePayload);
            } else if (/22P02|invalid input syntax for type integer/i.test(msg)) {
                // Handle Integer/Timestamp mismatch for update
                const m = msg.match(/invalid input syntax for type integer:\s*\"([^\"]+)\"/i);
                if (m && m[1]) {
                    const bad = m[1];
                    Object.keys(updatePayload).forEach((k) => {
                        const val = (updatePayload as any)[k];
                        if (val === bad || (typeof val === 'string' && val.includes(bad))) {
                            delete (updatePayload as any)[k];
                        }
                    });
                    updateResp = versionSupported ? await tryUpdate(updatePayload) : await tryUpdateNoVersion(updatePayload);
                }
            }
        }

        const updatedData = updateResp.data;
        const updateError = updateResp.error;

        // Check for version conflict or other error
        if (updateResp.data) {
            // Update local sync metadata from server response if available
            const newRemoteVersion = (updateResp.data as any)?.version;
            if (newRemoteVersion) {
                this.dbManager.orders.updateSyncMetadata(localOrder.id, newRemoteVersion, new Date().toISOString());
            }
        }

        if (updateError || !updatedData) {
            // Fetch remote order to check version
            const { data: remoteOrder, error: fetchError } = await orderClient
                .from('orders')
                .select('*')
                .eq('id', localOrder.supabase_id)
                .maybeSingle();

            // Only perform version-based conflict detection when the remote supports versioning and
            // we actually have a tracked remoteVersion locally. Otherwise, retry without lock.
            if (versionSupported && hasTrackedRemoteVersion && !fetchError && remoteOrder && remoteOrder.version !== remoteVersion) {
                // Version mismatch - create conflict
                const conflictId = await this.createConflict(localOrder, remoteOrder);

                // Mark sync item as conflict (we'll get syncQueueId from caller)
                // For now, emit conflict event
                this.mainWindow?.webContents.send('order-sync-conflict', {
                    orderId: localOrder.id,
                    conflictId,
                    localVersion,
                    remoteVersion: remoteOrder.version,
                    createdAt: new Date().toISOString()
                });

                // Don't throw error - conflict is handled
                return;
            }

            // If not a version conflict (or version not supported), and the prior update failed,
            // attempt a final retry without optimistic lock. If that still affects 0 rows, recover via upsert on client_order_id.
            if (updateError) {
                const finalResp = await tryUpdateNoVersion(updatePayload);
                const code2 = (finalResp as any)?.error?.code;
                const msg2 = String((finalResp as any)?.error?.message || '');
                if ((finalResp as any)?.error && (code2 === '23514' || /orders_status_check/i.test(msg2))) {
                    console.warn('[OrderSyncService] ⏭️ Skipping upsert fallback due to CHECK constraint; will retry later', { code: code2, msg: msg2 });
                    throw (finalResp as any).error;
                }
                if (finalResp.error || !finalResp.data) {
                    const msg2 = String(finalResp.error?.message || '');
                    const zeroRow = /PGRST116|0 rows|Cannot coerce the result to a single JSON object/i.test(msg2) || !finalResp.data;
                    if (!zeroRow && finalResp.error) throw finalResp.error;
                    // Fallback: Upsert by client_order_id (insert if missing)
                    const upsertPayload: any = { ...updatePayload };
                    upsertPayload.client_order_id = localOrder.id;
                    if (!('created_at' in upsertPayload)) upsertPayload.created_at = new Date().toISOString();
                    // Ensure organization_id is set for RLS compliance
                    if (!upsertPayload.organization_id) {
                        upsertPayload.organization_id = this.getOrganizationId();
                    }
                    if (!upsertPayload.organization_id) {
                        console.error('[OrderSyncService] ❌ Cannot upsert order: organization_id is required for RLS');
                        throw new Error('Cannot upsert order: organization_id is required');
                    }

                    const upsertResp = await orderClient
                        .from('orders')
                        .upsert(upsertPayload, { onConflict: 'client_order_id' })
                        .select()
                        .single();

                    if (upsertResp.error) throw upsertResp.error;
                    if (upsertResp.data) {
                        await this.dbManager.updateOrderSupabaseId(recordId, upsertResp.data.id);
                    }
                }
            }
        }
    }

    private async resolveSupabaseId(localOrder: any, recordId: string) {
        const orderClient = this.getOrderClient();
        try {
            let remoteMatch: any = null;
            // Try by client_order_id first (if the column exists remotely)
            let tryClient = await orderClient
                .from('orders')
                .select('id, version')
                .eq('client_order_id', recordId)
                .limit(1)
                .single();
            if (!tryClient.error && tryClient.data) {
                remoteMatch = tryClient.data;
            } else {
                const msg = String(tryClient.error?.message || '');
                // If the column doesn't exist on this environment, ignore error and try order_number
                if (!/42703|column .* does not exist|unknown column/i.test(msg) && tryClient.error) {
                    // client_order_id lookup failed for other reasons
                }
            }

            // Try by order_number as fallback
            if (!remoteMatch && localOrder.order_number) {
                const tryByNumber = await orderClient
                    .from('orders')
                    .select('id, version')
                    .eq('order_number', localOrder.order_number)
                    .limit(1)
                    .single();
                if (!tryByNumber.error && tryByNumber.data) {
                    remoteMatch = tryByNumber.data;
                }
            }

            if (remoteMatch?.id) {
                await this.dbManager.updateOrderSupabaseId(recordId, remoteMatch.id);
                // Mutate localOrder object to include the resolved id for subsequent update path
                (localOrder as any).supabase_id = remoteMatch.id;
                // Also refresh remote_version cache if available
                if (typeof remoteMatch.version === 'number') {
                    try { this.dbManager.orders.updateSyncMetadata(localOrder.id, remoteMatch.version, new Date().toISOString()); } catch { }
                }
            } else {
                console.error('[OrderSyncService] Cannot resolve supabase_id', { recordId, order_number: localOrder.order_number });
                throw new Error('Cannot update: missing supabase_id and remote match not found');
            }
        } catch (e) {
            console.error('[OrderSyncService] supabase_id resolution failed', { error: e });
            throw e;
        }
    }

    public async pushSingleOrderNow(orderId: string, timeoutMs: number = 4000): Promise<void> {
        try {
            const order = await this.dbManager.getOrderById(orderId);
            if (!order) return;

            // Create a promise that rejects after timeout
            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('Sync timeout')), timeoutMs);
            });

            // Perform the sync
            // Get financial breakdown - use explicit values if available, otherwise derive
            const pushFinancials = deriveOrderFinancials(
                order.total_amount,
                order.order_type,
                order.discount_amount || 0,
                {
                    subtotal: (order as any).subtotal,
                    tax_amount: (order as any).tax_amount,
                    tax_rate: (order as any).tax_rate,
                    delivery_fee: (order as any).delivery_fee
                }
            );

            const syncPromise = this.syncOrder('insert', orderId, {
                organization_id: this.getOrganizationId(),
                order_number: order.order_number,
                customer_name: order.customer_name,
                customer_email: order.customer_email,
                customer_phone: order.customer_phone,
                order_type: order.order_type,
                status: order.status,
                // Financial fields - use explicit values if provided, otherwise derived
                total_amount: order.total_amount,
                tax_amount: pushFinancials.tax_amount,
                subtotal: pushFinancials.subtotal,
                discount_amount: order.discount_amount || 0,
                delivery_fee: pushFinancials.delivery_fee,
                payment_status: order.payment_status,
                payment_method: order.payment_method,
                special_instructions: order.special_instructions,
                table_number: order.table_number,
                estimated_ready_time: order.estimated_time,
                // Delivery address fields - all six fields for complete address sync
                delivery_address: (order as any).delivery_address || null,
                delivery_city: (order as any).delivery_city || null,
                delivery_postal_code: (order as any).delivery_postal_code || null,
                delivery_floor: (order as any).delivery_floor || null,
                delivery_notes: (order as any).delivery_notes || null,
                name_on_ringer: (order as any).name_on_ringer || null,
                created_at: order.created_at,
                updated_at: order.updated_at,
                branch_id: this.dbManager.getDatabaseService().settings.getSetting('terminal', 'branch_id', null),
                terminal_id: this.terminalId
            });

            await Promise.race([syncPromise, timeoutPromise]);
        } catch (error) {
            console.warn('[OrderSyncService] pushSingleOrderNow failed:', error);
            // Don't throw, just log
        }
    }

    private async createConflict(localOrder: any, remoteOrder: any): Promise<string> {
        // Create a conflict record in the local database
        // This is a simplified version, you might want to store more details
        const conflictId = crypto.randomUUID();

        // In a real implementation, you would save this to a conflicts table
        // await this.dbManager.createConflict(...)

        return conflictId;
    }

    /**
     * Handle order forwarded from a child terminal
     */
    /**
     * Handle order forwarded from a child terminal
     */
    private async handleForwardedOrder(orderData: any, sourceTerminalId: string): Promise<void> {
        try {
            // 1. Insert into local database
            const db = this.dbManager.db;

            // Check if order already exists
            const existing = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderData.id || orderData.client_order_id);
            if (existing) {
                return;
            }

            // Prepare insert
            const row: any = {
                id: orderData.client_order_id || orderData.id,
                order_number: orderData.order_number,
                customer_name: orderData.customer_name,
                customer_email: orderData.customer_email,
                order_type: orderData.order_type,
                status: orderData.status,
                total_amount: orderData.total_amount,
                tax: orderData.tax_amount || orderData.tax,
                discount_amount: orderData.discount_amount,
                payment_status: orderData.payment_status,
                payment_method: orderData.payment_method,
                special_instructions: orderData.special_instructions || orderData.notes,
                table_number: orderData.table_number,
                created_at: orderData.created_at,
                updated_at: orderData.updated_at,
                terminal_id: orderData.terminal_id,
                branch_id: orderData.branch_id,
                source_terminal_id: sourceTerminalId,
                routing_path: 'via_parent'
            };

            const keys = Object.keys(row).filter(k => k !== undefined);
            const placeholders = keys.map(() => '?').join(',');
            const values = keys.map(k => row[k]);

            const sql = `INSERT INTO orders (${keys.join(',')}) VALUES (${placeholders})`;

            try {
                db.prepare(sql).run(...values);
            } catch (err: any) {
                console.error('[OrderSyncService] Failed to insert forwarded order:', err);
                if (err.message.includes('no such column')) {
                    const fallbackKeys = keys.filter(k => k !== 'source_terminal_id' && k !== 'routing_path');
                    const fallbackPlaceholders = fallbackKeys.map(() => '?').join(',');
                    const fallbackValues = fallbackKeys.map(k => row[k]);
                    const fallbackSql = `INSERT INTO orders (${fallbackKeys.join(',')}) VALUES (${fallbackPlaceholders})`;
                    db.prepare(fallbackSql).run(...fallbackValues);
                } else {
                    throw err;
                }
            }

            // 2. Handle Order Items
            if (Array.isArray(orderData.items)) {
                const itemStmt = db.prepare(`
                    INSERT INTO order_items (
                        id, order_id, menu_item_id, quantity, unit_price, total_price, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `);

                const insertItem = db.transaction((items: any[]) => {
                    for (const item of items) {
                        itemStmt.run(
                            item.id || crypto.randomUUID(),
                            row.id,
                            item.menu_item_id,
                            item.quantity,
                            item.unit_price,
                            item.total_price,
                            item.notes || null
                        );
                    }
                });

                insertItem(orderData.items);
            }

            // 3. Queue for cloud sync
            const syncSvc = this.dbManager.sync;
            syncSvc.addToSyncQueue('orders', row.id, 'insert', orderData);

        } catch (err) {
            console.error('[OrderSyncService] Error handling forwarded order:', err);
            throw err;
        }
    }
}

