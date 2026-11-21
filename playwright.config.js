import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const pythonExecutable = process.env.PYTHON ?? resolve('.venv/bin/python');
const port = Number(process.env.PLAYWRIGHT_PORT ?? 18081);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
  },
  webServer: {
    command: `${pythonExecutable} -m uvicorn main:app --host 127.0.0.1 --port ${port}`,
    cwd: './app',
    env: {
      DATA_DIR: '../tests/fixtures/data',
      ALLSKY_FS_ROOT: '../tests/fixtures/allsky-images',
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
    },
    port,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
