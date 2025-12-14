/**
 * Waiter Checkout Print Template
 * 80mm thermal printer format
 */

import { ShiftSummary, ShiftExpense } from '../../renderer/types/shift';

export function generateWaiterCheckoutReceipt(summary: ShiftSummary, terminalName?: string, paperWidth: number = 48): string {
    const { shift, waiterTables = [] } = summary;

    const checkInDate = new Date(shift.check_in_time);
    const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

    // Calculate totals
    // Calculate totals
    const totalTables = waiterTables.length;
    // Each table has an 'orders' array inside
    const totalOrders = waiterTables.reduce((sum, table) => sum + table.order_count, 0);

    const totalCashAmount = waiterTables.reduce((sum, table) => sum + table.cash_amount, 0);
    const totalCardAmount = waiterTables.reduce((sum, table) => sum + table.card_amount, 0);
    // Cash collected is sum of cash amounts from all tables
    const totalCashCollected = totalCashAmount;

    const startingAmount = shift.opening_cash_amount || 0;
    const expenses = summary.expenses.reduce((sum: number, e: ShiftExpense) => sum + e.amount, 0);
    const paymentAmount = shift.payment_amount || 0;

    // Comment 1: Consistency with driver formula (Cash to Return = Cash Collected + Starting Amount - Expenses - Payment)
    // Wait... driver template uses:
    // const cashToReturn = totalCashCollected - startingAmount - expenses - paymentAmount;
    // Wait, let's re-read Comment 1 carefully.
    // "If you want consistency with drivers, update cashToReturn to match the driver calculation... by SUBTRACTING startingAmount rather than adding it"
    // Driver template (checked in step 166): const cashToReturn = totalCashCollected - startingAmount - expenses - paymentAmount;
    // Wait, if driver starts with 50 and collects 100 in cash. Total cash on hand is 150.
    // If they return everything, it should be 150.
    // If driver template subtracts startingAmount, it means they are ONLY returning what they collected?
    // OR they are expected to RETAIN the starting amount?
    // "Driver: totalCashCollected - startingAmount..."
    // If I start with 50, collect 100. Formula: 100 - 50 = 50. This implies returning ONLY the profit above float, keeping the float?
    // OR it implies the "startingAmount" was already recorded as a negative balance?
    // Actually, usually: Net Cash = (Opening + Sales) - Expenses.
    // If Driver Template subtracts it, maybe it assumes the driver KEEPS the float.
    // Comment 1 says: "Update cashToReturn to match the driver calculation by subtracting startingAmount rather than adding it"
    // So I will follow the instruction explicitly for consistency.

    const cashToReturn = totalCashCollected - startingAmount - expenses - paymentAmount;

    // ... (helper functions same as before) ...
    const formatDate = (date: Date) => {
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
    };

    const formatTime = (date: Date) => {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    };

    const formatCurrency = (amount: number) => {
        return `€${amount.toFixed(2)}`;
    };

    const line = (char: string = '-', length: number = paperWidth) => char.repeat(length);
    const center = (text: string, width: number = paperWidth) => {
        const padding = Math.max(0, Math.floor((width - text.length) / 2));
        return ' '.repeat(padding) + text;
    };
    const leftRight = (left: string, right: string, width: number = paperWidth) => {
        const spaces = Math.max(1, width - left.length - right.length);
        return left + ' '.repeat(spaces) + right;
    };

    let receipt = '';

    // Header
    receipt += '\n';
    receipt += line('=') + '\n';
    receipt += center('WAITER CHECKOUT') + '\n';
    receipt += line('=') + '\n';
    receipt += '\n';

    if (terminalName) {
        receipt += center(terminalName) + '\n';
    }

    receipt += center(formatDate(checkOutDate)) + '\n';
    receipt += center(formatTime(checkOutDate)) + '\n';
    receipt += '\n';
    receipt += line() + '\n';
    receipt += '\n';

    // Staff Information
    receipt += 'WAITER INFORMATION\n';
    receipt += line() + '\n';
    receipt += leftRight('Name:', shift.staff_id) + '\n';
    receipt += leftRight('Shift ID:', shift.id.substring(0, 8)) + '\n';
    receipt += leftRight('Check-In:', formatTime(checkInDate)) + '\n';
    receipt += leftRight('Check-Out:', formatTime(checkOutDate)) + '\n';
    receipt += '\n';

    // Table Summary
    let canceledOrders = 0;
    let cashOrdersCount = 0;
    let cardOrdersCount = 0;

    waiterTables.forEach(table => {
        // Comment 4: Null safety for orders
        const orders = Array.isArray(table.orders) ? table.orders : [];
        orders.forEach((order: any) => {
            const s = (order.status || '').toLowerCase();
            if (s === 'cancelled' || s === 'canceled') {
                canceledOrders++;
            }
            // Comment 5: Explicit payment method check
            const pm = (order.payment_method || '').toLowerCase();
            if (pm === 'cash') cashOrdersCount++;
            else if (pm === 'card') cardOrdersCount++;
            // Mixed or other are not added to pure cash/card counts, or could be tracked separately. 
            // Previous code put all non-cash into card. 
            // Comment 5 says "Explicitly inspect... Increment cash... Increment card... For 'mixed' either track separately or decide".
            // I will only count pure cash and card here to be accurate, or track 'other'.
            // For summary simplicity, I'll stick to incrementing them if they matched. If mixed, maybe don't increment either or increment a new one?
            // "Make a similar change... avoiding a blanket else that treats every non-cash method as card"
            // I will skip counting 'mixed' in these two counters to be precise.
        });
    });

    receipt += 'TABLE SUMMARY\n';
    receipt += line() + '\n';
    receipt += leftRight('Total Tables:', totalTables.toString()) + '\n';
    receipt += leftRight('Total Orders:', totalOrders.toString()) + '\n';
    if (canceledOrders > 0) {
        receipt += leftRight('  Canceled:', canceledOrders.toString()) + '\n';
    }
    receipt += leftRight('  Cash Orders:', cashOrdersCount + ' - ' + formatCurrency(totalCashAmount)) + '\n';
    receipt += leftRight('  Card Orders:', cardOrdersCount + ' - ' + formatCurrency(totalCardAmount)) + '\n';
    receipt += line() + '\n';
    receipt += leftRight('TOTAL:', formatCurrency(totalCashAmount + totalCardAmount)) + '\n';
    receipt += '\n';

    // Table Details
    // ✓ = completed, ✗ = canceled, 💵 = cash, 💳 = card, 💵+💳 = mixed
    if (waiterTables.length > 0) {
        receipt += 'TABLE DETAILS\n';
        receipt += line() + '\n';
        receipt += 'Table | Orders | Amount  | Status\n';
        receipt += line() + '\n';

        waiterTables.forEach(table => {
            const tableNum = (table.table_number || 'N/A').substring(0, 6);
            const orders = Array.isArray(table.orders) ? table.orders : []; // Comment 4
            const orderCountStr = table.order_count.toString();
            const amount = formatCurrency(table.total_amount).padStart(7);

            // Status symbols aggregation
            const hasActive = orders.some((o: any) => {
                const s = (o.status || '').toLowerCase();
                return s !== 'cancelled' && s !== 'canceled';
            });
            const statusSymbol = hasActive ? '✓' : '✗';

            // Payment symbol for table
            let paymentSymbol = '💳';
            if (table.payment_method === 'cash') paymentSymbol = '💵';
            else if (table.payment_method === 'mixed') paymentSymbol = '💵+💳';
            else paymentSymbol = '💳';

            receipt += `${tableNum.padEnd(6)}| ${orderCountStr.padEnd(7)}| ${amount} | ${statusSymbol}${paymentSymbol}\n`;
        });

        receipt += line() + '\n';
        receipt += '\n';
    }

    // Cash Reconciliation
    receipt += line('=') + '\n';
    receipt += 'CASH RECONCILIATION\n';
    receipt += line('=') + '\n';
    receipt += leftRight('Starting Amount:', formatCurrency(startingAmount)) + '\n';
    receipt += leftRight('Cash Collected:', formatCurrency(totalCashCollected)) + '\n';
    receipt += leftRight('Expenses:', formatCurrency(expenses)) + '\n';
    receipt += leftRight('Payment:', formatCurrency(paymentAmount)) + '\n';
    receipt += line() + '\n';

    const returnLabel = cashToReturn >= 0 ? 'Cash to Return:' : 'Shortage:';
    const returnAmount = Math.abs(cashToReturn);
    receipt += leftRight(returnLabel, formatCurrency(returnAmount)) + '\n';
    receipt += line('=') + '\n';
    receipt += '\n';

    if (cashToReturn < 0) {
        receipt += center('*** SHORTAGE - WILL BE DEDUCTED ***') + '\n';
        receipt += '\n';
    }

    // Signature
    receipt += '\n';
    receipt += line() + '\n';
    receipt += '\n';
    receipt += 'WAITER SIGNATURE:\n';
    receipt += '\n';
    receipt += 'X_______________________________\n';
    receipt += '\n';
    receipt += 'MANAGER SIGNATURE:\n';
    receipt += '\n';
    receipt += 'X_______________________________\n';
    receipt += '\n';
    receipt += line() + '\n';
    receipt += '\n';
    receipt += center('Thank you for your service!') + '\n';
    receipt += '\n';
    receipt += '\n';
    receipt += '\n';

    return receipt;
}
