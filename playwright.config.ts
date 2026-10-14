import { defineConfig, devices } from '@playwright/test';
import { resolveOrigin, resolveHeadless } from './src/ui/browserManager';

const AUTH_FILE = '.auth/user.json';
// Logging in or out ends every session of that user server-side, so these specs run last (see `ends-session` below).
const ENDS_SESSION = /@ends-session/;
const PERF_SPECS = /[\\/]perf[\\/].*\.spec\.ts/;
// Perf specs belong to the `perf` project only: they log in on their own and a load run takes
// far longer than a UI check, so a plain `npm run test:ui` must not pull them in.
const UI_IGNORE = [/[\\/]ssh[\\/]/, PERF_SPECS];

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // PerfReporter aggregates the perf attachments into reports/perf/<runId>/; it returns early
  // when a run produced no measurements, so non-perf runs are unaffected.
  reporter: [['list'], ['html', { open: 'never' }], ['./src/perf/perfReporter.ts']],
  use: {
    baseURL: resolveOrigin(),
    ignoreHTTPSErrors: true,
    headless: resolveHeadless(),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      // Teardown projects ignore file, --grep and --test-list filters, so the dashboard sets NAT_SKIP_ENDS_SESSION
      // when its selection holds no @ends-session test; otherwise every run would end with the login/logout specs.
      teardown: process.env.NAT_SKIP_ENDS_SESSION ? undefined : 'ends-session',
      metadata: { natRole: 'setup' },
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testMatch: /.*\.spec\.ts/,
      testIgnore: UI_IGNORE,
      grepInvert: ENDS_SESSION,
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_FILE,
      },
    },
    {
      // Optional UI lanes — `npx playwright install firefox webkit` before first use.
      name: 'firefox',
      dependencies: ['setup'],
      testMatch: /.*\.spec\.ts/,
      testIgnore: UI_IGNORE,
      grepInvert: ENDS_SESSION,
      use: {
        ...devices['Desktop Firefox'],
        storageState: AUTH_FILE,
      },
    },
    {
      name: 'webkit',
      dependencies: ['setup'],
      testMatch: /.*\.spec\.ts/,
      testIgnore: UI_IGNORE,
      grepInvert: ENDS_SESSION,
      use: {
        ...devices['Desktop Safari'],
        storageState: AUTH_FILE,
      },
    },
    {
      // Perf lane. Deliberately without `dependencies: ['setup']` and without storageState:
      // every virtual user logs in itself (LOGIN is a timed screen). Sharing the setup session
      // would be worse than useless here — running N shard processes would fire N concurrent
      // admin logins, and NetReveal ends every earlier session of the same user.
      name: 'perf',
      testMatch: PERF_SPECS,
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      // Teardown of `setup`: runs once every UI project that uses the shared storageState has finished.
      name: 'ends-session',
      testMatch: /.*\.spec\.ts/,
      testIgnore: UI_IGNORE,
      grep: ENDS_SESSION,
      metadata: { natRole: 'teardown' },
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_FILE,
      },
    },
    {
      // Non-UI SSH — no auth.setup / storageState
      name: 'ssh',
      testMatch: /\/ssh\/.*\.spec\.ts/,
    },
  ],
});
