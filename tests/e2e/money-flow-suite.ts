
import { test } from '@playwright/test';

// Master suite that imports other specs to run them in a single process/context if needed.
// Note: Running this file directly will execute tests defined in the imported files.
// Ensure you don't run this AND the individual files in the same run to avoid duplicates.

import './money-flow-cashier.spec';
import './money-flow-driver.spec';
import './money-flow-waiter.spec';
import './money-flow-cashier-handover.spec';
import './money-flow-z-report.spec';

test.describe('Money Flow Master Suite', () => {
    // Global Setup/Teardown for the suite if needed
    test.beforeAll(async () => {
        console.log('Starting Money Flow Master Suite');
    });

    test.afterAll(async () => {
        console.log('Completed Money Flow Master Suite');
    });
});
