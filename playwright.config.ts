import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = 3198;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { baseURL, browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    timeout: 120000,
    reuseExistingServer: false,
    env: { APP_ORIGIN: baseURL,
      DATABASE_PATH: join(process.cwd(), '.local-data', `e2e-${randomUUID()}.sqlite`),
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      ENS_SEPOLIA_RPC_URL: '', ENS_SEPOLIA_AUTH_RPC_URL: '', ARKIV_ACCESS_KEY: '', AI_API_KEY: '', WORLD_CLIENT_ID: '', WORLD_CLIENT_SECRET: '', WORLD_CAPABILITY_ENABLED: 'false',
      SUPABASE_STORAGE_ENABLED: 'false', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_URL: '',
      NEXT_DIST_DIR: '.next',
    },
  },
});
