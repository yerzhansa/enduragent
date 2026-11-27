import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expect,
  test as base,
  type BrowserContext,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { desktopFixtureLaunchArgs } from "../helpers/desktop-fixture-launch-args.js";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(desktopRoot, "../..");
const RIDE_FIXTURE = join(
  repoRoot,
  "packages/kernel-node/tests/fixtures/ingest/fallback-cycling.gpx",
);
const DEEPSEEK_KEY = `sk-${"0".repeat(32)}`;
const QUESTION = "How should I pace my long ride this weekend?";
const PARTIAL_REPLY = "Start the first hour easy and";
const REPLY_WORDS = [" settle", " into", " a", " steady", " rhythm", " before", " you", " build."];
const STOPPED = "Response stopped. Your partial response is preserved.";
const COACH_CHANGE_REFUSED = "Coach settings couldn’t become active. Try again.";
const COACH_SAVING = "Saving coach settings…";

interface ModelRequest {
  readonly model: string;
  readonly held: boolean;
}

class StubModelProvider {
  readonly requests: ModelRequest[] = [];
  heldReplyClosed = false;
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body === "" ? "{}" : body) as {
          readonly model?: string;
          readonly stream?: boolean;
          readonly messages?: unknown;
        };
        const model = parsed.model ?? "";
        const held = parsed.stream === true && JSON.stringify(parsed.messages).includes(QUESTION);
        this.requests.push({ model, held });
        if (parsed.stream !== true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "chatcmpl-synthetic",
              object: "chat.completion",
              created: 902_000_000,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "null" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }),
          );
          return;
        }
        const chunk = (delta: object, finishReason: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-synthetic",
            object: "chat.completion.chunk",
            created: 902_000_000,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(chunk({ role: "assistant", content: PARTIAL_REPLY }, null));
        if (held) {
          let next = 0;
          const timer = setInterval(() => {
            response.write(chunk({ content: REPLY_WORDS[next % REPLY_WORDS.length] }, null));
            next += 1;
          }, 2_000);
          response.on("close", () => {
            clearInterval(timer);
            this.heldReplyClosed = true;
          });
          return;
        }
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((ready) => this.server.listen(0, "127.0.0.1", ready));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((closed) => this.server.close(() => closed()));
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

function isolatedEnvironment(athleteHome: string, userData: string): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of [
    "ELECTRON_CLI_ARGS",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_RUN_AS_NODE",
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
    "NO_COLOR",
    "NODE_OPTIONS",
    "DEEPSEEK_API_KEY",
    "LLM_API_KEY",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_BASE_URL",
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    ENDURAGENT_HOME: athleteHome,
    ENDURAGENT_DEVELOPMENT_USER_DATA: userData,
    ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "memory",
    ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
    ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
    ENDURAGENT_NO_USAGE_PING: "1",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  };
}

interface Desktop {
  readonly page: Page;
  readonly provider: StubModelProvider;
  readonly rideFile: string;
}

const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const scratch = await mkdtemp(join(await realpath(tmpdir()), "enduragent-stop-"));
    const athleteHome = join(scratch, "h");
    const userData = join(scratch, "u");
    await mkdir(join(athleteHome, "config"), { recursive: true, mode: 0o700 });
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const rideFile = join(scratch, "synthetic-ride.gpx");
    await copyFile(RIDE_FIXTURE, rideFile);
    const provider = new StubModelProvider();
    const providerUrl = await provider.start();
    await writeFile(
      join(athleteHome, "config", "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(athleteHome)}`,
        "llm:",
        "  provider: deepseek",
        "  model: deepseek-v4-flash",
        "  api_key: ''",
        `  base_url: ${JSON.stringify(providerUrl)}`,
        "intervals:",
        "  api_key: ''",
        "  athlete_id: '0'",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const messages: string[] = [];
    let application: ElectronApplication | undefined;
    let page: Page | undefined;
    let stopScreencast: ((path: string) => Promise<void>) | undefined;
    try {
      application = await playwright._electron.launch({
        executablePath: require("electron") as string,
        args: [desktopRoot, ...desktopFixtureLaunchArgs(process.platform, process.env.CI)],
        cwd: desktopRoot,
        env: isolatedEnvironment(athleteHome, userData),
        colorScheme: "light",
        locale: "en-US",
        timezoneId: "UTC",
        timeout: 45_000,
      });
      application.process().stderr?.on("data", (chunk: Buffer) => messages.push(chunk.toString()));
      page = await application.firstWindow({ timeout: 45_000 });
      page.on("console", (message) =>
        messages.push(`renderer ${message.type()}: ${message.text()}\n`),
      );
      await page.setViewportSize({ width: 1180, height: 820 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.context().route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      stopScreencast = await recordScreencast(page.context(), page);
      await use({ page, provider, rideFile });
    } finally {
      await stopScreencast?.(testInfo.outputPath("video.webm")).catch(() => undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [`model requests: ${JSON.stringify(provider.requests)}`, ...messages].join("\n"),
        ).catch(() => {});
        await cp(join(athleteHome, "logs"), testInfo.outputPath("coach-logs"), {
          recursive: true,
        }).catch(() => {});
      }
      const applicationProcess = application?.process();
      await application?.close().catch(() => {});
      if (applicationProcess !== undefined && applicationProcess.exitCode === null) {
        applicationProcess.kill("SIGKILL");
      }
      await provider.stop();
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
});

async function dropRideFile(page: Page, path: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  try {
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await session.send("Input.dispatchDragEvent", { type, x: 400, y: 300, data });
    }
  } finally {
    await session.detach();
  }
}

async function navigate(page: Page, name: "Chat" | "Settings") {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true })
    .click();
}

test("Stop ends the reply at once after a Coach model change made while it streamed", async ({
  desktop,
}, testInfo) => {
  test.setTimeout(120_000);
  const { page, provider, rideFile } = desktop;
  const shell = page.locator("[data-shell]");
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

  await expect(shell).toHaveAttribute("data-shell", "gate", { timeout: 45_000 });
  await dropRideFile(page, rideFile);
  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  const panel = page.locator('[data-setup-panel="api-key"]');
  await expect(panel).toBeVisible();
  await shot("01-key-panel");
  await page.locator("#onboarding-llm-provider").click();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await page.locator('input[data-slot="deepseek"]').fill(DEEPSEEK_KEY);
  await panel.locator("button", { hasText: /^Save$/u }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready", {
    timeout: 30_000,
  });
  await shot("02-ready");
  await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  await expect(shell).toHaveAttribute("data-shell", "app");

  const box = page.getByRole("combobox", { name: "Message your coach" });
  await box.fill(QUESTION);
  await box.press("Enter");
  await expect(page.getByText(PARTIAL_REPLY)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await shot("03-streaming");

  await navigate(page, "Settings");
  await page.locator("#coach-model").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_000);
  await page.locator("#coach-model").click();
  await page.getByRole("option", { selected: false }).first().click();
  await expect(page.getByText(COACH_SAVING).or(page.getByText(COACH_CHANGE_REFUSED))).toBeVisible();
  await page.waitForTimeout(1_000);
  await shot("04-coach-change");
  await expect(page.getByText(COACH_CHANGE_REFUSED)).toBeVisible({ timeout: 45_000 });
  await page.getByText(COACH_CHANGE_REFUSED).scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_500);

  await navigate(page, "Chat");
  await page.getByRole("button", { name: "Stop responding" }).click();
  await expect(
    page.getByText(STOPPED),
    "The athlete presses Stop and the reply keeps running because a coach change is waiting",
  ).toBeVisible({ timeout: 5_000 });
  await expect
    .poll(() => provider.heldReplyClosed, {
      message: "Stop ends the paid model request that was streaming the reply",
    })
    .toBe(true);
  await page.waitForTimeout(1_000);
  await shot("05-after-stop");
  await navigate(page, "Settings");
  await page.locator("#coach-model").scrollIntoViewIfNeeded();
  await expect(
    page.getByText("Currently active: DeepSeek · deepseek-flash"),
    "The refused coach change leaves the coach on the model it had",
  ).toBeVisible();
  await page.waitForTimeout(1_000);
  await shot("06-settings-after-stop");
  expect(
    provider.requests.filter((request) => request.held).map((request) => request.model),
    "The streaming reply came from the coach's model before the change",
  ).toEqual(["deepseek-flash"]);
});
