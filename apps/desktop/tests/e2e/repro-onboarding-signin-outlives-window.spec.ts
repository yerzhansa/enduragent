import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

const TOKEN = "d".repeat(43);

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
  private llm = { provider: "anthropic", model: "synthetic-model", configured: false };

  readonly script: DesktopFixtureScript = {
    onRequest: (value) => {
      const request = value as ScriptRequest;
      switch (request.method) {
        case "getSetupStatus":
          return response({ schemaVersion: 1, durableTrainingData: false });
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

interface ScreencastFrame {
  readonly data: Buffer;
  readonly at: number;
}

interface Screencast {
  readonly name: string;
  readonly frames: readonly ScreencastFrame[];
  stop(): Promise<void>;
}

async function recordScreencast(
  context: BrowserContext,
  page: Page,
  name: string,
): Promise<Screencast> {
  const session = await context.newCDPSession(page);
  const frames: ScreencastFrame[] = [];
  session.on("Page.screencastFrame", (event) => {
    frames.push({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  return {
    name,
    frames,
    stop: async () => {
      await session.send("Page.stopScreencast").catch(() => undefined);
    },
  };
}

async function writeVideo(
  path: string,
  clips: readonly (readonly ScreencastFrame[])[],
): Promise<void> {
  const recorded = clips.filter((frames) => frames.length > 0);
  if (recorded.length === 0) return;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const folder = (await readdir(cache).catch(() => [] as string[])).find((entry) =>
    entry.startsWith("ffmpeg-"),
  );
  if (folder === undefined) return;
  const encoder = spawn(
    join(cache, folder, "ffmpeg-mac"),
    ["-loglevel", "error", "-f", "image2pipe", "-framerate", "10", "-c:v", "mjpeg", "-i", "pipe:0"]
      .concat(["-vf", "scale=1180:820:force_original_aspect_ratio=decrease,pad=1180:820:-1:-1"])
      .concat(["-y", "-an", "-c:v", "vp8", "-b:v", "1M", "-deadline", "realtime", path]),
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const done = new Promise<void>((resolve) => encoder.once("close", () => resolve()));
  for (const frames of recorded) {
    const end = frames.at(-1)!.at + 1_000;
    let index = 0;
    for (let at = frames[0]!.at; at <= end; at += 100) {
      while (index + 1 < frames.length && frames[index + 1]!.at <= at) index += 1;
      encoder.stdin.write(frames[index]!.data);
    }
  }
  encoder.stdin.end();
  await done;
}

interface Desktop {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly fixture: RunningDesktopFixture;
  readonly coach: ScriptedCoach;
  readonly authorizeLog: string;
  record(page: Page, name: string): Promise<void>;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new ScriptedCoach();
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    const directory = await mkdtemp(join(tmpdir(), "repro-onboarding-d-"));
    const authorizeLog = join(directory, "intervals-authorize.log");
    try {
      fixture = await launchDesktopFixture({
        script: coach.script,
        token: TOKEN,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        inspectMain: true,
        extraEnv: {
          LANG: "en_US.UTF-8",
          TZ: "UTC",
          ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG: authorizeLog,
        },
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      const page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true });
      const screencasts = [await recordScreencast(context, page, "first-window")];
      const record = async (next: Page, name: string) => {
        screencasts.push(await recordScreencast(context, next, name));
      };
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      try {
        await use({ page, context, fixture, coach, authorizeLog, record });
      } finally {
        const bounded = (work: Promise<unknown>) =>
          Promise.race([
            work.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ]);
        await bounded(Promise.all(screencasts.map((screencast) => screencast.stop())));
        for (const screencast of screencasts) {
          await writeVideo(testInfo.outputPath(`${screencast.name}.webm`), [
            screencast.frames,
          ]).catch(() => undefined);
        }
        await writeVideo(
          testInfo.outputPath("video.webm"),
          screencasts.map((screencast) => screencast.frames),
        ).catch(() => undefined);
        await bounded(context.tracing.stop({ path: testInfo.outputPath("trace.zip") }));
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
      await rm(directory, { recursive: true, force: true });
      if (outcome !== undefined) expect(outcome.livePids).toEqual([]);
    }
  },
});

async function authorizeLines(log: string): Promise<number> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).length;
}

async function startIntervalsSignIn(page: Page): Promise<void> {
  await page.locator('[data-setup-trigger="training"]').click();
  await page.getByRole("button", { name: "Sign in with Intervals.icu", exact: true }).click();
}

async function reopenWindow(desktop: Desktop, crashFirst: boolean): Promise<Page> {
  if (crashFirst) {
    const crashed = await desktop.fixture.evaluateMain<boolean>(`
      const { createRequire } = process.getBuiltinModule("node:module");
      const { BrowserWindow } = createRequire(process.execPath)("electron");
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) window.webContents.forcefullyCrashRenderer();
      const deadline = Date.now() + 10000;
      while (windows.some((window) => !window.webContents.isCrashed()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return windows.every((window) => window.webContents.isCrashed());
    `);
    expect(crashed, "the first renderer did not crash").toBe(true);
  }
  await desktop.fixture.evaluateMain(`
    const { createRequire } = process.getBuiltinModule("node:module");
    const { app, BrowserWindow } = createRequire(process.execPath)("electron");
    for (const window of BrowserWindow.getAllWindows()) window.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    app.emit("activate");
    return true;
  `);
  let page: Page | undefined;
  await expect
    .poll(
      () => {
        page = desktop.context
          .pages()
          .find(
            (entry) =>
              entry !== desktop.page &&
              !entry.isClosed() &&
              entry.url().startsWith("enduragent://app/"),
          );
        return page !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (page === undefined) throw new Error("the reopened window has no renderer page");
  await desktop.record(page, "reopened-window");
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  return page;
}

for (const path of [
  { name: "a renderer crash", crashFirst: true },
  { name: "closing the window", crashFirst: false },
]) {
  test(`lets the reopened window sign in to Intervals.icu after ${path.name}`, async ({
    desktop,
  }, testInfo) => {
    await expect(desktop.page.locator("[data-shell]")).toHaveAttribute("data-shell", "gate");
    await startIntervalsSignIn(desktop.page);
    await expect(desktop.page.getByRole("button", { name: "Waiting for browser…" })).toBeVisible();
    await expect.poll(() => authorizeLines(desktop.authorizeLog)).toBe(1);

    const page = await reopenWindow(desktop, path.crashFirst);
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "gate");
    await startIntervalsSignIn(page);
    const falseError = page.getByText("couldn’t confirm the sign-in with Intervals.icu", {
      exact: false,
    });
    const waiting = page.getByRole("button", { name: "Waiting for browser…" });
    await expect
      .poll(async () => (await falseError.first().isVisible()) || (await waiting.isVisible()))
      .toBe(true);
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath("reopened-sign-in.png") });

    await expect(
      falseError,
      `After ${path.name} during an Intervals.icu sign-in, signing in again says "check your connection"`,
    ).toHaveCount(0, { timeout: 1_000 });
    await expect(
      page.getByRole("button", { name: "Cancel sign-in" }),
      "The reopened window offers no Cancel sign-in for the new attempt",
    ).toBeVisible({ timeout: 1_000 });
  });
}
