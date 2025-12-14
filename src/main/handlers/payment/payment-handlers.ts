import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError, IPCError, ErrorCode, ErrorCodes } from '../utils/error-handler';


import { v4 as uuidv4 } from 'uuid';
import { getProcessingDelay, isTestMode, isProductionMode } from '../../../config/payment-config';
import { enqueuePosPaymentSync } from '../../payment-sync-queue';
// Type-only import for db usage if needed, but we use the one from serviceRegistry
import type { DatabaseManager } from '../../database';

// Payment gateway simulation (no cardholder data; POS never handles PAN/CVV)
// In test environments we simulate responses; in production we assume a PCI-compliant
// external terminal processed the card and we only record the resulting transaction.
class PaymentGateway {
    static async processCardPayment(amount: number): Promise<{
        success: boolean;
        transactionId?: string;
        errorCode?: string;
        errorMessage?: string;
    }> {
        // Simulate processing delay (configurable)
        await new Promise(resolve => setTimeout(resolve, getProcessingDelay()));

        // Handle test mode vs production mode
        if (isTestMode()) {
            // In test mode we always succeed unless explicitly configured otherwise in the future.
            return {
                success: true,
                transactionId: `test_txn_${uuidv4().substring(0, 8)}`
            };
        }

        // Production mode - assume an external PCI-compliant terminal processed the card
        if (isProductionMode()) {
            return {
                success: true,
                transactionId: `ext_txn_${uuidv4().substring(0, 8)}`
            };
        }

        // Fallback - should not reach here
        throw new Error('Invalid payment configuration');
    }

    static async processRefund(transactionId: string, amount: number): Promise<{
        success: boolean;
        refundId?: string;
        errorCode?: string;
        errorMessage?: string;
    }> {
        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Simulate 95% success rate
        if (Math.random() < 0.95) {
            return {
                success: true,
                refundId: `ref_${uuidv4().substring(0, 8)}`
            };
        } else {
            return {
                success: false,
                errorCode: 'REFUND_FAILED',
                errorMessage: 'Refund processing failed'
            };
        }
    }

}

async function sendPosPaymentToAdminDashboard(params: {
    db: DatabaseManager;
    orderId: string;
    amount: number;
    paymentMethod: 'cash' | 'card';
    externalTransactionId?: string;
    metadata?: any;
}) {
    const { db, orderId, amount, paymentMethod, externalTransactionId, metadata } = params;

    try {
        // Get admin dashboard URL from local settings first
        let base = (process.env.ADMIN_DASHBOARD_URL || 'http://localhost:3001').replace(/\/$/, '');
        try {
            const storedUrl = await db.getSetting('terminal' as any, 'admin_dashboard_url', null);
            if (storedUrl && typeof storedUrl === 'string' && storedUrl.trim()) {
                base = storedUrl.trim().replace(/\/$/, '');
            }
        } catch {
            // fallback to env/default
        }

        // Resolve remote Supabase order id from local order id; if it doesn't exist yet, skip fast-path sync
        const localOrder = await db.getOrderById(orderId);
        const supabaseOrderId = (localOrder as any)?.supabase_id;
        if (!supabaseOrderId) {
            console.log('[POS] Skipping immediate payment sync to admin because order has no supabase_id yet', {
                orderId,
            });
            return;
        }

        // Resolve terminal id and per-terminal API key from local settings
        let terminalId = process.env.TERMINAL_ID || 'terminal-001';
        try {
            const storedTid = await db.getSetting('terminal' as any, 'terminal_id', terminalId);
            if (storedTid && typeof storedTid === 'string' && storedTid.trim()) {
                terminalId = storedTid.trim();
            }
        } catch {
            // fallback to env/default
        }

        let apiKey = '';
        try {
            const key = await db.getSetting('terminal' as any, 'pos_api_key', '');
            if (key && typeof key === 'string' && key.trim()) {
                apiKey = key.trim();
            }
        } catch {
            // ignore, treat as missing API key
        }

        const adminToken = process.env.ADMIN_API_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-terminal-id': terminalId,
        };

        if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
        if (apiKey) headers['x-pos-api-key'] = apiKey;

        const idempotencyKeyBase = `${terminalId}:${orderId}:${paymentMethod}`;
        const idempotencyKey = externalTransactionId
            ? `${idempotencyKeyBase}:${externalTransactionId}`
            : idempotencyKeyBase;

        const body = {
            order_id: supabaseOrderId,
            amount,
            payment_method: paymentMethod,
            // While external_transaction_id will be optional server-side, provide
            // a stable, non-sensitive identifier when we have one.
            external_transaction_id: externalTransactionId || `local_tx_${orderId}`,
            idempotency_key: idempotencyKey,
            metadata: {
                ...metadata,
                source: 'pos-system',
            },
        };

        const response = await fetch(`${base}/api/pos/payments`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            // Do not hang the POS UI on slow network calls
            signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(10000) : undefined,
        });

        if (!response.ok) {
            let errorBody = '';
            try {
                errorBody = await response.text();
            } catch {
                // ignore
            }
            console.error('POS payment sync to admin failed', {
                status: response.status,
                errorBody,
            });
        }
    } catch (error) {
        console.error('POS payment sync to admin error', error);
    }
}

export function registerPaymentHandlers() {
    // Process cash payment
    ipcMain.handle('payment:process-cash', async (event, data: {
        orderId: string;
        amount: number;
        cashReceived: number;
    }) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            const { orderId, amount, cashReceived } = data;

            if (cashReceived < amount) {
                throw new IPCError('Insufficient cash received');
            }

            const transactionId = uuidv4();
            const now = new Date().toISOString();

            // Create transaction record
            await db.insertPaymentTransaction({
                id: transactionId,
                order_id: orderId,
                amount,
                payment_method: 'cash',
                status: 'completed',
                processed_at: now
            });

            // Update order payment status
            await db.updateOrderPaymentStatus(orderId, 'completed', 'cash', transactionId);

            // Enqueue payment sync so we have durable retry to Admin Dashboard
            await enqueuePosPaymentSync({
                db,
                orderId,
                transactionId,
                amount,
                paymentMethod: 'cash',
                externalTransactionId: transactionId,
                metadata: {
                    cash_received: cashReceived,
                    change_given: cashReceived - amount,
                },
            });

            // Fire-and-forget best-effort sync to Admin Dashboard payments endpoint
            void sendPosPaymentToAdminDashboard({
                db,
                orderId,
                amount,
                paymentMethod: 'cash',
                externalTransactionId: transactionId,
                metadata: {
                    cash_received: cashReceived,
                    change_given: cashReceived - amount,
                },
            });

            return {
                transaction: {
                    id: transactionId,
                    order_id: orderId,
                    amount,
                    payment_method: 'cash',
                    status: 'completed',
                    processed_at: now,
                    cash_received: cashReceived,
                    change_given: cashReceived - amount
                }
            };
        }, 'payment:process-cash');
    });

    // Process card payment (record only; actual card processing happens on external terminal)
    ipcMain.handle('payment:process-card', async (event, data: {
        orderId: string;
        amount: number;
        externalTransactionId?: string;
        metadata?: any;
    }) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            const { orderId, amount, externalTransactionId, metadata } = data;

            const transactionId = uuidv4();
            const now = new Date().toISOString();

            // Process payment through gateway (simulation only; no cardholder data handled here)
            const gatewayResult = await PaymentGateway.processCardPayment(amount);

            if (!gatewayResult.success) {
                // Create failed transaction record
                await db.insertPaymentTransaction({
                    id: transactionId,
                    order_id: orderId,
                    amount,
                    payment_method: 'card',
                    status: 'failed',
                    gateway_response: JSON.stringify(gatewayResult),
                    processed_at: now
                });

                throw new IPCError(gatewayResult.errorMessage || 'Card payment failed', (gatewayResult.errorCode as ErrorCode) || ErrorCodes.UNKNOWN_ERROR);
            }

            // Create successful transaction record
            await db.insertPaymentTransaction({
                id: transactionId,
                order_id: orderId,
                amount,
                payment_method: 'card',
                status: 'completed',
                gateway_transaction_id: externalTransactionId || gatewayResult.transactionId,
                gateway_response: JSON.stringify({
                    ...gatewayResult,
                    externalTransactionId,
                    metadata
                }),
                processed_at: now
            });

            // Update order payment status
            await db.updateOrderPaymentStatus(orderId, 'completed', 'card', transactionId);

            // Enqueue payment sync so we have durable retry to Admin Dashboard
            await enqueuePosPaymentSync({
                db,
                orderId,
                transactionId,
                amount,
                paymentMethod: 'card',
                externalTransactionId: externalTransactionId || gatewayResult.transactionId,
                metadata,
            });

            // Fire-and-forget best-effort sync to Admin Dashboard payments endpoint
            void sendPosPaymentToAdminDashboard({
                db,
                orderId,
                amount,
                paymentMethod: 'card',
                externalTransactionId: externalTransactionId || gatewayResult.transactionId,
                metadata,
            });

            return {
                transaction: {
                    id: transactionId,
                    order_id: orderId,
                    amount,
                    payment_method: 'card',
                    status: 'completed',
                    gateway_transaction_id: externalTransactionId || gatewayResult.transactionId,
                    processed_at: now
                }
            };
        }, 'payment:process-card');
    });

    // Save receipt
    ipcMain.handle('payment:save-receipt', async (event, data: {
        id: string;
        transaction_id: string;
        receipt_number: string;
        order_details: any;
        subtotal: number;
        tax: number;
        delivery_fee: number;
        total_amount: number;
        payment_method: string;
        cash_received?: number;
        change_given?: number;
    }) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            await db.insertPaymentReceipt({
                ...data,
                order_details: JSON.stringify(data.order_details)
            });
            return { saved: true };
        }, 'payment:save-receipt');
    });

    // Update receipt status
    ipcMain.handle('payment:update-receipt-status', async (event, data: {
        receiptId: string;
        printed?: boolean;
        emailed?: boolean;
    }) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            await db.updateReceiptStatus(data.receiptId, data.printed, data.emailed);
            return { updated: true };
        }, 'payment:update-receipt-status');
    });

    // Process refund
    ipcMain.handle('payment:process-refund', async (event, data: {
        transactionId: string;
        amount: number;
        reason?: string;
    }) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            const { transactionId, amount, reason } = data;

            // Get original transaction
            const transaction = await db.getPaymentTransaction(transactionId);
            if (!transaction) {
                throw new IPCError('Transaction not found');
            }

            // Check if refund amount is valid
            const existingRefunds = await db.getPaymentRefundsByTransactionId(transactionId);
            const totalRefunded = existingRefunds.reduce((sum, refund) =>
                refund.status === 'completed' ? sum + refund.amount : sum, 0
            );

            if (totalRefunded + amount > transaction.amount) {
                throw new IPCError('Refund amount exceeds transaction amount');
            }

            const refundId = uuidv4();
            const now = new Date().toISOString();

            let refundStatus: 'pending' | 'processing' | 'completed' | 'failed' = 'completed';
            let gatewayRefundId: string | undefined;

            // Process refund through gateway for card payments
            if (transaction.payment_method === 'card' && transaction.gateway_transaction_id) {
                const gatewayResult = await PaymentGateway.processRefund(
                    transaction.gateway_transaction_id,
                    amount
                );

                if (!gatewayResult.success) {
                    refundStatus = 'failed';
                } else {
                    gatewayRefundId = gatewayResult.refundId;
                }
            }

            // Create refund record
            await db.insertPaymentRefund({
                id: refundId,
                transaction_id: transactionId,
                amount,
                reason,
                status: refundStatus,
                gateway_refund_id: gatewayRefundId,
                processed_at: now
            });

            if (refundStatus === 'failed') {
                throw new IPCError('Refund processing failed via gateway');
            }

            return {
                refund: {
                    id: refundId,
                    transaction_id: transactionId,
                    amount,
                    reason,
                    status: refundStatus,
                    gateway_refund_id: gatewayRefundId,
                    processed_at: now
                }
            };
        }, 'payment:process-refund');
    });

    // Get payment transactions for order
    ipcMain.handle('payment:get-transactions', async (event, orderId: string) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            const transactions = await db.getPaymentTransactionsByOrderId(orderId);
            return { transactions };
        }, 'payment:get-transactions');
    });

    // Get receipt by number
    ipcMain.handle('payment:get-receipt', async (event, receiptNumber: string) => {
        return handleIPCError(async () => {
            const db = serviceRegistry.requireService('dbManager');
            const receipt = await db.getPaymentReceiptByNumber(receiptNumber);
            if (!receipt) {
                throw new IPCError('Receipt not found');
            }

            return {
                receipt: {
                    ...receipt,
                    order_details: JSON.parse(receipt.order_details)
                }
            };
        }, 'payment:get-receipt');
    });

    // Simulate receipt printing
    ipcMain.handle('payment:print-receipt', async (event, receiptData, type = 'customer') => {
        return handleIPCError(async () => {
            // In a real implementation, you would:
            // 1. Format the receipt data for the printer
            // 2. Send to thermal printer via USB/network
            // 3. Handle printer errors

            // Simulate printing delay
            await new Promise(resolve => setTimeout(resolve, 1000));

            return { message: 'Receipt printed successfully' };
        }, 'payment:print-receipt');
    });

    // Kitchen ticket printing
    ipcMain.handle('kitchen:print-ticket', async (event, orderData) => {
        return handleIPCError(async () => {
            // Helper function to format customizations/ingredients as modifiers for printing
            const formatItemModifiers = (item: any): string[] => {
                const modifiers: string[] = [];

                // Handle customizations array (from cart items)
                if (item.customizations && Array.isArray(item.customizations)) {
                    for (const customization of item.customizations) {
                        if (customization.ingredient) {
                            // Get ingredient name (prefer localized names)
                            const ingredientName = customization.ingredient.name_el ||
                                customization.ingredient.name_en ||
                                customization.ingredient.name ||
                                'Unknown';

                            // Format with quantity if > 1
                            let modifierText = ingredientName;
                            if (customization.quantity > 1) {
                                modifierText = `${ingredientName} ×${customization.quantity}`;
                            }

                            // Add "little" indicator if applicable
                            if (customization.isLittle) {
                                modifierText += ' (λίγο)'; // Greek for "little"
                            }

                            modifiers.push(modifierText);
                        }
                    }
                }

                // Also handle legacy modifiers array if present
                if (item.modifiers && Array.isArray(item.modifiers)) {
                    modifiers.push(...item.modifiers);
                }

                return modifiers;
            };

            // Format items with modifiers for kitchen ticket
            const formattedItems = (orderData.items || []).map((item: any) => ({
                name: item.name,
                quantity: item.quantity,
                unitPrice: item.price || item.unitPrice || 0,
                total: item.totalPrice || item.total || (item.price * item.quantity) || 0,
                modifiers: formatItemModifiers(item),
                specialInstructions: item.notes || item.specialInstructions || null,
                category: item.category || null
            }));

            // Format kitchen ticket data
            const ticketData = {
                orderNumber: orderData.orderNumber,
                items: formattedItems,
                customerName: orderData.customerName,
                orderType: orderData.orderType,
                tableNumber: orderData.tableNumber,
                notes: orderData.notes,
                createdAt: orderData.createdAt,
                estimatedTime: orderData.estimatedTime,
                printedAt: new Date().toISOString()
            };

            // Log the formatted ticket for debugging
            console.log('=== KITCHEN TICKET ===');
            console.log(`Order #${ticketData.orderNumber} - ${ticketData.orderType}`);
            console.log(`Customer: ${ticketData.customerName || 'Walk-in'}`);
            console.log('Items:');
            for (const item of formattedItems) {
                console.log(`  ${item.quantity}x ${item.name}`);
                if (item.modifiers && item.modifiers.length > 0) {
                    for (const mod of item.modifiers) {
                        console.log(`    + ${mod}`);
                    }
                }
                if (item.specialInstructions) {
                    console.log(`    Note: ${item.specialInstructions}`);
                }
            }
            if (ticketData.notes) {
                console.log(`Order Notes: ${ticketData.notes}`);
            }
            console.log('=== END KITCHEN TICKET ===');

            // Simulate printing delay
            await new Promise(resolve => setTimeout(resolve, 800));

            return { message: 'Kitchen ticket printed successfully' };
        }, 'kitchen:print-ticket');
    });

    // Email receipt (simulation)
    ipcMain.handle('payment:email-receipt', async (event, data: {
        receiptData: any;
        emailAddress: string;
    }) => {
        return handleIPCError(async () => {
            // Simulate email sending delay
            await new Promise(resolve => setTimeout(resolve, 1500));
            return { sent: true };
        }, 'payment:email-receipt');
    });
}
