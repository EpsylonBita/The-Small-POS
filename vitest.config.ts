import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Mirror vite.config.ts path aliases so components importing via
  // "@shared/..." (e.g. MenuModal) resolve under vitest too. vitest.config.ts
  // takes priority over vite.config.ts, so the aliases must be repeated here.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@config': path.resolve(__dirname, 'src/config'),
      '@services': path.resolve(__dirname, 'src/services'),
      '@lib': path.resolve(__dirname, 'src/lib'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
  },
})
