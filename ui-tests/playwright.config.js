/**
 * Configuration for Playwright using default from @jupyterlab/galata
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

// A port of its own: 8888 is where people run their own JupyterLab, and
// reusing that server would run the tests in their folders.
const port = process.env.EPI_UI_TEST_PORT ?? '8877';

module.exports = {
  ...baseConfig,
  // One retry on CI: a test that passes on its retry shows as flaky in the
  // report, and does not fail the run.
  retries: process.env.CI ? 1 : 0,
  use: {
    ...baseConfig.use,
    // The trace of the attempt that failed, which is the one that shows a
    // flaky test's cause; galata's default traces the retry instead.
    trace: 'retain-on-first-failure',
    baseURL: `http://localhost:${port}`,
    // The view's controls fill the JupyterLab toolbar: at galata's default
    // 1024 px, with both side panels open, they move into its overflow menu.
    viewport: { width: 1600, height: 1000 },
    // A Chromium to use instead of the build Playwright downloads.
    ...(process.env.EPI_CHROMIUM
      ? { launchOptions: { executablePath: process.env.EPI_CHROMIUM } }
      : {})
  },
  webServer: {
    command: `jlpm start --ServerApp.port=${port}`,
    url: `http://localhost:${port}/lab`,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI
  }
};
