// Use --configLoader runner so Vite never bundles into the shared node_modules junction.
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const aliases = { '@': 'src', '@renderer': 'src/renderer', '@shared': 'src/shared', '@config': 'src/config', '@services': 'src/services', '@lib': 'src/lib' };
export default {
  root, cacheDir: '.cache/desk-b',
  resolve: { alias: Object.fromEntries(Object.entries(aliases).map(([key, path]) => [key, fileURLToPath(new URL('../' + path, import.meta.url))])), dedupe: ['libphonenumber-js'] },
  test: { environment: 'jsdom', setupFiles: ['./src/renderer/test/setup.ts'], maxWorkers: 2, testTimeout: 15000, include: [
    'src/renderer/components/__tests__/OrderDashboard.booking-choice.test.tsx',
    'src/renderer/services/__tests__/ReservationsService.window.test.ts',
    'src/renderer/services/__tests__/ReservationsService.arrival.test.ts',
    'src/renderer/pages/verticals/salon/__tests__/salon-sale.test.ts',
    'src/renderer/pages/verticals/salon/__tests__/SalonCatalogPicker.test.tsx',
    'src/renderer/pages/verticals/salon/__tests__/StaffScheduleView.workflow.test.tsx',
    'src/renderer/components/modals/__tests__/ProductCatalogModal.retail.test.tsx',
    'src/renderer/hooks/__tests__/useTables.lanNotification.test.ts',
  ], clearMocks: true, restoreMocks: true },
};
