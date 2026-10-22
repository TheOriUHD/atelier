import { defineConfig } from '@playwright/test';
import { ADMIN_STATE, WEB_PORT } from './e2e/fixtures.ts';

const base = `http://127.0.0.1:${WEB_PORT}`;

/**
 * End-to-end tests against the built web server and the built Electron app, both talking to the
 * scripted fake Ollama (e2e/fake-ollama.mjs). Build first: pnpm build.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/serve.mjs', stdout: 'pipe', stderr: 'pipe', url: `${base}/api/health`, reuseExistingServer: false, timeout: 30_000 },
  projects: [
    // Creates the admin account; the web specs start signed in as it.
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { baseURL: base } },
    // Locally the installed Chrome is used; CI installs Playwright's Chromium.
    {
      name: 'web',
      testMatch: /web\.spec\.ts/,
      dependencies: ['setup'],
      use: { baseURL: base, storageState: ADMIN_STATE, ...(process.env.CI ? {} : { channel: 'chrome' }) },
    },
    { name: 'desktop', testMatch: /desktop\.spec\.ts/ },
  ],
});
