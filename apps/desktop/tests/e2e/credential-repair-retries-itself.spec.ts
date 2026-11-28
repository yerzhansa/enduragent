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

const TOKEN = "e".repeat(43);
const ANTHROPIC_KEY = `sk-ant-api03-${"1".repeat(80)}`;
const OUTAGE_MS = 10_000;
const RELOAD_NOTICE = "Saved credential status needs to be reloaded before setup can continue.";
const RELOAD_BUTTON = "Reload credential status";
const NOT_DELETED = "The coach could not stop using this credential safely. It was not deleted.";
const RECONNECTING = "The credential was not deleted. Reconnecting to the coach…";

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

function describeLlmRequest(params: unknown): string {
  const llm = (params as { readonly llm?: LlmRuntimeRequest }).llm;
  if (llm === undefined) return "no-llm";
  const change =
    llm.clear_credential === true ? "clear" : llm.api_key === undefined ? "select" : "key";
  return `${change} ${llm.provider ?? ""}`;
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

class OutageCoach {
  readonly llmRequests: LlmRuntimeRequest[] = [];
  readonly unexpected: string[] = [];
  readonly calls: string[] = [];
  private llm = { provider: "anthropic", model: "claude-sonnet-5", configured: false };
  private outageEndsAt = 0;
  refuseStoredKey = false;

  get credentialConfigured(): boolean {
    return this.llm.configured;
  }

  get outageOver(): boolean {
    return this.outageEndsAt > 0 && Date.now() >= this.outageEndsAt;
  }

  private unreachable(): boolean {
    return Date.now() < this.outageEndsAt;
  }

  readonly script: DesktopFixtureScript = {
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
        case "getChatQueue":
          return response({ schemaVersion: 1, revision: 0, items: [] });
        case "getChatAttachmentComposer":
        case "saveChatAttachmentDraftText":
        case "clearChatAttachmentDraft":
          return response(emptyAttachmentComposer);
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
          this.calls.push(`${Date.now()} configureRuntime ${describeLlmRequest(request.params)}`);
          return response(this.configure(request.params));
        case "getRuntimeConfig":
          this.calls.push(`${Date.now()} getRuntimeConfig unreachable=${this.unreachable()}`);
          if (this.unreachable()) throw new Error("coach unreachable");
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
        this.outageEndsAt = Date.now() + OUTAGE_MS;
        throw new Error("coach connection dropped after clearing the key");
      }
      if (this.unreachable()) throw new Error("coach unreachable");
      if (this.refuseStoredKey && this.outageEndsAt > 0) throw new Error("coach refused the key");
      this.llm = {
        provider: llm.provider ?? this.llm.provider,
        model: llm.model ?? this.llm.model,
        configured: this.llm.configured || llm.api_key !== undefined,
      };
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
  readonly coach: OutageCoach;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const coach = new OutageCoach();
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
          [
            `unexpected coach requests: ${coach.unexpected.join(", ")}`,
            `coach calls:\n${coach.calls.join("\n")}`,
            ...surfaces,
          ].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await fixture?.close().catch(() => undefined);
    }
  },
});

test.describe.configure({ timeout: 120_000 });

interface ShellHooks {
  __shellStates: string[];
}

function recordShellStates(): void {
  const hooks = window as unknown as ShellHooks;
  const read = (): string =>
    document.querySelector("[data-shell]")?.getAttribute("data-shell") ?? "";
  hooks.__shellStates = [read()];
  new MutationObserver(() => {
    const next = read();
    if (hooks.__shellStates.at(-1) !== next) hooks.__shellStates.push(next);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-shell"] });
}

function shellStates(): readonly string[] {
  return (window as unknown as ShellHooks).__shellStates;
}

async function finishSetupWithAnthropicKey(page: Page): Promise<void> {
  const shell = page.locator("[data-shell]");
  await expect(shell).toHaveAttribute("data-shell", "gate");
  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  const panel = page.locator('[data-setup-panel="api-key"]');
  await expect(panel).toBeVisible();
  await page.locator('input[data-slot="anthropic"]').fill(ANTHROPIC_KEY);
  await panel.locator("button", { hasText: /^Save$/u }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready");
  await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  await expect(shell).toHaveAttribute("data-shell", "app");
}

async function deleteAnthropicKeyDuringOutage(page: Page, coach: OutageCoach): Promise<void> {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const remove = page.getByRole("button", { name: "Delete the Anthropic credential" });
  await expect(remove).toBeEnabled();
  await page.waitForTimeout(800);
  await page.evaluate(recordShellStates);
  await remove.click();
  await page.getByRole("button", { name: "Confirm deletion of the Anthropic credential" }).click();
  await expect
    .poll(() => coach.llmRequests.some((request) => request.clear_credential === true))
    .toBe(true);
}

test("after the coach drops a key delete, the app reconciles by itself once the coach is back", async ({
  desktop,
}, testInfo) => {
  const { page, coach } = desktop;
  const shell = page.locator("[data-shell]");
  await finishSetupWithAnthropicKey(page);
  await deleteAnthropicKeyDuringOutage(page, coach);
  await expect(
    page.getByText(RECONNECTING),
    "While the coach is unreachable, Settings says the key was not deleted and that it is reconnecting",
  ).toBeVisible();
  expect(coach.outageOver, "The coach is still unreachable when the message shows").toBe(false);
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: testInfo.outputPath("during-outage.png") });

  await expect.poll(() => coach.outageOver, { timeout: OUTAGE_MS + 2_000 }).toBe(true);
  await expect(
    shell,
    "The Setup screen is still up after the coach came back, waiting for the athlete to press Reload credential status",
  ).toHaveAttribute("data-shell", "app", { timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: RELOAD_BUTTON }),
    "The athlete is still asked to reload credential status after the coach came back",
  ).toHaveCount(0);
  await expect(
    page.getByText(NOT_DELETED),
    "Settings tells the athlete the key was not deleted",
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete the Anthropic credential" }),
    "The athlete can delete the key again",
  ).toBeEnabled();
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: testInfo.outputPath("after-recovery.png") });
  expect(coach.credentialConfigured, "The coach uses the stored key again").toBe(true);
  expect(
    await page.evaluate(shellStates),
    "The app never sent the athlete to the Setup screen while it could recover by itself",
  ).not.toContain("gate");
});

test("an athlete who leaves Settings during the outage comes back to a reconciled key", async ({
  desktop,
}) => {
  const { page, coach } = desktop;
  const shell = page.locator("[data-shell]");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await finishSetupWithAnthropicKey(page);
  await deleteAnthropicKeyDuringOutage(page, coach);
  await navigation.getByRole("button", { name: "Chat", exact: true }).click();

  await expect.poll(() => coach.outageOver, { timeout: OUTAGE_MS + 2_000 }).toBe(true);
  await expect
    .poll(() => coach.credentialConfigured, {
      message: "The coach gets the stored key again while the athlete is in Chat",
      timeout: 20_000,
    })
    .toBe(true);
  await expect(shell, "The athlete stays in the app").toHaveAttribute("data-shell", "app");
  await navigation.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Delete the Anthropic credential" }),
    "Back in Settings, the athlete can delete the key again",
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: RELOAD_BUTTON })).toHaveCount(0);
  expect(
    await page.evaluate(shellStates),
    "The app never sent the athlete to the Setup screen",
  ).not.toContain("gate");
});

test("when the coach is back but still refuses the stored key, the athlete is asked to reload", async ({
  desktop,
}, testInfo) => {
  const { page, coach } = desktop;
  const shell = page.locator("[data-shell]");
  await finishSetupWithAnthropicKey(page);
  coach.refuseStoredKey = true;
  await deleteAnthropicKeyDuringOutage(page, coach);

  await expect.poll(() => coach.outageOver, { timeout: OUTAGE_MS + 2_000 }).toBe(true);
  await expect(shell, "The athlete is sent to the Setup screen").toHaveAttribute(
    "data-shell",
    "gate",
    { timeout: 40_000 },
  );
  await expect(
    page.getByText(RELOAD_NOTICE),
    "Setup says saved credential status needs reloading",
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: RELOAD_BUTTON }),
    "Setup offers Reload credential status",
  ).toBeEnabled();
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: testInfo.outputPath("still-diverged.png") });
});
