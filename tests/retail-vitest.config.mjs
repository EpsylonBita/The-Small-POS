import { fileURLToPath } from 'node:url';

// Run with --configLoader runner: shared node_modules junctions are read-only
// in bounded worktrees, so Vite's bundled config cannot write .vite-temp there.
export default {
  root: fileURLToPath(new URL('../', import.meta.url)),
  cacheDir: '.cache/retail-vitest',
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: [
      'src/renderer/utils/__tests__/retail-sale.test.ts',
      'src/renderer/services/__tests__/retail-barcode.test.ts',
      'src/renderer/components/modals/__tests__/ProductCatalogModal.retail.test.tsx',
      'src/services/__tests__/OrderService.retail-variant.test.ts',
      'src/renderer/hooks/__tests__/useScale.retail.test.ts',
    ],
    clearMocks: true,
    restoreMocks: true,
  },
};
