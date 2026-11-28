import { writeFile } from "node:fs/promises";
import { expect, test as base, type Browser, type Locator, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { desktopFixtureWindowHidden } from "../helpers/desktop-fixture-launch-args.js";

const TOKEN = "u".repeat(43);
const TARGET_VERSION = "0.8.0";
const BYTES_PER_MEGABYTE = 1_048_576;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface DesktopUpdatePayload {
  readonly status: "current" | "downloading" | "preparing" | "downloaded";
  readonly version?: string;
  readonly progress?: {
    readonly percent: number;
    readonly transferredBytes: number;
    readonly totalBytes: number;
    readonly bytesPerSecond: number;
  };
}

interface UpdateProgressDesktop {
  readonly page: Page;
  readonly fixture: RunningDesktopFixture;
  publishUpdateState(payload: DesktopUpdatePayload): Promise<void>;
}

const emptyAttachmentComposer = {
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "test", model: "text-only", transport: "test" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "model_incompatible",
      source: "maintained_catalogue",
      checkedAt: "1998-08-26T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

const athleteState = {
  schemaVersion: "1",
  lastUpdated: "1998-08-26T08:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: null,
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
} as const;

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function createScript(unexpected: string[]): DesktopFixtureScript {
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      switch (request.method) {
        case "getAthleteState":
          return response(athleteState);
        case "getSetupStatus":
          return response({ schemaVersion: 1, durableTrainingData: true });
        case "getLanguagePreference":
          return response({ value: null });
        case "setLanguagePreference":
          return response(request.params);
        case "getUnitsPreference":
          return response({ value: "metric", source: "default" });
        case "setUnitsPreference":
          return response({ value: "metric", source: "cycling" });
        case "getChatQueue":
          return response({ schemaVersion: 1, revision: 0, items: [] });
        case "getChatAttachmentComposer":
        case "saveChatAttachmentDraftText":
        case "removeChatAttachment":
        case "retryChatAttachment":
        case "selectChatAttachmentWorkout":
        case "clearChatAttachmentDraft":
          return response(emptyAttachmentComposer);
        case "hasSession":
          return response({ hasSession: false });
        case "getCoachDecision":
          return response({ decision: null });
        case "getTranscriptPage":
        case "getArchivedTranscriptPage":
          return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
        case "listArchivedConversations":
          return response({ schemaVersion: 1, conversations: [], truncated: false });
        case "deleteArchivedConversation":
          return response({ schemaVersion: 1, status: "not-found" });
        case "resumePlanningRequests":
          return response({ deliveries: [] });
        case "listPlanningRequests":
          return response({ deliveries: [], planCreation: null });
        case "getSpendSummary":
          return response({
            schemaVersion: 1,
            currency: "USD",
            today: { spend: 0, cap: null },
            routes: [],
          });
        case "sync":
          return response({
            schemaVersion: 1,
            published: false,
            referenceSucceeded: true,
            requests: { store: 0, reference: 0, total: 0 },
            droppedActivities: {
              overall: { total: 0, visible: 0, restrictions: [], other: 0 },
              recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
            },
          });
        case "getRuntimeConfig":
          return response({
            schemaVersion: 3,
            llm: {
              provider: "codex-agent",
              model: "synthetic-codex",
              credential_configured: true,
            },
            intervals: {
              athlete_id: "0",
              credential_configured: true,
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
        default:
          unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };
}

async function readProgressBarMetrics(section: Locator): Promise<{
  readonly present: boolean;
  readonly ariaValueNow: string | null;
  readonly fillWidthPercent: number;
}> {
  return section.evaluate((element) => {
    const bar = element.querySelector('[role="progressbar"]');
    if (!(bar instanceof HTMLElement)) {
      return { present: false, ariaValueNow: null, fillWidthPercent: 0 };
    }
    const fill = bar.firstElementChild;
    const trackRect = bar.getBoundingClientRect();
    const fillRect = fill instanceof HTMLElement ? fill.getBoundingClientRect() : null;
    const fillWidthPercent =
      fillRect !== null && trackRect.width > 0
        ? Math.round((fillRect.width / trackRect.width) * 100)
        : 0;
    return {
      present: true,
      ariaValueNow: bar.getAttribute("aria-valuenow"),
      fillWidthPercent,
    };
  });
}

const test = base.extend<{ updateDesktop: UpdateProgressDesktop }>({
  updateDesktop: async ({ playwright }, use, testInfo) => {
    const unexpected: string[] = [];
    const messages: string[] = [];
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    try {
      fixture = await launchDesktopFixture({
        script: createScript(unexpected),
        token: TOKEN,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: desktopFixtureWindowHidden(process.env.PWDEBUG),
        inspectMain: true,
        routeChatAttachmentComposer: true,
        extraEnv: {
          LANG: "en_US.UTF-8",
          TZ: "UTC",
        },
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      page.on("console", (message) =>
        messages.push(`renderer ${message.type()}: ${message.text()}`),
      );
      page.on("pageerror", (error) => messages.push(`renderer error: ${error.message}`));
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true });
      const shell = page.locator("[data-shell]");
      await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
      await expect(shell).toHaveAttribute("data-shell", "app");
      const activeFixture = fixture;
      const activePage = page;
      await use({
        page: activePage,
        fixture: activeFixture,
        async publishUpdateState(payload) {
          await activeFixture.evaluateMain(`
            const { createRequire } = process.getBuiltinModule("module");
            const require = createRequire(process.cwd() + "/package.json");
            const { BrowserWindow } = require("electron");
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) throw new Error("no BrowserWindow");
            win.webContents.send("desktop:update:state", ${JSON.stringify(payload)});
            return true;
          `);
        },
      });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (page !== undefined) {
        await page
          .context()
          .tracing.stop(failed ? { path: testInfo.outputPath("trace.zip") } : undefined)
          .catch(() => undefined);
      }
      if (failed && fixture !== undefined) {
        const activeFixture = fixture;
        const surfaces = (["location", "console", "stdout", "stderr"] as const).map(
          (surface) => `${surface}\n${activeFixture.readCapturedSurface(surface)}`,
        );
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [
            `unexpected coach requests: ${unexpected.join(", ")}`,
            `renderer\n${messages.join("\n")}`,
            ...surfaces,
          ].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await fixture?.close().catch(() => undefined);
    }
  },
});

test("Settings Application shows live download progress, progress bar, and Preparing state", async ({
  updateDesktop,
}) => {
  const { page, publishUpdateState } = updateDesktop;
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const applicationSection = page.locator('section[aria-label="Application"]');
  const progressBar = applicationSection.getByRole("progressbar");
  const statusRegion = applicationSection.getByRole("status");

  await navigation.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(applicationSection).toBeVisible();
  await page.getByRole("heading", { name: "Application", exact: true }).evaluate((heading) => {
    heading.scrollIntoView({ block: "center" });
  });

  await publishUpdateState({ status: "current" });
  await expect(applicationSection).toContainText("Enduragent is up to date");
  await expect(
    applicationSection.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeEnabled();

  await publishUpdateState({ status: "downloading", version: TARGET_VERSION });
  await expect(applicationSection).toContainText(`Downloading update ${TARGET_VERSION}`);
  const downloadingButton = applicationSection.getByRole("button", {
    name: `Downloading update ${TARGET_VERSION}`,
    exact: true,
  });
  await expect(downloadingButton).toBeDisabled();
  await expect(downloadingButton).toHaveText("Downloading…");
  await expect(progressBar).toBeVisible();
  await expect
    .poll(async () => (await readProgressBarMetrics(applicationSection)).ariaValueNow)
    .toBeNull();

  await publishUpdateState({
    status: "downloading",
    version: TARGET_VERSION,
    progress: {
      percent: 42,
      transferredBytes: Math.round(14.2 * BYTES_PER_MEGABYTE),
      totalBytes: Math.round(33.8 * BYTES_PER_MEGABYTE),
      bytesPerSecond: Math.round(4.8 * BYTES_PER_MEGABYTE),
    },
  });

  await expect(applicationSection).toContainText(
    `Downloading update ${TARGET_VERSION} — 42% (14.2 / 33.8 MB · 4.8 MB/s)`,
  );
  await expect(progressBar).toHaveAttribute("aria-valuenow", "42");
  await expect
    .poll(async () => (await readProgressBarMetrics(applicationSection)).fillWidthPercent)
    .toBeGreaterThanOrEqual(38);
  await expect
    .poll(async () => (await readProgressBarMetrics(applicationSection)).fillWidthPercent)
    .toBeLessThanOrEqual(46);
  await expect(statusRegion).toHaveText(`Downloading update ${TARGET_VERSION} — 25%`);

  await publishUpdateState({
    status: "downloading",
    version: TARGET_VERSION,
    progress: {
      percent: 84,
      transferredBytes: Math.round(28.4 * BYTES_PER_MEGABYTE),
      totalBytes: Math.round(33.8 * BYTES_PER_MEGABYTE),
      bytesPerSecond: Math.round(5.8 * BYTES_PER_MEGABYTE),
    },
  });

  await expect(applicationSection).toContainText(
    `Downloading update ${TARGET_VERSION} — 84% (28.4 / 33.8 MB · 5.8 MB/s)`,
  );
  await expect(progressBar).toHaveAttribute("aria-valuenow", "84");
  await expect
    .poll(async () => (await readProgressBarMetrics(applicationSection)).fillWidthPercent)
    .toBeGreaterThanOrEqual(80);
  await expect
    .poll(async () => (await readProgressBarMetrics(applicationSection)).fillWidthPercent)
    .toBeLessThanOrEqual(88);
  await expect(statusRegion).toHaveText(`Downloading update ${TARGET_VERSION} — 75%`);

  await publishUpdateState({ status: "preparing", version: TARGET_VERSION });
  await expect(applicationSection).toContainText(`Preparing update ${TARGET_VERSION}…`);
  const preparingButton = applicationSection.getByRole("button", {
    name: `Preparing update ${TARGET_VERSION}…`,
    exact: true,
  });
  await expect(preparingButton).toBeDisabled();
  await expect(preparingButton).toHaveText("Preparing…");
  await expect(progressBar).toBeVisible();
  await expect
    .poll(async () => (await readProgressBarMetrics(applicationSection)).ariaValueNow)
    .toBeNull();
  await expect(statusRegion).toHaveText(`Preparing update ${TARGET_VERSION}…`);

  await publishUpdateState({ status: "downloaded", version: TARGET_VERSION });
  await expect(applicationSection).toContainText(`Restart to update to version ${TARGET_VERSION}`);
  const restartButton = applicationSection.getByRole("button", {
    name: `Restart to update to version ${TARGET_VERSION}`,
    exact: true,
  });
  await expect(restartButton).toBeEnabled();
  await expect(restartButton).toHaveText("Restart to update");
  await expect(progressBar).toHaveCount(0);
});
