import { writeFile } from "node:fs/promises";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "../helpers/training-current-athlete-state.js";

const TOKEN = "r".repeat(43);
const SAVED_INTERVALS_KEY = "k".repeat(43);
const ONE_MINUTE_MS = 60_000;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface FocusHooks {
  __focusEvents: number;
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

function runtimeConfig(credentialRejected: boolean) {
  return {
    schemaVersion: 3,
    llm: { provider: "codex-agent", model: "synthetic-codex", credential_configured: true },
    intervals: {
      athlete_id: "0",
      credential_configured: true,
      ...(credentialRejected ? { credential_rejected: true } : {}),
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

const fetchedSync = {
  schemaVersion: 1,
  backfill: "completed",
  published: true,
  referenceSucceeded: true,
  requests: { store: 2, reference: 1, total: 3 },
  droppedActivities: noDroppedActivities,
} as const;

class BackgroundRejectionCoach {
  readonly calls: ScriptRequest[] = [];
  readonly unexpected: string[] = [];
  credentialRejected = false;

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
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
          return response(runtimeConfig(this.credentialRejected));
        case "verify_intervals_credential":
          return response({ reason: "validation-unavailable" });
        case "configureRuntime":
          return response({
            schemaVersion: 3,
            status: "applied",
            applied: { llm: true, intervals: true, session: true },
          });
        case "sync":
          return [
            JSON.stringify({ event: { phase: "started", completed: 0, total: 1 } }),
            JSON.stringify({ event: { phase: "completed", completed: 1, total: 1 } }),
            JSON.stringify(fetchedSync),
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
  readonly coach: BackgroundRejectionCoach;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new BackgroundRejectionCoach();
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

async function openWithActiveSignIn(desktop: Desktop): Promise<void> {
  const { page, coach } = desktop;
  const written = await page.evaluate(
    (value) => window.enduragentAuth.writeCredential({ slot: "intervals-icu", value }),
    SAVED_INTERVALS_KEY,
  );
  expect(written).toMatchObject({ slot: "intervals-icu", status: "configured" });
  const statuses = await page.evaluate(() => window.enduragentAuth.credentialStatuses());
  expect(statuses.find((entry) => entry.slot === "intervals-icu")).toMatchObject({
    state: "configured",
    runtimeState: "active",
  });

  await page.reload();
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  await expect(page.locator("[data-sync-chip]")).not.toHaveAttribute("data-status", "syncing");
  let seen = -1;
  await expect
    .poll(
      () => {
        const settled = coach.calls.length === seen;
        seen = coach.calls.length;
        return settled;
      },
      { intervals: [1_000], timeout: 20_000 },
    )
    .toBe(true);
}

test("the sidebar asks to sign in again within a minute of the coach rejecting the sign-in, with no focus and no sync", async ({
  desktop,
}, testInfo) => {
  test.setTimeout(150_000);
  const { page, coach } = desktop;
  const chip = page.locator("[data-sync-chip]");
  const signInAgain = chip.locator("[data-sync-sign-in-again]");
  await openWithActiveSignIn(desktop);
  await expect(signInAgain).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("before-rejection.png") });

  await page.evaluate(() => {
    const hooks = window as unknown as FocusHooks;
    hooks.__focusEvents = 0;
    window.addEventListener("focus", () => {
      hooks.__focusEvents += 1;
    });
  });
  const syncsBefore = coach.count("sync");
  const readsBefore = coach.count("getRuntimeConfig");
  coach.credentialRejected = true;
  const rejectedAt = Date.now();

  await expect(
    signInAgain,
    "Sign in again shows within a minute of the coach rejecting the sign-in",
  ).toBeVisible({ timeout: ONE_MINUTE_MS + 10_000 });
  const shownAfterMs = Date.now() - rejectedAt;
  await page.screenshot({ path: testInfo.outputPath("after-rejection.png") });
  testInfo.annotations.push({ type: "shown-after-ms", description: String(shownAfterMs) });

  await expect(signInAgain).toHaveText("Sign in again");
  await expect(chip).toHaveAttribute("data-status", "attention");
  await expect(chip.locator("[data-sync-headline]")).toHaveText(
    "Intervals.icu needs you to sign in again",
  );
  expect(coach.count("getRuntimeConfig")).toBeGreaterThan(readsBefore);
  expect(coach.count("sync"), "the window ran no sync after the rejection").toBe(syncsBefore);
  expect(
    await page.evaluate(() => (window as unknown as FocusHooks).__focusEvents),
    "the window was not focused after the rejection",
  ).toBe(0);
});
