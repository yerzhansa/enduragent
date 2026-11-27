import { writeFile } from "node:fs/promises";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../../helpers/desktop-fixture.js";
import { desktopFixtureWindowHidden } from "../../helpers/desktop-fixture-launch-args.js";

const token = "f".repeat(43);

interface FirstRunDesktopFixtures {
  readonly firstRunDesktop: { readonly page: Page };
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function createFirstRunScript(): DesktopFixtureScript {
  return {
    onRequest(value) {
      const request = value as { readonly method: string };
      switch (request.method) {
        case "getRuntimeConfig":
          return response({
            schemaVersion: 3,
            llm: { provider: "anthropic", model: "fixture", credential_configured: false },
            intervals: {
              athlete_id: "",
              credential_configured: false,
              managedByEnvironment: { athleteId: false },
            },
            session: {
              historyTokenBudgetRatio: 0.3,
              idleMinutes: 0,
              dailyResetHour: 4,
              resetArchiveRetentionDays: 0,
              timezone: "UTC",
              managedByEnvironment: {
                historyTokenBudgetRatio: false,
                idleMinutes: false,
                dailyResetHour: false,
                resetArchiveRetentionDays: false,
                timezone: false,
              },
            },
          });
        case "getSetupStatus":
          return response({ schemaVersion: 1, durableTrainingData: false });
        case "getAthleteState":
          return response({
            schemaVersion: "1",
            lastUpdated: "1998-07-19T08:00:00.000Z",
            freshness: "fresh",
            degraded: false,
            lastSynced: null,
            athleteProfile: {},
            currentStatus: {},
            derivedMetrics: {},
            recentActivities: [],
            plannedWorkouts: [],
            wellness: {},
          });
        case "getTranscriptPage":
          return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
        case "getUnitsPreference":
          return response({ value: "metric", source: "default" });
        case "getLanguagePreference":
          return response({ value: null });
        case "hasSession":
          return response({ hasSession: false });
        case "getCoachDecision":
          return response({ decision: null });
        case "getChatQueue":
          return response({ schemaVersion: 1, revision: 0, items: [] });
        default:
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };
}

export const test = base.extend<FirstRunDesktopFixtures>({
  firstRunDesktop: async ({ playwright }, use, testInfo) => {
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const messages: string[] = [];
    try {
      fixture = await launchDesktopFixture({
        script: createFirstRunScript(),
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: desktopFixtureWindowHidden(process.env.PWDEBUG),
        seedConfig: false,
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      if (context === undefined) throw new Error("Playwright did not find the Electron context");
      page = context.pages().find((candidate) => candidate.url().startsWith("enduragent://app/"));
      if (page === undefined) throw new Error("Playwright did not find the Electron renderer");
      page.on("console", (message) =>
        messages.push(`renderer ${message.type()}: ${message.text()}`),
      );
      page.on("pageerror", (error) => messages.push(`renderer error: ${error.message}`));
      await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const shell = page.locator("[data-shell]");
      await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
      await expect(shell).toHaveAttribute("data-shell", "gate");
      await use({ page });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (page !== undefined) {
        await page
          .context()
          .tracing.stop(failed ? { path: testInfo.outputPath("trace.zip") } : undefined)
          .catch(() => {});
      }
      if (failed && fixture !== undefined) {
        const surfaces = ["location", "console", "stdout", "stderr"] as const;
        const log = [
          `playwright renderer\n${messages.join("\n")}`,
          ...surfaces.map((surface) => `${surface}\n${fixture?.readCapturedSurface(surface)}`),
        ].join("\n\n");
        await writeFile(testInfo.outputPath("desktop.log"), log).catch(() => {});
      }
      await browser?.close().catch(() => {});
      await fixture?.close().catch(() => {});
    }
  },
});

export { expect };
