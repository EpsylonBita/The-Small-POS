
import path from 'path';
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { MoneyFlowTestHelper } from './helpers/money-flow-helpers';

const POS_ROOT = path.resolve(__dirname, '..', '..');

async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({ args: [POS_ROOT] });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    return { app, page };
}

test.describe('Z-Report Money Flow', () => {
    let app: ElectronApplication;
    let page: Page;
    let helper: MoneyFlowTestHelper;
    let staffMembers: any[];

    test.beforeEach(async () => {
        const res = await launchElectron();
        app = res.app;
        page = res.page;
        helper = new MoneyFlowTestHelper(page);
        await helper.cleanupTestData();
        staffMembers = await helper.seedTestStaff();
        await helper.seedTestMenuItems();
        await helper.seedTestCustomers();
    });

    test.afterEach(async () => {
        await helper.cleanupTestData();
        await app.close();
    });

    test('Generate Z-report with multiple staff: cashier, drivers, waiters, kitchen → verify all totals', async () => {
        const cashier = staffMembers.find(s => s.role === 'cashier');
        const driver1 = staffMembers.find(s => s.role === 'driver' && s.name.includes('Driver 1'));
        const driver2 = staffMembers.find(s => s.role === 'driver' && s.name.includes('Driver 2'));
        const waiter = staffMembers.find(s => s.role === 'server');
        const kitchen = staffMembers.find(s => s.role === 'kitchen');

        if (!cashier || !driver1 || !driver2 || !waiter || !kitchen) throw new Error('Missing staff');

        // 2-6 Open shifts
        const cShift = await helper.openCashierShift(cashier.id, 100);
        const d1Shift = await helper.openDriverShift(driver1.id, 20);
        const d2Shift = await helper.openDriverShift(driver2.id, 15);
        const wShift = await helper.openWaiterShift(waiter.id, 30);

        // 7. Create Orders
        // Cashier Pickup: 120 cash, 80 card
        await helper.createPickupOrder([{ name: 'CP1', price: 120 }], 'cash');
        await helper.createPickupOrder([{ name: 'CP2', price: 80 }], 'card');

        // Driver 1: 180 cash, 120 card
        const d1o1 = await helper.createDeliveryOrder([{ name: 'D1O1', price: 180 }], driver1.id, 'cash', 'A1');
        const d1o2 = await helper.createDeliveryOrder([{ name: 'D1O2', price: 120 }], driver1.id, 'card', 'A2');
        await helper.completeOrder(d1o1);
        await helper.completeOrder(d1o2);

        // Driver 2: 150 cash, 100 card
        const d2o1 = await helper.createDeliveryOrder([{ name: 'D2O1', price: 150 }], driver2.id, 'cash', 'A3');
        const d2o2 = await helper.createDeliveryOrder([{ name: 'D2O2', price: 100 }], driver2.id, 'card', 'A4');
        await helper.completeOrder(d2o1);
        await helper.completeOrder(d2o2);

        // Waiter: 100 cash, 80 card
        const w1 = await helper.createDineInOrder([{ name: 'W1', price: 100 }], 'T1', 'cash');
        const w2 = await helper.createDineInOrder([{ name: 'W2', price: 80 }], 'T2', 'card');
        await helper.completeOrder(w1);
        await helper.completeOrder(w2);

        // 8. Expenses
        await helper.recordExpense(cShift, 'supplies', 20, 'C Exp');
        await helper.recordExpense(d1Shift, 'fuel', 10, 'D1 Exp');
        await helper.recordExpense(d2Shift, 'fuel', 8, 'D2 Exp');
        await helper.recordExpense(wShift, 'glass', 5, 'W Exp');

        // 9. Staff Payments
        // Kitchen (assume paid via cashier shift context usually, or just recorded)
        await helper.recordStaffPayment(cShift, kitchen.id, 60, 'wage');

        // Waiter
        await helper.closeWaiterShift(wShift, waiter.id, 50);

        // Drivers
        await helper.closeDriverShift(d1Shift, driver1.id, 40);
        await helper.closeDriverShift(d2Shift, driver2.id, 35);

        // Close Cashier
        await helper.closeCashierShift(cShift, 100);

        // 11. Generate Z-report
        const branchId = await page.evaluate(async () => (window as any).electronAPI.getTerminalBranchId());
        const date = new Date().toISOString().split('T')[0];
        const zReport = await helper.generateZReport(branchId, date);

        // 12. Verify Totals
        // Sales: 200(C) + 300(D1) + 250(D2) + 180(W) = 930
        // Expenses: 20+10+8+5 = 43
        await helper.verifyZReportTotals(zReport, {
            totalSales: 930,
            totalCash: 550, // 120 + 180 + 150 + 100
            totalCard: 380, // 80 + 120 + 100 + 80
            totalExpenses: 43
        });

        // 13. Verify breakdown
        await helper.verifyZReportStaffBreakdown(zReport, [{
            name: driver1.name,
            role: 'driver',
            totalOrders: 2,
            totalSales: 300,
            cashSales: 180,
            cardSales: 120
        }]);

        // 15. Submit
        const submissionId = await helper.submitZReportToAdmin(branchId, date);

        // 16. Verify DB
        const rows = await helper.executeQuery("SELECT * FROM pos_daily_z_reports WHERE report_date = ?", [date]);
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(submissionId);
    });
});
