import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
  },
})
