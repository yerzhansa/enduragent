import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const TOKEN = "c".repeat(43);
const TIMEOUT_MESSAGE = "Enduragent couldn’t finish checking Claude Code on this Mac.";

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
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
  readonly unexpected: string[] = [];

  readonly script: DesktopFixtureScript = {
    onRequest: (value) => {
      const request = value as ScriptRequest;
      switch (request.method) {
        case "getSetupStatus":
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
        case "getRuntimeConfig":
          return response(this.runtimeConfig());
        default:
          this.unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };

  private runtimeConfig() {
    return {
      schemaVersion: 3,
      llm: { provider: "anthropic", model: "synthetic-model", credential_configured: false },
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

interface FakeClaude {
  readonly path: string;
  stop(): Promise<void>;
}

async function createFakeClaude(): Promise<FakeClaude> {
  const folder = await mkdtemp(join(tmpdir(), "enduragent-fake-claude-"));
  const path = join(folder, "claude");
  const pids = join(folder, "pids");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "2.1.999 (Claude Code)"',
      "  /bin/sleep 110 &",
      `  echo $! >> '${pids}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return {
    path,
    async stop() {
      const started = (await readFile(pids, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => /^\d+$/u.test(line));
      if (started.length > 0) spawnSync("/bin/kill", ["-KILL", ...started], { stdio: "ignore" });
      await rm(folder, { recursive: true, force: true });
    },
  };
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
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new ScriptedCoach();
    const fakeClaude = await createFakeClaude();
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
        extraEnv: { LANG: "en_US.UTF-8", TZ: "UTC", CLAUDE_CLI_PATH: fakeClaude.path },
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
        await use({ page });
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
      await fakeClaude.stop();
      if (outcome !== undefined) expect(outcome.livePids).toEqual([]);
    }
  },
});

test.setTimeout(180_000);

test("tells the athlete when the Claude Code check does not finish", async ({
  desktop,
}, testInfo) => {
  const { page } = desktop;
  const shell = page.locator("[data-shell]");
  const trigger = page.locator('[data-setup-trigger="ai"]');

  await expect(shell).toHaveAttribute("data-shell", "gate");
  await trigger.click();
  await page.locator('[data-setup-menu="ai"] [data-lane="claude-cli"]').click();
  await expect(trigger, "Setup does not start checking Claude Code").toBeDisabled();
  const started = Date.now();

  await expect(trigger, "Setup never stops checking Claude Code").toBeEnabled({
    timeout: 100_000,
  });
  const checkedForSeconds = Math.round((Date.now() - started) / 1_000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("after-check-deadline.png") });

  expect(
    checkedForSeconds,
    "Setup stopped checking Claude Code before the check's 72 s deadline",
  ).toBeGreaterThanOrEqual(65);
  await expect(
    page.locator("#onboarding-error").getByText(TIMEOUT_MESSAGE),
    `Setup unlocked after checking Claude Code for ${checkedForSeconds} s and never said the check did not finish`,
  ).toBeVisible({ timeout: 1_000 });
});
