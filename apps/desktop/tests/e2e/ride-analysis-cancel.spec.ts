import { expect, test as base, type Browser, type Page } from "@playwright/test";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

class HoldingCoach {
  readonly calls: ScriptRequest[] = [];
  readonly unexpected: string[] = [];
  readonly syncRelease = deferred<void>();
  readonly analysisRelease = deferred<void>();
  readonly chatFinish = deferred<string>();
  readonly chatAttached = deferred<void>();
  readonly analysisRequested = deferred<void>();
  readonly syncRequested = deferred<void>();
  private emit: ((frame: string) => void) | undefined;
  private queueRevision = 0;
  constructor() {
    this.analysisRelease.promise.catch(() => undefined);
  }
  private queueItems: unknown[] = [];

  emitChat(event: unknown): void {
    this.emit?.(JSON.stringify(event));
  }

  release(): void {
    this.syncRelease.resolve();
    this.analysisRelease.reject(new Error("fixture closed"));
    this.chatFinish.resolve("Closed.");
  }

  private snapshot() {
    return { schemaVersion: 1, revision: this.queueRevision, items: this.queueItems };
  }

  readonly script: DesktopFixtureScript = {
    onStreamRequest: async (value, emitFrame) => {
      const request = value as ScriptRequest;
      this.calls.push(request);
      if (request.method !== "resumeChatQueue") {
        this.unexpected.push(`stream:${request.method}`);
        throw new Error(`Unexpected stream request ${request.method}`);
      }
      this.emit = emitFrame;
      this.chatAttached.resolve();
      const text = await this.chatFinish.promise;
      this.queueItems = [];
      this.queueRevision += 1;
      return JSON.stringify({ snapshot: this.snapshot(), response: { text } });
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
          return response(this.snapshot());
        case "enqueueChatMessage": {
          const params = request.params as { submissionId: string; text: string };
          this.queueRevision += 1;
          this.queueItems = [
            {
              queuedMessageId: `queued-${this.queueRevision}`,
              messageId: `message-${this.queueRevision}`,
              submissionId: params.submissionId,
              attachmentIds: [],
              text: params.text,
              kind: "ordinary",
              position: 0,
              restored: false,
            },
          ];
          return response(this.snapshot());
        }
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
          this.syncRequested.resolve();
          await this.syncRelease.promise;
          return syncFrames;
        case "getActivityAnalysis":
          this.analysisRequested.resolve();
          await this.analysisRelease.promise;
          throw new Error("unreachable");
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
  readonly coach: HoldingCoach;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new HoldingCoach();
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
      coach.release();
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

test("moving to another ride while its analysis loads keeps the sync and the coach reply going", async ({
  desktop,
}, testInfo) => {
  const { page, coach } = desktop;
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const chip = page.locator("[data-sync-chip]");

  const composer = page.locator("textarea#message");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("How did my ride go?");
  await composer.press("Enter");
  await coach.chatAttached.promise;
  coach.emitChat({ type: "turn-start", turnId: "turn-repro", chatId: "desktop" });
  coach.emitChat({ type: "text_delta", turnId: "turn-repro", delta: "Your ride looked " });
  await expect(page.locator("[data-chat-status]")).toHaveAttribute("data-chat-status", "streaming");

  await page.locator("button.sync-chip").click();
  await coach.syncRequested.promise;
  await expect(chip).toHaveAttribute("data-status", "syncing");

  await navigation.getByRole("button", { name: "Training", exact: true }).click();
  const rides = page.locator('[data-panel="recent-rides"] button');
  await rides.first().click();
  const review = page.locator('section[aria-label="Ride review"]');
  await expect(review).toBeVisible();
  await review.locator("summary", { hasText: "Recorded analysis" }).click();
  await coach.analysisRequested.promise;

  await page.getByRole("button", { name: "Back to training" }).click();
  await rides.nth(1).click();
  await expect(review).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: testInfo.outputPath("bad-state.png") });

  await expect
    .soft(chip, "The sidebar says the sync needs attention, though the athlete only changed rides")
    .not.toHaveAttribute("data-status", "attention");
  await expect
    .soft(
      chip.locator("[data-sync-detail]"),
      "The sidebar says the connection was interrupted and Enduragent won't retry",
    )
    .not.toContainText("Connection interrupted");

  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("chat-after.png") });
  await expect
    .soft(
      page.locator("[data-chat-status]"),
      "The coach reply that was streaming was cut off when the athlete changed rides",
    )
    .toHaveAttribute("data-chat-status", "streaming", { timeout: 2_000 });
});

async function streamingReplySyncAndLoadingAnalysis(desktop: Desktop): Promise<void> {
  const { page, coach } = desktop;
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const composer = page.locator("textarea#message");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("How did my ride go?");
  await composer.press("Enter");
  await coach.chatAttached.promise;
  coach.emitChat({ type: "turn-start", turnId: "turn-repro", chatId: "desktop" });
  coach.emitChat({ type: "text_delta", turnId: "turn-repro", delta: "Your ride looked " });
  await expect(page.locator("[data-chat-status]")).toHaveAttribute("data-chat-status", "streaming");
  await page.locator("button.sync-chip").click();
  await coach.syncRequested.promise;
  await expect(page.locator("[data-sync-chip]")).toHaveAttribute("data-status", "syncing");
  await navigation.getByRole("button", { name: "Training", exact: true }).click();
  await page.locator('[data-panel="recent-rides"] button').first().click();
  const review = page.locator('section[aria-label="Ride review"]');
  await expect(review).toBeVisible();
  await review.locator("summary", { hasText: "Recorded analysis" }).click();
  await coach.analysisRequested.promise;
}

test("path B: a sync that finishes while a ride analysis loads does not cut off the coach reply", async ({
  desktop,
}, testInfo) => {
  const { page, coach } = desktop;
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await streamingReplySyncAndLoadingAnalysis(desktop);

  coach.syncRelease.resolve();
  await expect(page.locator("[data-sync-chip]")).toHaveAttribute("data-status", "synced");
  await page.waitForTimeout(1_000);
  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("bad-state.png") });
  await expect(
    page.locator("[data-chat-status]"),
    "The coach reply that was streaming was cut off when the sync finished",
  ).toHaveAttribute("data-chat-status", "streaming", { timeout: 2_000 });
});

test("control: with the analysis left loading and nothing else happening, the sync and the reply keep going", async ({
  desktop,
}) => {
  const { page, coach } = desktop;
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const chip = page.locator("[data-sync-chip]");
  await streamingReplySyncAndLoadingAnalysis(desktop);
  await page.waitForTimeout(1_500);

  await expect(chip).toHaveAttribute("data-status", "syncing");
  await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator("[data-chat-status]")).toHaveAttribute("data-chat-status", "streaming");
  coach.emitChat({ type: "final-text", turnId: "turn-repro", text: "Your ride looked steady." });
  coach.chatFinish.resolve("Your ride looked steady.");
  await expect(page.locator(".conversation")).toContainText("Your ride looked steady.");
  coach.syncRelease.resolve();
  await expect(chip).toHaveAttribute("data-status", "synced");
});
