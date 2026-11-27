import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const TOKEN = "s".repeat(43);
const ANTHROPIC_KEY = `sk-ant-api03-${"0".repeat(80)}`;
const LEFTOVER = ".anthropic.bin.seed-leftover.tmp";
const STORAGE_UNCERTAIN =
  "The app could not prove which saved key will survive a restart. Re-enter the key before continuing.";

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
  private readonly queue = { schemaVersion: 1 as const, revision: 0, items: [] };

  readonly script: DesktopFixtureScript = {
    onStreamRequest: async (value) => {
      const request = value as ScriptRequest;
      this.unexpected.push(`stream:${request.method}`);
      throw new Error(`Unexpected streamed Coach request: ${request.method}`);
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
          return response(this.queue);
        case "getChatAttachmentComposer":
        case "saveChatAttachmentDraftText":
        case "removeChatAttachment":
        case "retryChatAttachment":
        case "selectChatAttachmentWorkout":
        case "clearChatAttachmentDraft":
          return response(emptyAttachmentComposer);
        case "stopChat":
          return response({ stopped: false });
        case "hasSession":
          return response({ hasSession: false });
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
          return response(this.configure(request.params));
        case "getRuntimeConfig":
          return response(this.runtimeConfig());
        default:
          this.unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };

  private configure(params: unknown) {
    const request = params as {
      readonly llm?: LlmRuntimeRequest;
      readonly intervals?: unknown;
      readonly session?: unknown;
    };
    const llm = request.llm;
    if (llm !== undefined) {
      this.llmRequests.push(llm);
      if (llm.clear_credential === true) {
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
  readonly leftover: string;
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
      const credentialRoot = join(fixture.paths.userData, "credentials-v1");
      const leftover = join(credentialRoot, LEFTOVER);
      await fixture.relaunch(async () => {
        await mkdir(credentialRoot, { recursive: true, mode: 0o700 });
        await chmod(credentialRoot, 0o700);
        await mkdir(leftover, { mode: 0o700 });
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
      await use({ page, coach, leftover });
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

async function saveAnthropicKey(page: Page) {
  const panel = page.locator('[data-setup-panel="api-key"]');
  if (!(await panel.isVisible())) {
    await page.locator('[data-setup-trigger="ai"]').click();
    await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  }
  await expect(panel).toBeVisible();
  await page.locator('input[data-slot="anthropic"]').fill(ANTHROPIC_KEY);
  await panel.locator("button", { hasText: /^Save$/u }).click();
  return panel;
}

test("Remove all credentials clears a storage warning so the next key save works", async ({
  desktop,
}, testInfo) => {
  const { page, leftover } = desktop;
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "gate");

  const panel = await saveAnthropicKey(page);
  await expect(panel.getByText(STORAGE_UNCERTAIN)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("01-save-refused.png") });

  await rm(leftover, { recursive: true, force: true });

  const reset = await page.evaluate(() =>
    (
      window as unknown as {
        readonly enduragentAuth: { resetAllCredentials(): Promise<{ readonly status: string }> };
      }
    ).enduragentAuth.resetAllCredentials(),
  );
  expect(reset, "Remove all credentials did not finish, so this run proves nothing").toMatchObject({
    status: "reset",
  });

  await saveAnthropicKey(page);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: testInfo.outputPath("02-save-after-remove-all.png") });
  await expect(
    panel,
    "Every key save still fails after Remove all credentials: Setup keeps the key form open",
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready");
  await expect(page.getByText(STORAGE_UNCERTAIN)).toHaveCount(0);
});
