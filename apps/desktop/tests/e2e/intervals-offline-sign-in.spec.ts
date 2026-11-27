import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "../helpers/training-current-athlete-state.js";

const TOKEN = "o".repeat(43);
const SAVED_INTERVALS_KEY = "s".repeat(43);
const NOT_IN_USE_TEXT = "connected right now, so nothing was synced";

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
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
      checkedAt: "1998-08-22T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

function runtimeConfig(intervalsConfigured: boolean) {
  return {
    schemaVersion: 3,
    llm: { provider: "codex-agent", model: "synthetic-codex", credential_configured: true },
    intervals: {
      athlete_id: "0",
      credential_configured: intervalsConfigured,
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
  } as const;
}

const noDroppedActivities = {
  overall: { total: 0, visible: 0, restrictions: [], other: 0 },
  recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
} as const;

const keylessSync = {
  schemaVersion: 1,
  backfill: "skipped-no-credential",
  published: false,
  referenceSucceeded: true,
  requests: { store: 0, reference: 1, total: 1 },
  droppedActivities: noDroppedActivities,
} as const;

const fetchedSync = {
  schemaVersion: 1,
  backfill: "completed",
  published: true,
  referenceSucceeded: true,
  requests: { store: 2, reference: 1, total: 3 },
  droppedActivities: noDroppedActivities,
} as const;

class OfflineSignInCoach {
  readonly calls: ScriptRequest[] = [];
  readonly unexpected: string[] = [];
  intervalsConfigured = false;
  syncResult: typeof keylessSync | typeof fetchedSync = keylessSync;

  syncCount(): number {
    return this.calls.filter((call) => call.method === "sync").length;
  }

  readonly script: DesktopFixtureScript = {
    onStreamRequest: async (value) => {
      const request = value as ScriptRequest;
      this.calls.push(request);
      this.unexpected.push(`stream:${request.method}`);
      throw new Error(`Unexpected stream request ${request.method}`);
    },
    onRequest: async (value) => {
      const request = value as ScriptRequest;
      this.calls.push(request);
      switch (request.method) {
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
          return response({ hasSession: true });
        case "getCoachDecision":
          return response({ decision: null });
        case "getTranscriptPage":
        case "getArchivedTranscriptPage":
          return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
        case "listArchivedConversations":
          return response({ schemaVersion: 1, conversations: [], truncated: false });
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
        case "getAthleteState":
          return response(TRAINING_CURRENT_ATHLETE_STATE);
        case "getRuntimeConfig":
          return response(runtimeConfig(this.intervalsConfigured));
        case "verify_intervals_credential":
          return response({ reason: "validation-unavailable" });
        case "configureRuntime": {
          const params = request.params as { readonly intervals?: unknown };
          if (params.intervals !== undefined) {
            return response({
              schemaVersion: 3,
              status: "refused",
              reason: "ownership-unavailable",
            });
          }
          return response({
            schemaVersion: 3,
            status: "applied",
            applied: { llm: true, intervals: true, session: true },
          });
        }
        case "sync":
          return [
            JSON.stringify({ event: { phase: "started", completed: 0, total: 1 } }),
            JSON.stringify({ event: { phase: "completed", completed: 1, total: 1 } }),
            JSON.stringify(this.syncResult),
          ];
        case "getPlanState":
        case "plan.list":
          throw new Error("Plan unavailable in this fixture");
        default:
          this.unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };
}

interface Desktop {
  readonly page: Page;
  readonly fixture: RunningDesktopFixture;
  readonly coach: OfflineSignInCoach;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new OfflineSignInCoach();
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      fixture = await launchDesktopFixture({
        script: coach.script,
        token: TOKEN,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        extraEnv: { LANG: "en_US.UTF-8", TZ: "UTC" },
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      const page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined);
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await use({ page, fixture, coach });
      await context.tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => undefined);
    } finally {
      if (fixture !== undefined) {
        const surfaces = (["console", "stderr", "dom"] as const).map(
          (surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`,
        );
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [
            `unexpected coach requests: ${coach.unexpected.join(", ")}`,
            `coach calls: ${coach.calls.map((call) => call.method).join(", ")}`,
            ...surfaces,
          ].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await fixture?.close();
    }
  },
});

async function syncWithSavedSignInNotInUse(desktop: Desktop): Promise<void> {
  const { page, coach } = desktop;
  const written = await page.evaluate(
    (value) => window.enduragentAuth.writeCredential({ slot: "intervals-icu", value }),
    SAVED_INTERVALS_KEY,
  );
  expect(written).toMatchObject({ slot: "intervals-icu", status: "configured" });
  const statuses = await page.evaluate(() => window.enduragentAuth.credentialStatuses());
  expect(statuses.find((entry) => entry.slot === "intervals-icu")).toMatchObject({
    state: "configured",
    runtimeState: "failed",
  });

  await page.reload();
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  const syncsBefore = coach.syncCount();
  await page.locator("button.sync-chip").click();
  await expect.poll(() => coach.syncCount()).toBe(syncsBefore + 1);
}

test("Sync with a saved intervals.icu sign-in the coach is not using asks for attention instead of reporting synced", async ({
  desktop,
}, testInfo) => {
  const { page } = desktop;
  const chip = page.locator("[data-sync-chip]");
  await syncWithSavedSignInNotInUse(desktop);
  await page.screenshot({ path: testInfo.outputPath("after-sync.png") });

  await expect(chip, "The sidebar says synced though nothing was synced").toHaveAttribute(
    "data-status",
    "attention",
  );
  await expect(chip.locator("[data-sync-detail]")).toContainText(NOT_IN_USE_TEXT);
});

test("the sidebar returns to synced by itself once the coach has the saved sign-in", async ({
  desktop,
}, testInfo) => {
  const { page, coach } = desktop;
  const chip = page.locator("[data-sync-chip]");
  await syncWithSavedSignInNotInUse(desktop);
  await expect(chip, "The sidebar says synced though nothing was synced").toHaveAttribute(
    "data-status",
    "attention",
  );

  coach.intervalsConfigured = true;
  coach.syncResult = fetchedSync;
  const syncsBefore = coach.syncCount();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(chip).toHaveAttribute("data-status", "synced");
  await page.screenshot({ path: testInfo.outputPath("after-recovery.png") });
  expect(coach.syncCount(), "Enduragent ran exactly one sync by itself").toBe(syncsBefore + 1);
  await expect(chip.locator("[data-sync-detail]")).not.toContainText(NOT_IN_USE_TEXT);
});
