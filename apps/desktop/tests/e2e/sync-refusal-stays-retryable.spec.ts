import { writeFile } from "node:fs/promises";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  createInvocationCoordinator,
  type InvocationCoordinator,
} from "../../../../packages/coach/src/daemon/invocation-coordinator.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "../helpers/training-current-athlete-state.js";

const TOKEN = "r".repeat(43);

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

const runtimeConfig = {
  schemaVersion: 3,
  llm: { provider: "codex-agent", model: "synthetic-codex", credential_configured: true },
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
} as const;

const syncFrames = [
  JSON.stringify({ event: { phase: "started", completed: 0, total: 1 } }),
  JSON.stringify({ event: { phase: "completed", completed: 1, total: 1 } }),
  JSON.stringify({
    schemaVersion: 1,
    backfill: "completed",
    published: true,
    referenceSucceeded: true,
    requests: { store: 2, reference: 1, total: 3 },
    droppedActivities: {
      overall: { total: 0, visible: 0, restrictions: [], other: 0 },
      recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
    },
  }),
];

class SyncingCoach {
  readonly calls: string[] = [];
  readonly unexpected: string[] = [];
  syncs = 0;

  readonly script: DesktopFixtureScript = {
    onRequest: async (value) => {
      const request = value as ScriptRequest;
      this.calls.push(request.method);
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
          return response(runtimeConfig);
        case "configureRuntime":
          return response({
            schemaVersion: 3,
            status: "applied",
            applied: { llm: true, intervals: true, session: true },
          });
        case "sync":
          this.syncs += 1;
          return syncFrames;
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
  readonly coach: SyncingCoach;
  readonly invocations: InvocationCoordinator;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new SyncingCoach();
    const invocations = createInvocationCoordinator();
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
        invocations,
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      const page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await use({ page, coach, invocations });
    } finally {
      if (fixture !== undefined) {
        const surfaces = (["console", "stderr", "dom"] as const).map(
          (surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`,
        );
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [
            `unexpected coach requests: ${coach.unexpected.join(", ")}`,
            `coach calls: ${coach.calls.join(", ")}`,
            ...surfaces,
          ].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await fixture?.close();
    }
  },
});

test("a sync the coach refuses while it closes admission leaves Try again working", async ({
  desktop,
}, testInfo) => {
  const { page, coach, invocations } = desktop;
  const chip = page.locator("[data-sync-chip]");
  const button = page.locator("button.sync-chip");
  await expect(page.locator("textarea#message")).toBeEnabled({ timeout: 15_000 });
  await expect(chip).toHaveAttribute("data-status", /^(synced|never)$/u);

  const fence = invocations.closeAdmission();
  await button.click();
  await expect(chip).toHaveAttribute("data-status", "attention");
  await page.screenshot({ path: testInfo.outputPath("after-refusal.png") });
  expect(coach.syncs, "The coach refused the sync before running it").toBe(0);
  await expect(button, "The sync button stays usable after the refusal").toBeEnabled();
  await expect(button).toHaveAttribute("aria-label", /^Try again · Sync needs attention · /u);
  await expect(chip.locator("[data-sync-detail]")).toHaveText(
    "We couldn’t complete the training-data check. Your existing data is still available.",
  );

  expect(fence.reopen(), "The coach opens admission again").toBe(true);
  await button.click();
  await expect(chip).toHaveAttribute("data-status", "synced");
  await page.screenshot({ path: testInfo.outputPath("after-try-again.png") });
  expect(coach.syncs, "Try again reached the coach").toBe(1);
});
