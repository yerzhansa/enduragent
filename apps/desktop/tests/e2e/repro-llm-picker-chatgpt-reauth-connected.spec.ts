import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";

async function recordScreencast(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  const frames: { readonly data: Buffer; readonly at: number }[] = [];
  session.on("Page.screencastFrame", (event) => {
    frames.push({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  return async (path: string): Promise<void> => {
    await session.send("Page.stopScreencast").catch(() => undefined);
    if (frames.length === 0) return;
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    const folder = (await readdir(cache).catch(() => [] as string[])).find((entry) =>
      entry.startsWith("ffmpeg-"),
    );
    if (folder === undefined) return;
    const encoder = spawn(
      join(cache, folder, "ffmpeg-mac"),
      [
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        "10",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
      ].concat(["-y", "-an", "-c:v", "vp8", "-b:v", "1M", "-deadline", "realtime", path]),
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const done = new Promise<void>((resolve) => encoder.once("close", () => resolve()));
    const start = frames[0]!.at;
    const end = frames.at(-1)!.at + 1_000;
    let index = 0;
    for (let at = start; at <= end; at += 100) {
      while (index + 1 < frames.length && frames[index + 1]!.at <= at) index += 1;
      encoder.stdin.write(frames[index]!.data);
    }
    encoder.stdin.end();
    await done;
  };
}

const TOKEN = "c".repeat(43);
const TURN_ID = "turn-repro-llm-picker-reauth";
const REAUTH_COPY = "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.";
const STORED_PROFILE = {
  type: "oauth",
  access: "synthetic-expired-access",
  refresh: "synthetic-revoked-refresh",
  expires: 0,
  accountId: "synthetic-account",
} as const;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface QueuedMessage {
  readonly queuedMessageId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly attachmentIds: readonly string[];
  readonly text: string;
  readonly kind: "ordinary" | "slash-command";
  readonly position: number;
  readonly restored: false;
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

class ScriptedCoach {
  readonly unexpected: string[] = [];
  readonly configureRequests: unknown[] = [];
  profilesPath: string | undefined;
  private revision = 0;
  private queued: QueuedMessage[] = [];
  private hasSession = false;

  private snapshot() {
    return { schemaVersion: 1 as const, revision: this.revision, items: this.queued };
  }

  readonly script: DesktopFixtureScript = {
    onStreamRequest: async (value, emitFrame) => {
      const request = value as ScriptRequest;
      if (request.method !== "resumeChatQueue") {
        this.unexpected.push(`stream:${request.method}`);
        throw new Error(`Unexpected streamed Coach request: ${request.method}`);
      }
      this.hasSession = true;
      if (this.profilesPath !== undefined) {
        await writeFile(
          this.profilesPath,
          JSON.stringify({ "openai-codex": { ...STORED_PROFILE, signInRejected: true } }),
          { mode: 0o600 },
        );
      }
      emitFrame(JSON.stringify({ type: "turn-start", turnId: TURN_ID, chatId: "desktop" }));
      emitFrame(
        JSON.stringify({
          type: "error",
          turnId: TURN_ID,
          chatId: "desktop",
          error_class: "unknown",
          kind: "provider-auth",
          athleteMessage: REAUTH_COPY,
          overflowAttempts: 0,
          timeoutAttempts: 0,
          rateLimitAttempts: 0,
          duration_ms: 1,
          compactions: 0,
        }),
      );
      this.queued = [];
      this.revision += 1;
      return JSON.stringify({ snapshot: this.snapshot(), response: { text: "" } });
    },
    onRequest: async (value) => {
      const request = value as ScriptRequest;
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
        case "getChatAttachmentComposer":
        case "saveChatAttachmentDraftText":
        case "removeChatAttachment":
        case "retryChatAttachment":
        case "selectChatAttachmentWorkout":
        case "clearChatAttachmentDraft":
          return response(emptyAttachmentComposer);
        case "enqueueChatMessage": {
          const params = request.params as { submissionId: string; text: string };
          if (!this.queued.some((item) => item.submissionId === params.submissionId)) {
            this.revision += 1;
            this.queued.push({
              queuedMessageId: `queued-${this.revision}`,
              messageId: `message-${this.revision}`,
              submissionId: params.submissionId,
              attachmentIds: [],
              text: params.text,
              kind: "ordinary",
              position: this.queued.length,
              restored: false,
            });
          }
          return response(this.snapshot());
        }
        case "stopChat":
          return response({ stopped: false });
        case "hasSession":
          return response({ hasSession: this.hasSession });
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
          return response(athleteState);
        case "configureRuntime": {
          this.configureRequests.push(request.params);
          const params = request.params as {
            readonly llm?: unknown;
            readonly intervals?: unknown;
            readonly session?: unknown;
          };
          return response({
            schemaVersion: 3,
            status: "applied",
            applied: {
              llm: params.llm !== undefined,
              intervals: params.intervals !== undefined,
              session: params.session !== undefined,
            },
          });
        }
        case "getRuntimeConfig":
          return response({
            schemaVersion: 3,
            llm: { provider: "openai-codex", model: "gpt-5.6-sol", credential_configured: true },
            intervals: {
              athlete_id: "0",
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
        default:
          this.unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };
}

interface Desktop {
  readonly page: Page;
  readonly coach: ScriptedCoach;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new ScriptedCoach();
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    let stopScreencast: ((path: string) => Promise<void>) | undefined;
    try {
      fixture = await launchDesktopFixture({
        script: coach.script,
        token: TOKEN,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        routeChatAttachmentComposer: true,
        extraEnv: { LANG: "en_US.UTF-8", TZ: "UTC" },
      });
      coach.profilesPath = join(dirname(fixture.paths.configPath), "auth-profiles.json");
      await writeFile(coach.profilesPath, JSON.stringify({ "openai-codex": STORED_PROFILE }), {
        mode: 0o600,
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true });
      stopScreencast = await recordScreencast(context, page);
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await use({ page, coach });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      await stopScreencast?.(testInfo.outputPath("video.webm")).catch(() => undefined);
      if (page !== undefined) {
        await page
          .context()
          .tracing.stop({ path: testInfo.outputPath("trace.zip") })
          .catch(() => undefined);
      }
      if (failed && fixture !== undefined) {
        const surfaces = (["console", "stdout", "stderr"] as const).map(
          (surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`,
        );
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [`unexpected coach requests: ${coach.unexpected.join(", ")}`, ...surfaces].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await fixture?.close().catch(() => undefined);
    }
  },
});

async function navigate(page: Page, name: "Chat" | "Settings") {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true })
    .click();
}

test("after chat says the ChatGPT sign-in is no longer valid, Setup offers to sign in again", async ({
  desktop,
}, testInfo) => {
  const { page } = desktop;
  const shell = page.locator("[data-shell]");

  if ((await shell.getAttribute("data-shell")) === "gate") {
    await expect(page.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready");
    await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  }
  await expect(shell).toHaveAttribute("data-shell", "app");

  const box = page.getByRole("combobox", { name: "Message your coach" });
  await box.fill("How should I ride today?");
  await box.press("Enter");
  await expect(page.getByText(REAUTH_COPY).first()).toBeVisible();

  await navigate(page, "Settings");
  const aiRow = page.locator('[data-setup-row="ai"]');
  await expect(aiRow).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("setup-after-reauth-error.png") });
  await page
    .locator("[data-setup-card]")
    .first()
    .screenshot({ path: testInfo.outputPath("chatgpt-row.png") });

  await expect(
    aiRow.locator("[data-setup-row-subtitle]"),
    "Setup still says ChatGPT is connected right after chat said the sign-in is no longer valid",
  ).not.toHaveText(/Connected/u, { timeout: 1_000 });
  await expect(
    page.getByRole("button", { name: "Sign in with ChatGPT" }),
    "Setup gives the athlete no Sign in with ChatGPT button to sign in again",
  ).toBeVisible({ timeout: 1_000 });
});
