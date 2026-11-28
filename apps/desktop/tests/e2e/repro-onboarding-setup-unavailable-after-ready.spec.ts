import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
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

const TOKEN = "h".repeat(43);

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
  setupStatusFails = true;
  setupStatusCalls = 0;
  private llm = { provider: "anthropic", model: "synthetic-model", configured: false };

  readonly script: DesktopFixtureScript = {
    onRequest: (value) => {
      const request = value as ScriptRequest;
      switch (request.method) {
        case "getSetupStatus":
          this.setupStatusCalls += 1;
          if (this.setupStatusFails) throw new Error("synthetic coach still starting");
          return response({ schemaVersion: 1, durableTrainingData: true });
        case "getUnitsPreference":
          return response({ value: "metric", source: "default" });
        case "setUnitsPreference":
          return response({ value: "metric", source: "cycling" });
        case "getChatQueue":
          return response({ schemaVersion: 1, revision: 0, items: [] });
        case "resumeChatQueue":
          return response({ snapshot: { schemaVersion: 1, revision: 0, items: [] } });
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

interface Desktop {
  readonly page: Page;
  readonly fixture: RunningDesktopFixture;
  readonly coach: ScriptedCoach;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new ScriptedCoach();
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
        inspectMain: true,
        extraEnv: { LANG: "en_US.UTF-8", TZ: "UTC" },
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      const page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true });
      const stopScreencast = await recordScreencast(context, page);
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      try {
        await use({ page, fixture, coach });
      } finally {
        await stopScreencast(testInfo.outputPath("video.webm")).catch(() => undefined);
        await context.tracing
          .stop({ path: testInfo.outputPath("trace.zip") })
          .catch(() => undefined);
      }
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && fixture !== undefined) {
        const surfaces = (["console", "stdout", "stderr"] as const).map(
          (surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`,
        );
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [`unexpected coach requests: ${coach.unexpected.join(", ")}`, ...surfaces].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      const outcome = await fixture?.close();
      if (outcome !== undefined) expect(outcome.livePids).toEqual([]);
    }
  },
});

test.setTimeout(120_000);

test("recovers Setup on its own once the coach is back and announced ready", async ({
  desktop,
}, testInfo) => {
  const { page, fixture, coach } = desktop;
  const unavailable = page.getByText("Setup status couldn’t be loaded", { exact: false });

  await expect(unavailable).toBeVisible({ timeout: 45_000 });
  const callsWhenUnavailable = coach.setupStatusCalls;

  coach.setupStatusFails = false;
  await fixture.evaluateMain(`
    const { createRequire } = process.getBuiltinModule("node:module");
    const { BrowserWindow } = createRequire(process.execPath)("electron");
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("desktop:daemon-lifecycle", { status: "ready", generation: 1 });
    }
    return true;
  `);
  await expect(page.locator("html")).toHaveAttribute("data-rpc", "ready");
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: testInfo.outputPath("after-coach-ready.png") });

  await expect(
    unavailable,
    `Setup still says "Setup status couldn’t be loaded" 8 s after the coach came back (setup checks: ${callsWhenUnavailable} before, ${coach.setupStatusCalls} after)`,
  ).toHaveCount(0, { timeout: 1_000 });
  await expect(page.locator("[data-setup-readiness]")).toHaveText("1 of 2 required ready", {
    timeout: 1_000,
  });
});
