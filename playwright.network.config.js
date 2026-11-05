import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Playwright's automatic failure-page snapshot can contain the private invite field.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const localUrl = 'http://127.0.0.1:3102';
let target;
try {
  target = new URL(process.env.CHATTAMENTO_URL || localUrl);
} catch {
  throw new Error('CHATTAMENTO_URL must be a valid HTTPS site URL.');
}
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
  throw new Error('The network test requires HTTPS, or HTTP on localhost.');
}
// Always create a fresh room; a supplied invitation must never select an existing one.
target.hash = '';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/connectivity.network.js',
  timeout: 180_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/network',
  use: {
    baseURL: target.toString(),
    browserName: 'chromium',
    actionTimeout: 15_000,
    // Artifacts can expose private invitation fragments or their input field.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--disable-dev-shm-usage'],
    },
  },
  ...(process.env.CHATTAMENTO_URL ? {} : {
    webServer: {
      // The ordinary Vite configuration imports the production Trystero package.
      command: 'npm run dev -- --host 127.0.0.1 --port 3102',
      url: localUrl,
      timeout: 30_000,
      reuseExistingServer: false,
    },
  }),
});
