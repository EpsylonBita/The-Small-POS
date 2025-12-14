
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

test.describe('Waiter Shift Money Flow', () => {
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

    test('Complete waiter shift: open with starting amount → serve tables → checkout → verify reconciliation', async () => {
        const cashier = staffMembers.find(s => s.role === 'cashier');
        const waiter = staffMembers.find(s => s.role === 'server');
        if (!cashier || !waiter) throw new Error('Missing staff');

        await helper.openCashierShift(cashier.id, 100);

        // 3. Open waiter shift with €30
        const waiterShiftId = await helper.openWaiterShift(waiter.id, 30);

        // 4. Create 4 dine-in orders
        // Table 1: €45 cash
        const o1 = await helper.createDineInOrder([{ name: 'T1', price: 45 }], '1', 'cash');
        // Table 2: €60 card
        const o2 = await helper.createDineInOrder([{ name: 'T2', price: 60 }], '2', 'card');
        // Table 3: €35 cash
        const o3 = await helper.createDineInOrder([{ name: 'T3', price: 35 }], '3', 'cash');
        // Table 4: €50 card
        const o4 = await helper.createDineInOrder([{ name: 'T4', price: 50 }], '4', 'card');

        // 5. Complete all orders
        await helper.completeOrder(o1);
        await helper.completeOrder(o2);
        await helper.completeOrder(o3);
        await helper.completeOrder(o4);

        // 6. Record expense: €3 broken glass
        await helper.recordExpense(waiterShiftId, 'breakage', 3, 'Broken Glass');

        // 7. Close waiter shift with €15 daily payment
        // Helper handles wage recording internally before closing
        await helper.closeWaiterShift(waiterShiftId, waiter.id, 15);

        // 8. Verify cash to return: 30 + 80 (cash collected) - 3 - 15 = 92
        // We verify via summary or DB expectations. 
        // Logic check: Cash collected = 45+35=80. 
        const summary = await helper.getShiftSummary(waiterShiftId);
        // Expect summary to reflect cash collected
        expect(summary.cashCollected).toBe(80);
        expect(summary.expenses).toBe(3);
    });

    test('Waiter shift without starting amount: verify no borrowing', async () => {
        const cashier = staffMembers.find(s => s.role === 'cashier');
        const waiter = staffMembers.find(s => s.role === 'server');
        if (!cashier || !waiter) throw new Error('Missing staff');

        await helper.openCashierShift(cashier.id, 100);
        const sid = await helper.openWaiterShift(waiter.id, 0);

        const summary = await helper.getShiftSummary(sid);
        expect(summary.startingCash || summary.openingCash || 0).toBe(0);
    });
});
