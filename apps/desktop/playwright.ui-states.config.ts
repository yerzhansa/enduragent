import { defineConfig } from "@playwright/test";

import {
  applicationBaselineForEnvironment,
  currentApplicationEnvironment,
} from "./tests/e2e/application-ui-states/baseline-environment.js";

const version = applicationBaselineForEnvironment(currentApplicationEnvironment());

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "application-ui-states.spec.ts",
  globalSetup: "./tests/e2e/application-ui-states/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  updateSnapshots: "none",
  timeout: 120_000,
  outputDir: "./test-results/ui-states",
  reporter: [["list"], ["json", { outputFile: "./test-results/ui-states/report.json" }]],
  expect: {
    timeout: 15_000,
    toMatchSnapshot: { maxDiffPixels: 0 },
  },
  snapshotPathTemplate: `{testDir}/application-ui-states/baselines/${version}/{projectName}/{arg}{ext}`,
  use: {
    locale: "en-US",
    timezoneId: "UTC",
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "wide-light", use: { viewport: { width: 1180, height: 820 }, colorScheme: "light" } },
    { name: "wide-dark", use: { viewport: { width: 1180, height: 820 }, colorScheme: "dark" } },
    { name: "compact-light", use: { viewport: { width: 760, height: 760 }, colorScheme: "light" } },
    { name: "compact-dark", use: { viewport: { width: 760, height: 760 }, colorScheme: "dark" } },
  ],
});
