import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: path.resolve(__dirname),
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.resolve(__dirname, '../../playwright-report') }],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'electron' },
  ],
  // Do NOT start a webServer for Electron tests
  webServer: undefined as any,
});

