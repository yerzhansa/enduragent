import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledAcceptedCatalog } from "@enduragent/core";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { spawn } from "node:child_process";
import { readdir as readScreencastDirectory } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinScreencastPath } from "node:path";
import type { BrowserContext } from "@playwright/test";

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
    const cache = joinScreencastPath(homedir(), "Library/Caches/ms-playwright");
    const folder = (await readScreencastDirectory(cache).catch(() => [] as string[])).find(
      (entry) => entry.startsWith("ffmpeg-"),
    );
    if (folder === undefined) return;
    const encoder = spawn(
      joinScreencastPath(cache, folder, "ffmpeg-mac"),
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

const TOKEN = "k".repeat(43);
const ANTHROPIC_KEY = `sk-ant-api03-${"0".repeat(80)}`;
const OPENROUTER_KEY = `sk-or-v1-${"0".repeat(64)}`;
const TURN_ID = "turn-repro-llm-picker-delete";

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface LlmRuntimeRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly api_key?: string;
  readonly clear_credential?: boolean;
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
  readonly llmRequests: LlmRuntimeRequest[] = [];
  readonly unexpected: string[] = [];
  private llm = { provider: "anthropic", model: "claude-sonnet-5", configured: false };
  private revision = 0;
  private queued: QueuedMessage[] = [];
  private hasSession = false;
  private releaseReply: (() => void) | undefined;
  private releaseClear: (() => void) | undefined;
  replyStreaming = false;

  release(): void {
    this.releaseClear?.();
    this.releaseReply?.();
  }

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
      emitFrame(JSON.stringify({ type: "turn-start", turnId: TURN_ID, chatId: "desktop" }));
      emitFrame(
        JSON.stringify({ type: "text_delta", turnId: TURN_ID, delta: "Here is your plan for" }),
      );
      this.replyStreaming = true;
      await new Promise<void>((resolve) => {
        this.releaseReply = resolve;
      });
      this.replyStreaming = false;
      const text = "Here is your plan for the week.";
      emitFrame(JSON.stringify({ type: "final-text", turnId: TURN_ID, text }));
      this.queued = [];
      this.revision += 1;
      return JSON.stringify({ snapshot: this.snapshot(), response: { text } });
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
        case "configureRuntime":
          return response(await this.configure(request.params));
        case "getRuntimeConfig":
          return response(this.runtimeConfig());
        default:
          this.unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };

  private async configure(params: unknown) {
    const request = params as {
      readonly llm?: LlmRuntimeRequest;
      readonly intervals?: unknown;
      readonly session?: unknown;
    };
    const llm = request.llm;
    if (llm !== undefined) {
      this.llmRequests.push(llm);
      if (llm.clear_credential === true) {
        if (this.replyStreaming) {
          await new Promise<void>((resolve) => {
            this.releaseClear = resolve;
          });
        }
        if (llm.provider === this.llm.provider) this.llm = { ...this.llm, configured: false };
      } else {
        this.llm = {
          provider: llm.provider ?? this.llm.provider,
          model: llm.model ?? this.llm.model,
          configured: this.llm.configured || llm.api_key !== undefined,
        };
      }
    }
    return {
      schemaVersion: 3,
      status: "applied",
      applied: {
        llm: llm !== undefined,
        intervals: request.intervals !== undefined,
        session: request.session !== undefined,
      },
    };
  }

  private runtimeConfig() {
    return {
      schemaVersion: 3,
      llm: {
        provider: this.llm.provider,
        model: this.llm.model,
        credential_configured: this.llm.configured,
      },
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
    };
  }
}

interface Desktop {
  readonly page: Page;
  readonly coach: ScriptedCoach;
  readonly athleteHome: string;
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
      await use({ page, coach, athleteHome: fixture.paths.athleteHome });
    } finally {
      coach.release();
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

async function finishSetupWithAnthropic(page: Page) {
  const shell = page.locator("[data-shell]");
  await expect(shell).toHaveAttribute("data-shell", "gate");
  await saveApiKey(page, "Anthropic", ANTHROPIC_KEY);
  await expect(page.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready");
  await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  await expect(shell).toHaveAttribute("data-shell", "app");
}

async function saveApiKey(page: Page, provider: "Anthropic" | "OpenRouter", key: string) {
  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  const panel = page.locator('[data-setup-panel="api-key"]');
  await expect(panel).toBeVisible();
  if (provider === "OpenRouter") {
    await page.locator("#onboarding-llm-provider").click();
    await page.getByRole("option", { name: "OpenRouter", exact: true }).click();
  }
  const slot = provider === "Anthropic" ? "anthropic" : "openrouter";
  await page.locator(`input[data-slot="${slot}"]`).fill(key);
  await panel.locator("button", { hasText: /^Save$/u }).click();
  await expect(panel).toHaveCount(0);
}

async function publishCatalogRevision(athleteHome: string, revision: number) {
  const snapshot = structuredClone(bundledAcceptedCatalog().snapshot);
  snapshot.revision = revision;
  snapshot.provenance = { kind: "published", publishedAt: "1998-07-18T00:00:00.000Z" };
  const directory = join(athleteHome, "config", "model-catalog");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "accepted-snapshot.json"),
    `${JSON.stringify({
      formatVersion: 1,
      etag: `revision-${revision}`,
      lastSuccessfulRefreshAt: "1998-07-18T00:00:00.000Z",
      snapshot,
    })}\n`,
  );
}

test("Setup still saves a key after two catalog updates while the app stayed open", async ({
  desktop,
}, testInfo) => {
  const { page, athleteHome } = desktop;
  await finishSetupWithAnthropic(page);
  const readRevision = () =>
    page.evaluate(async () => {
      const auth = (
        window as unknown as {
          enduragentAuth: { llmConfiguration(): Promise<{ catalogRevision: number }> };
        }
      ).enduragentAuth;
      return (await auth.llmConfiguration()).catalogRevision;
    });
  const bootRevision = await readRevision();

  await publishCatalogRevision(athleteHome, bootRevision + 1);
  await navigate(page, "Settings");
  await expect(page.locator("#coach-provider-label")).toContainText("Anthropic");
  await navigate(page, "Chat");

  await publishCatalogRevision(athleteHome, bootRevision + 2);
  await navigate(page, "Settings");
  await expect(page.locator("#coach-provider-label")).toContainText("Anthropic");

  await expect.poll(readRevision).toBe(bootRevision + 2);

  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  const panel = page.locator('[data-setup-panel="api-key"]');
  await expect(panel).toBeVisible();
  await page.locator("#onboarding-llm-provider").click();
  await page.getByRole("option", { name: "OpenRouter", exact: true }).click();
  await page.locator('input[data-slot="openrouter"]').fill(OPENROUTER_KEY);
  await panel.locator("button", { hasText: /^Save$/u }).click();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: testInfo.outputPath("setup-save-after-two-catalogs.png") });

  await expect(
    page.getByText("Coach choices are unavailable right now. Check the setup area again."),
    "Setup refuses the save with 'Coach choices are unavailable right now' after two catalog updates",
  ).toHaveCount(0, { timeout: 1_000 });
  await expect(panel, "The key panel stays open because the save failed").toHaveCount(0, {
    timeout: 1_000,
  });
  expect(
    desktop.coach.llmRequests.some(
      (request) => request.provider === "openrouter" && request.api_key === OPENROUTER_KEY,
    ),
    "The coach never receives the OpenRouter key",
  ).toBe(true);
});
