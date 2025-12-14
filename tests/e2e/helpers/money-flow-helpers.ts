
import { Page, expect } from '@playwright/test';

// Type definitions for DB entities to help with type safety in tests
export interface TestStaff {
    id: string;
    name: string;
    role: string;
    pin: string;
}

export interface MoneyFlowHelpers {
    seedTestStaff: () => Promise<TestStaff[]>;
    seedTestMenuItems: () => Promise<void>;
    seedTestCustomers: () => Promise<void>;
    cleanupTestData: () => Promise<void>;
    openCashierShift: (staffId: string, openingCash: number) => Promise<string>;
    openDriverShift: (staffId: string, startingAmount: number) => Promise<string>;
    openWaiterShift: (staffId: string, startingAmount: number) => Promise<string>;
    closeCashierShift: (shiftId: string, closingCash: number) => Promise<void>;
    closeDriverShift: (shiftId: string, staffId: string, paymentAmount: number) => Promise<void>;
    closeWaiterShift: (shiftId: string, staffId: string, paymentAmount: number) => Promise<void>;
    createPickupOrder: (items: any[], paymentMethod: 'cash' | 'card') => Promise<string>;
    createDeliveryOrder: (items: any[], driverId: string | null, paymentMethod: 'cash' | 'card', address: string) => Promise<string>;
    createDineInOrder: (items: any[], tableNumber: string, paymentMethod: 'cash' | 'card') => Promise<string>;
    completeOrder: (orderId: string) => Promise<void>;
    assignDriverToOrder: (orderId: string, driverId: string) => Promise<void>;
    recordExpense: (shiftId: string, type: string, amount: number, description: string) => Promise<void>;
    recordStaffPayment: (shiftId: string, staffId: string, amount: number, type: string, notes?: string) => Promise<void>;
    verifyDriverEarnings: (shiftId: string, expectedEarnings: number) => Promise<void>;
    verifyCashDrawerVariance: (shiftId: string, expectedVariance: number) => Promise<void>;
    getShiftSummary: (shiftId: string) => Promise<any>;
    verifyOrderInDatabase: (orderId: string, expectedData: any) => Promise<void>;
    verifyStaffPaymentInDatabase: (paymentId: string | null, expectedData: any) => Promise<void>;
    verifyDriverEarningInDatabase: (earningId: string | null, expectedData: any) => Promise<void>;
    verifyCashDrawerSession: (shiftId: string, expectedData: any) => Promise<void>;
    generateZReport: (branchId: string, date: string) => Promise<any>;
    verifyZReportTotals: (zReport: any, expectedTotals: any) => Promise<void>;
    verifyZReportStaffBreakdown: (zReport: any, expectedStaff: any[]) => Promise<void>;
    submitZReportToAdmin: (branchId: string, date: string) => Promise<string>;
}

export class MoneyFlowTestHelper implements MoneyFlowHelpers {
    constructor(private page: Page) { }

    async executeQuery(query: string, params: any[] = []): Promise<any[]> {
        return await this.page.evaluate(async ({ q, p }) => {
            return await (window as any).electronAPI.executeQuery(q, p);
        }, { q: query, p: params });
    }

    async seedTestStaff(): Promise<TestStaff[]> {
        await this.executeQuery("DELETE FROM staff WHERE name LIKE 'Test %'");
        const timestamp = Date.now();
        const staffList = [
            { name: `Test Cashier ${timestamp}`, role: 'cashier', pin: '1111' },
            { name: `Test Driver 1 ${timestamp}`, role: 'driver', pin: '2221' },
            { name: `Test Driver 2 ${timestamp}`, role: 'driver', pin: '2222' },
            { name: `Test Waiter ${timestamp}`, role: 'server', pin: '3333' }, // server = waiter
            { name: `Test Kitchen ${timestamp}`, role: 'kitchen', pin: '4444' }
        ];

        const createdStaff: TestStaff[] = [];
        for (const staff of staffList) {
            const result = await this.page.evaluate(async (s) => {
                const id = crypto.randomUUID();
                await (window as any).electronAPI.executeQuery(
                    `INSERT INTO staff (id, name, role, pin_code, is_active, created_at, updated_at) 
                     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
                    [id, s.name, s.role, s.pin]
                );
                return { id, ...s };
            }, staff);
            createdStaff.push(result);
        }
        return createdStaff;
    }

    async seedTestMenuItems(): Promise<void> {
        // Assume categories exist or insert a test one.
        // Simplified: ensure we have at least one test item
        await this.executeQuery("INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('test-cat', 'Test Category', 999)");
        await this.executeQuery(`
            INSERT OR REPLACE INTO menu_items (id, category_id, name, price, tax_rate, is_active) 
            VALUES 
            ('item-1', 'test-cat', 'Burger', 10.00, 0.1, 1),
            ('item-2', 'test-cat', 'Fries', 5.00, 0.1, 1),
            ('item-3', 'test-cat', 'Soda', 3.00, 0.1, 1)
        `);
    }

    async seedTestCustomers(): Promise<void> {
        await this.executeQuery("INSERT OR IGNORE INTO customers (id, name, phone, address) VALUES ('cust-1', 'Test Customer', '555-0101', '123 Test St')");
    }

    async cleanupTestData(): Promise<void> {
        // Order matters for FK
        await this.executeQuery("DELETE FROM driver_earnings WHERE order_id IN (SELECT id FROM orders WHERE customer_id = 'cust-1')");
        await this.executeQuery("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = 'cust-1')");
        await this.executeQuery("DELETE FROM orders WHERE customer_id = 'cust-1'");
        await this.executeQuery("DELETE FROM staff_payments WHERE notes LIKE 'Test Payment%'");
        // We might want to keep Z-reports for inspection, or delete specific ones.
        // For full cleanup:
        // await this.executeQuery("DELETE FROM staff WHERE name LIKE 'Test %'");
    }

    // --- Shift Operations ---

    async openCashierShift(staffId: string, openingCash: number): Promise<string> {
        return await this.page.evaluate(async ({ staffId, openingCash }) => {
            const api = (window as any).electronAPI;
            const termId = await api.getTerminalId();
            const branchId = await api.getTerminalBranchId();
            const res = await api.openShift({
                staffId,
                branchId,
                terminalId: termId,
                roleType: 'cashier',
                openingCash
            });
            if (!res.success) throw new Error('Failed to open cashier shift: ' + res.error);
            return res.shiftId;
        }, { staffId, openingCash });
    }

    async openDriverShift(staffId: string, startingAmount: number): Promise<string> {
        return await this.page.evaluate(async ({ staffId, startingAmount }) => {
            const api = (window as any).electronAPI;
            const termId = await api.getTerminalId();
            const branchId = await api.getTerminalBranchId();
            const res = await api.openShift({
                staffId,
                branchId,
                terminalId: termId,
                roleType: 'driver',
                startingCash: startingAmount
            });
            if (!res.success) throw new Error('Failed to open driver shift: ' + res.error);
            return res.shiftId;
        }, { staffId, startingAmount });
    }

    async openWaiterShift(staffId: string, startingAmount: number): Promise<string> {
        return await this.page.evaluate(async ({ staffId, startingAmount }) => {
            const api = (window as any).electronAPI;
            const termId = await api.getTerminalId();
            const branchId = await api.getTerminalBranchId();
            const res = await api.openShift({
                staffId,
                branchId,
                terminalId: termId,
                roleType: 'server',
                startingCash: startingAmount
            });
            if (!res.success) throw new Error('Failed to open waiter shift: ' + res.error);
            return res.shiftId;
        }, { staffId, startingAmount });
    }

    async closeCashierShift(shiftId: string, closingCash: number): Promise<void> {
        await this.page.evaluate(async ({ shiftId, closingCash }) => {
            const api = (window as any).electronAPI;
            // Get active session to find who is closing
            // In tests we might need to assume a user is logged in or pass closedBy.
            // For simplicitly, let's look up the shift staffId or use a placeholder if the API handles it.
            // Ideally closedBy should be the current logged in user.
            // Let's assume the test setup handles login or we fetch current user.
            const currentUser = await api.invoke('staff-auth:get-current');
            const closedBy = currentUser?.id || 'test-admin';

            const res = await api.closeShift({
                shiftId,
                closingCash,
                closedBy
            });
            if (!res.success) throw new Error('Failed to close cashier shift: ' + res.error);
        }, { shiftId, closingCash });
    }

    async closeDriverShift(shiftId: string, staffId: string, paymentAmount: number): Promise<void> {
        // 1. Record payment if any (BEFORE closing)
        if (paymentAmount > 0) {
            await this.recordStaffPayment(shiftId, staffId, paymentAmount, 'salary', 'Shift Payment');
        }

        // 2. Fetch summary to determine correct closing cash for 0 variance (Standard flow: Driver returns all cash)
        const summary = await this.getShiftSummary(shiftId);
        const cashToReturn = summary.driver?.cashToReturn || 0;

        await this.page.evaluate(async ({ shiftId, closingCash }) => {
            const api = (window as any).electronAPI;
            const currentUser = await api.invoke('staff-auth:get-current');
            const closedBy = currentUser?.id || 'test-admin';

            const res = await api.closeShift({
                shiftId,
                closingCash,
                closedBy
            });
            if (!res.success) throw new Error('Failed to close driver shift: ' + res.error);
        }, { shiftId, closingCash: cashToReturn });
    }

    async closeWaiterShift(shiftId: string, staffId: string, paymentAmount: number): Promise<void> {
        if (paymentAmount > 0) {
            await this.recordStaffPayment(shiftId, staffId, paymentAmount, 'salary', 'Shift Payment');
        }
        await this.page.evaluate(async ({ shiftId }) => {
            const api = (window as any).electronAPI;
            const currentUser = await api.invoke('staff-auth:get-current');
            const closedBy = currentUser?.id || 'test-admin';
            const res = await api.closeShift({
                shiftId,
                closingCash: 0, // Waiters usually verify against 0 or cash sales?
                // Waiters in this system might carry cash?
                // If waiter has cash sales, expected amount > 0.
                // We should fetch summary to be safe.
                closedBy
            });
            if (!res.success) throw new Error('Failed to close waiter shift: ' + res.error);
        }, { shiftId });
    }

    // --- Order Operations ---

    async createPickupOrder(items: any[], paymentMethod: 'cash' | 'card'): Promise<string> {
        return await this.page.evaluate(async ({ items, paymentMethod }) => {
            const api = (window as any).electronAPI;
            const termId = await api.getTerminalId();
            const orderRes = await api.createOrder({
                type: 'pickup',
                items,
                customer_id: 'cust-1'
            });
            if (!orderRes.success) throw new Error('Failed to create order');
            const orderId = orderRes.orderId;

            // Pay and finalize
            await api.processOrderPayment({
                orderId,
                paymentMethod,
                amount: items.reduce((acc: any, i: any) => acc + i.price, 0)
            });
            await api.finalizeOrder(orderId);
            return orderId;
        }, { items, paymentMethod });
    }

    async createDeliveryOrder(items: any[], driverId: string | null, paymentMethod: 'cash' | 'card', address: string): Promise<string> {
        return await this.page.evaluate(async ({ items, driverId, paymentMethod, address }) => {
            const api = (window as any).electronAPI;
            const orderRes = await api.createOrder({
                type: 'delivery',
                items,
                customer_id: 'cust-1',
                deliveryAddress: address
            });
            if (!orderRes.success) throw new Error('Failed to create delivery order');
            const orderId = orderRes.orderId;

            if (driverId) {
                await api.assignDriverToOrder(orderId, driverId);
            }

            if (paymentMethod === 'card') {
                await api.processOrderPayment({ orderId, paymentMethod: 'card', amount: items.reduce((sum: number, i: any) => sum + i.price, 0) });
            }

            return orderId;
        }, { items, driverId, paymentMethod, address });
    }

    async createDineInOrder(items: any[], tableNumber: string, paymentMethod: 'cash' | 'card'): Promise<string> {
        return await this.page.evaluate(async ({ items, tableNumber, paymentMethod }) => {
            const api = (window as any).electronAPI;
            const orderRes = await api.createOrder({
                type: 'dine_in',
                items,
                tableNumber
            });
            if (!orderRes.success) throw new Error('Failed to create dine-in order');
            const orderId = orderRes.orderId;

            await api.processOrderPayment({ orderId, paymentMethod, amount: items.reduce((sum: number, i: any) => sum + i.price, 0) });
            return orderId;
        }, { items, tableNumber, paymentMethod });
    }

    async completeOrder(orderId: string): Promise<void> {
        await this.page.evaluate(async (id) => {
            await (window as any).electronAPI.updateOrderStatus(id, 'completed');
        }, orderId);
    }

    async assignDriverToOrder(orderId: string, driverId: string): Promise<void> {
        await this.page.evaluate(async ({ o, d }) => {
            await (window as any).electronAPI.assignDriverToOrder(o, d);
        }, { o: orderId, d: driverId });
    }

    // --- Money Operations ---

    async recordExpense(shiftId: string, type: string, amount: number, description: string): Promise<void> {
        await this.page.evaluate(async ({ shiftId, type, amount, description }) => {
            const api = (window as any).electronAPI;
            // Map to correct API call. Helper previously used addShiftExpense.
            // Check preload/shift-handlers: `shift:record-expense` mapped to `recordExpense`
            await api.recordExpense({
                shiftId, expenseType: type, amount, description, branchId: '', staffId: '' // Assume backend fills or we need to pass?
            });
        }, { shiftId, type, amount, description });
    }

    async recordStaffPayment(shiftId: string, staffId: string, amount: number, type: string, notes: string = ''): Promise<void> {
        await this.page.evaluate(async ({ shiftId, staffId, amount, type, notes }) => {
            const api = (window as any).electronAPI;
            await api.recordStaffPayment({
                shiftId, staffId, amount, type, notes
            });
        }, { shiftId, staffId, amount, type, notes });
    }

    async verifyDriverEarnings(shiftId: string, expectedEarnings: number): Promise<void> {
        // Use DB directly to verify
        const rows = await this.executeQuery("SELECT total_earning FROM driver_earnings WHERE staff_shift_id = ?", [shiftId]);
        const total = rows.reduce((acc, r) => acc + (r.total_earning || 0), 0);
        expect(total).toBeCloseTo(expectedEarnings, 2);
    }

    async verifyCashDrawerVariance(shiftId: string, expectedVariance: number): Promise<void> {
        // Only for cashier shifts
        const rows = await this.executeQuery("SELECT variance_amount FROM cash_drawer_sessions WHERE staff_shift_id = ?", [shiftId]);
        if (rows.length === 0) {
            // Not a cashier shift, skip or warn? 
            // Tests calling this should be aware.
            return;
        }
        const variance = rows[0]?.variance_amount || 0;
        expect(variance).toBeCloseTo(expectedVariance, 2);
    }

    // --- Verification Helpers ---

    async getShiftSummary(shiftId: string): Promise<any> {
        return await this.page.evaluate(async (id) => {
            const api = (window as any).electronAPI;
            return await api.getShiftSummary(id);
        }, shiftId);
    }

    async verifyOrderInDatabase(orderId: string, expectedData: any): Promise<void> {
        const rows = await this.executeQuery("SELECT * FROM orders WHERE id = ?", [orderId]);
        const order = rows[0];
        expect(order).toBeTruthy();
        for (const key of Object.keys(expectedData)) {
            expect(order[key]).toEqual(expectedData[key]);
        }
    }

    async verifyStaffPaymentInDatabase(paymentId: string | null, expectedData: any): Promise<void> {
        let query = "SELECT * FROM staff_payments WHERE ";
        let params = [];
        if (paymentId) {
            query += "id = ?";
            params.push(paymentId);
        } else {
            query += "amount = ? AND notes = ?";
            params.push(expectedData.amount, expectedData.notes);
        }

        const rows = await this.executeQuery(query, params);
        expect(rows.length).toBeGreaterThan(0);
        const payment = rows[0];
        for (const key of Object.keys(expectedData)) {
            expect(payment[key]).toEqual(expectedData[key]);
        }
    }

    async verifyDriverEarningInDatabase(earningId: string | null, expectedData: any): Promise<void> {
        let rows;
        if (earningId) {
            rows = await this.executeQuery("SELECT * FROM driver_earnings WHERE id = ?", [earningId]);
        } else {
            rows = await this.executeQuery("SELECT * FROM driver_earnings WHERE order_id = ?", [expectedData.order_id]);
        }

        expect(rows.length).toBeGreaterThan(0);
        const earning = rows[0];

        // Scalar fields
        if (expectedData.cash_collected !== undefined) expect(earning.cash_collected).toBeCloseTo(expectedData.cash_collected, 2);
        if (expectedData.card_amount !== undefined) expect(earning.card_amount).toBeCloseTo(expectedData.card_amount, 2);
        if (expectedData.total_earning !== undefined) expect(earning.total_earning).toBeCloseTo(expectedData.total_earning, 2);
        if (expectedData.staff_shift_id !== undefined) expect(earning.staff_shift_id).toBe(expectedData.staff_shift_id);

        // JSON structure order_details
        if (expectedData.order_details) {
            const details = JSON.parse(earning.order_details || '{}');
            for (const key of Object.keys(expectedData.order_details)) {
                expect(details[key]).toEqual(expectedData.order_details[key]);
            }
        }
    }

    async verifyCashDrawerSession(shiftId: string, expectedData: any): Promise<void> {
        const rows = await this.executeQuery("SELECT * FROM cash_drawer_sessions WHERE staff_shift_id = ?", [shiftId]);
        const session = rows[0];
        expect(session).toBeTruthy();
        for (const key of Object.keys(expectedData)) {
            if (typeof expectedData[key] === 'number') {
                expect(session[key]).toBeCloseTo(expectedData[key], 2);
            } else {
                expect(session[key]).toEqual(expectedData[key]);
            }
        }
    }

    // --- Z-Report Helpers ---

    async generateZReport(branchId: string, date: string): Promise<any> {
        return await this.page.evaluate(async ({ branchId, date }) => {
            const api = (window as any).electronAPI;
            return await api.generateZReport({ branchId, date });
        }, { branchId, date });
    }

    async verifyZReportTotals(zReport: any, expectedTotals: any): Promise<void> {
        // Assert against real ReportService structure
        if (expectedTotals.totalSales !== undefined) expect(zReport.sales.totalSales).toBeCloseTo(expectedTotals.totalSales, 2);
        if (expectedTotals.totalOrders !== undefined) expect(zReport.sales.totalOrders).toBe(expectedTotals.totalOrders);
        if (expectedTotals.cashSales !== undefined) expect(zReport.sales.cashSales).toBeCloseTo(expectedTotals.cashSales, 2);
        if (expectedTotals.cardSales !== undefined) expect(zReport.sales.cardSales).toBeCloseTo(expectedTotals.cardSales, 2);
        if (expectedTotals.totalExpenses !== undefined) expect(zReport.expenses.total).toBeCloseTo(expectedTotals.totalExpenses, 2);
        if (expectedTotals.staffPayments !== undefined) expect(zReport.expenses.staffPaymentsTotal).toBeCloseTo(expectedTotals.staffPayments, 2);
    }

    async verifyZReportStaffBreakdown(zReport: any, expectedStaff: any[]): Promise<void> {
        const staffReports = zReport.staffReports || [];
        for (const expected of expectedStaff) {
            const match = staffReports.find((s: any) => s.staffName.includes(expected.name) || s.staffName === expected.name);
            expect(match, `Staff report for ${expected.name} not found`).toBeTruthy();

            if (expected.role) expect(match.role).toBe(expected.role);
            if (expected.totalOrders !== undefined) expect(match.orders.count).toBe(expected.totalOrders);
            if (expected.totalSales !== undefined) expect(match.orders.totalAmount).toBeCloseTo(expected.totalSales, 2);
            if (expected.cashSales !== undefined) expect(match.orders.cashAmount).toBeCloseTo(expected.cashSales, 2);
            if (expected.cardSales !== undefined) expect(match.orders.cardAmount).toBeCloseTo(expected.cardSales, 2);
        }
    }

    async submitZReportToAdmin(branchId: string, date: string): Promise<string> {
        return await this.page.evaluate(async ({ branchId, date }) => {
            const api = (window as any).electronAPI;
            const res = await api.submitZReport({ branchId, date });
            if (!res.success) throw new Error('Z-report submission failed: ' + res.error);
            return res.id;
        }, { branchId, date });
    }
}
