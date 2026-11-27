import { writeFile } from "node:fs/promises";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "../helpers/training-current-athlete-state.js";

const TOKEN = "d".repeat(43);
const DRAFT = "Synthetic question for the coach about tomorrow's ride";
const DRAFT_ERROR = "Couldn’t reach the coach, so your message is still in the box.";
const RESAVE_ANSWER_MS = 1_500;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface WindowHooks {
  __coachSockets: WebSocket[];
  __syncDetails: string[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

const attachmentComposer = {
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

class ReconnectingCoach {
  readonly calls: string[] = [];
  readonly unexpected: string[] = [];
  readonly syncRequested = deferred<void>();
  readonly draftSaveHeld = deferred<void>();
  readonly draftSavesAfterDrop: string[] = [];
  private readonly syncRelease = deferred<void>();
  private readonly heldSaveRelease = deferred<void>();
  private readonly athleteStateReads: boolean[] = [];
  private holdingDraftSave = false;
  connectionDropped = false;
  syncFinished = false;

  finishSync(): void {
    this.syncRelease.resolve();
  }

  releaseHeldDraftSave(): void {
    this.heldSaveRelease.resolve();
  }

  athleteStateReadsAfterSync(): number {
    return this.athleteStateReads.filter((afterSync) => afterSync).length;
  }

  private async saveDraft(params: unknown): Promise<readonly string[]> {
    const text = (params as { readonly text: string }).text;
    if (this.connectionDropped) {
      this.draftSavesAfterDrop.push(text);
      await new Promise((resolve) => setTimeout(resolve, RESAVE_ANSWER_MS));
    } else if (text === DRAFT && !this.holdingDraftSave) {
      this.holdingDraftSave = true;
      this.draftSaveHeld.resolve();
      await this.heldSaveRelease.promise;
    }
    return response(attachmentComposer);
  }

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
        case "saveChatAttachmentDraftText":
          return await this.saveDraft(request.params);
        case "getChatAttachmentComposer":
        case "removeChatAttachment":
        case "retryChatAttachment":
        case "selectChatAttachmentWorkout":
        case "clearChatAttachmentDraft":
          return response(attachmentComposer);
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
          this.athleteStateReads.push(this.syncFinished);
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
          this.syncFinished = true;
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
  readonly coach: ReconnectingCoach;
}

function trackCoachSockets(): void {
  const hooks = window as unknown as WindowHooks & { WebSocket: typeof WebSocket };
  const Native = hooks.WebSocket;
  hooks.__coachSockets = [];
  hooks.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof Native>) {
      super(...args);
      hooks.__coachSockets.push(this);
    }
  };
}

function recordSyncDetails(): void {
  const hooks = window as unknown as WindowHooks;
  const read = (): string =>
    document.querySelector("[data-sync-chip] [data-sync-detail]")?.textContent ?? "";
  hooks.__syncDetails = [read()];
  new MutationObserver(() => {
    const text = read();
    if (hooks.__syncDetails.at(-1) !== text) hooks.__syncDetails.push(text);
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}

function trackedSocketCount(): number {
  return (window as unknown as WindowHooks).__coachSockets.length;
}

function dropCoachSockets(): number {
  const sockets = (window as unknown as WindowHooks).__coachSockets;
  for (const socket of sockets) socket.close();
  return sockets.length;
}

function syncDetails(): readonly string[] {
  return (window as unknown as WindowHooks).__syncDetails;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new ReconnectingCoach();
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      fixture = await launchDesktopFixture({
        script: coach.script,
        token: TOKEN,
        routeChatAttachmentComposer: true,
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
      const shell = page.locator("[data-shell]");
      await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
      await context.addInitScript(trackCoachSockets);
      await page.reload();
      await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
      await expect
        .poll(() => page.evaluate(trackedSocketCount), {
          message: "The window's coach connection is tracked after the reload",
        })
        .toBeGreaterThan(0);
      await use({ page, coach });
      await context.tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => undefined);
    } finally {
      coach.finishSync();
      coach.releaseHeldDraftSave();
      if (fixture !== undefined) {
        const surfaces = (["console", "stderr", "dom"] as const).map(
          (surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`,
        );
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [
            `unexpected coach requests: ${coach.unexpected.join(", ")}`,
            `coach calls: ${coach.calls.join(", ")}`,
            `draft saves after the drop: ${JSON.stringify(coach.draftSavesAfterDrop)}`,
            ...surfaces,
          ].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await fixture?.close();
    }
  },
});

test("after the connection drops while a typed message is being saved, the window recovers once it reconnects", async ({
  desktop,
}, testInfo) => {
  const { page, coach } = desktop;
  const chip = page.locator("[data-sync-chip]");
  const message = page.locator("textarea#message");
  const draftError = page.getByRole("alert").filter({ hasText: DRAFT_ERROR });
  await expect(message).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(recordSyncDetails);

  await page.locator("button.sync-chip").click();
  await coach.syncRequested.promise;
  await expect(chip).toHaveAttribute("data-status", "syncing");

  await message.click();
  await page.keyboard.type(DRAFT);
  await expect
    .poll(() => coach.calls.includes("saveChatAttachmentDraftText"), {
      message: "Typing saved the message draft to the coach",
    })
    .toBe(true);
  await coach.draftSaveHeld.promise;

  coach.connectionDropped = true;
  const dropped = await page.evaluate(dropCoachSockets);
  expect(dropped).toBeGreaterThan(0);
  await expect(draftError, "The chat box says the message could not reach the coach").toBeVisible();
  await expect
    .poll(() => page.evaluate(syncDetails), {
      message: "The sidebar showed that the connection was interrupted during the sync",
    })
    .toContainEqual(expect.stringContaining("Connection interrupted"));
  await expect
    .poll(() => page.evaluate(trackedSocketCount), {
      message: "The window opened a new connection to the coach",
    })
    .toBeGreaterThan(dropped);

  coach.finishSync();
  await expect.poll(() => coach.syncFinished).toBe(true);

  await expect
    .soft(chip, "The sidebar shows the finished sync without the athlete pressing anything")
    .toHaveAttribute("data-status", "synced", { timeout: 10_000 });
  await expect
    .soft(draftError, "The chat box error clears once the coach can be reached again")
    .toBeHidden({ timeout: 10_000 });
  expect
    .soft(
      coach.draftSavesAfterDrop,
      "The typed message reached the coach after the reconnect without the athlete typing again",
    )
    .toContain(DRAFT);
  await expect.soft(message, "The typed message is still in the box").toHaveValue(DRAFT);
  expect
    .soft(
      coach.athleteStateReadsAfterSync(),
      "The window read the training data again after the coach finished the sync",
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("after-reconnect.png") });
});
