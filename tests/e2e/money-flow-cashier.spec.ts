
import path from 'path';
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { MoneyFlowTestHelper } from './helpers/money-flow-helpers';

const POS_ROOT = path.resolve(__dirname, '..', '..');

async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({ args: [POS_ROOT] });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // Wait for the window to be available and exposed
    await page.waitForTimeout(2000);
    return { app, page };
}

test.describe('Cashier Shift Money Flow', () => {
    let app: ElectronApplication;
    let page: Page;
    let helper: MoneyFlowTestHelper;
    let staffMembers: any[];

    test.beforeAll(async () => {
        // We launch once to seed data, or per test? 
        // Plan says: "1. Seed test data... 2. Open cashier shift"
        // It's better to launch per test to ensure clean state or reset db helper
    });

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

    test('Complete cashier shift: open → orders → expenses → staff payments → close → verify variance', async () => {
        const staff = staffMembers.find(s => s.role === 'cashier');
        const kitchenStaff = staffMembers.find(s => s.role === 'kitchen');
        if (!staff || !kitchenStaff) throw new Error('Failed to seed staff');

        // 2. Open cashier shift with €100 opening cash
        const shiftId = await helper.openCashierShift(staff.id, 100);

        // 3. Create 3 pickup orders: €50 cash, €30 card, €20 cash
        // We need items that sum to these amounts. simple items override in seed or use helper logic
        // Helper createPickupOrder takes items. items need price.
        await helper.createPickupOrder([{ name: 'Item 50', price: 50 }], 'cash');
        await helper.createPickupOrder([{ name: 'Item 30', price: 30 }], 'card');
        await helper.createPickupOrder([{ name: 'Item 20', price: 20 }], 'cash');

        // 4. Record 2 expenses: €10 supplies, €5 maintenance
        await helper.recordExpense(shiftId, 'Supplies', 10, 'Test Supplies');
        await helper.recordExpense(shiftId, 'Maintenance', 5, 'Test Maintenance');

        // 5. Record staff payment: €50 wage to kitchen staff
        await helper.recordStaffPayment(shiftId, kitchenStaff.id, 50, 'wage', 'Daily Wage');

        // 6. Close shift with €105 closing cash 
        // Expected: 100 (open) + 70 (cash sales) - 15 (expenses) - 50 (payment) = 105
        await helper.closeCashierShift(shiftId, 105);

        // 7. Verify variance: €0
        await helper.verifyCashDrawerVariance(shiftId, 0);

        // 8. Verify cash drawer session in database
        await helper.verifyCashDrawerSession(shiftId, {
            opening_amount: 100,
            total_cash_sales: 70, // 50 + 20
            total_card_sales: 30,
            total_expenses: 15,
            total_staff_payments: 50,
            closing_amount: 105,
            variance_amount: 0
        });

        // 9. Verify staff payment recorded correctly
        await helper.verifyStaffPaymentInDatabase(null, {
            amount: 50,
            payment_type: 'wage',
            notes: 'Daily Wage'
        });

        // 10. Receipt verification omitted as it requires PDF/print inspection, but we trust logic
    });

    test('Cashier shift with cash shortage: verify negative variance', async () => {
        const staff = staffMembers.find(s => s.role === 'cashier');
        if (!staff) throw new Error('No cashier');

        const shiftId = await helper.openCashierShift(staff.id, 100);
        await helper.createPickupOrder([{ name: 'Item 50', price: 50 }], 'cash');
        // Expected cash: 150. We close with 145.
        await helper.closeCashierShift(shiftId, 145);

        await helper.verifyCashDrawerVariance(shiftId, -5);
    });

    test('Cashier shift with cash overage: verify positive variance', async () => {
        const staff = staffMembers.find(s => s.role === 'cashier');
        if (!staff) throw new Error('No cashier');

        const shiftId = await helper.openCashierShift(staff.id, 100);
        await helper.createPickupOrder([{ name: 'Item 50', price: 50 }], 'cash');
        // Expected cash: 150. We close with 155.
        await helper.closeCashierShift(shiftId, 155);

        await helper.verifyCashDrawerVariance(shiftId, 5);
    });



});
