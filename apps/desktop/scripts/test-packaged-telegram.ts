import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdp, reservePort, waitForPage } from "./support/desktop-cdp.js";
import {
  prepareDisposableKeychain,
  type DisposableKeychain,
} from "./support/packaged-telegram/disposable-keychain.js";
import { preparePackagedTelegramSetupFixture } from "./support/packaged-telegram/setup-fixture.js";
import {
  observeTelegramAcceptanceChild,
  releaseAcceptanceStorage,
  TELEGRAM_ACCEPTANCE_QUIT_FRAME,
  telegramAcceptanceDirectExitIsClean,
  telegramAcceptanceBundleTextIsClear,
  telegramAcceptanceDebuggerListenerOwner,
  telegramAcceptanceJsonDiagnostic,
  telegramAcceptanceProcessTableIsClear,
  telegramAcceptanceLaunchDiagnostic,
  telegramAcceptanceShutdownIsProven,
  type TelegramAcceptanceApplicationLaunch,
  type TelegramAcceptanceApplicationTerminal,
} from "./support/packaged-telegram/process-safety.js";
import {
  ACCEPTANCE_OS_LOGIN_MARKER_ENV,
  ACCEPTANCE_OS_LOGIN_MARKER_VALUE,
} from "./support/packaged-telegram/startup-mode.js";
import {
  callAcceptanceCdp as callCdpWithin,
  runAcceptanceCommand as runCommand,
  terminateAcceptanceChild,
  withAcceptanceDeadline,
} from "./support/packaged-telegram/acceptance-deadline.js";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const application = join(
  desktopRoot,
  "dist/telegram-acceptance-package/mac-arm64/Enduragent Telegram Acceptance.app",
);
const executable = join(application, "Contents/MacOS/Enduragent Telegram Acceptance");
const TELEGRAM_VAULT_DIRECTORY = "telegram-channel-v1";
const TELEGRAM_PROFILE_FILE = "profile.bin";
const TELEGRAM_DESIRED_STATE_FILE = "desired-state.json";
const BACKGROUND_PREFERENCE_DIRECTORY = "desktop-preferences-v1";
const BACKGROUND_PREFERENCE_FILE = "background-at-login.json";
const GENERIC_FAILURE = "Sorry, something went wrong. Please try again.";
const EXPECTED_WELCOME_MESSAGE =
  "Welcome to Cycling Coach!\n\n" +
  "I'm your AI cycling coach. I can build training plans, suggest workouts, " +
  "and track your fitness using intervals.icu data.\n\n" +
  "Commands:\n" +
  "/plan — Generate a training plan\n" +
  "/workout — Get today's workout\n" +
  "/status — Check current fitness, fatigue, and form\n" +
  "/review — Review your last session\n" +
  "/sync — Force-refresh training data from intervals.icu\n" +
  "/version — Show current version\n" +
  "/whatsnew — See what changed in the latest version\n" +
  "/update — Check for updates in the Desktop app\n\n" +
  "Or just chat with me about your training!";
const BOT_USERNAME = "EnduragentAcceptanceBot";
const BOT_ID = 71_234_567;
const SENDER_ID = 42_424_242;

type AcceptancePhase =
  | "setup"
  | "keychain"
  | "keychain-ready"
  | "initial-launch"
  | "token-configure"
  | "token-configured"
  | "paired"
  | "initial-quit"
  | "background-relaunch"
  | "background-ready"
  | "resident-lifecycle"
  | "window-close"
  | "secondary-launch"
  | "disable"
  | "disabled"
  | "disabled-quit"
  | "disabled-relaunch"
  | "removal"
  | "final-quit"
  | "post-removal-relaunch"
  | "post-removal-ready"
  | "post-removal-quit"
  | "cleanup"
  | "cleanup-processes"
  | "cleanup-storage"
  | "complete";

interface RunningApplication {
  readonly child: ChildProcess;
  readonly debugPort: number;
  readonly launch: Promise<TelegramAcceptanceApplicationLaunch>;
  readonly terminal: Promise<TelegramAcceptanceApplicationTerminal>;
  browserConnection: Awaited<ReturnType<typeof connectCdp>> | undefined;
  readonly requestQuit: () => Promise<void>;
  readonly output: () => { readonly stdout: string; readonly stderr: string };
}

interface DebuggerAuthority {
  readonly pid: number;
  readonly connection: Awaited<ReturnType<typeof connectCdp>>;
  readonly environment: NodeJS.ProcessEnv;
}

interface SentMessage {
  readonly chatId: number;
  readonly text: string;
}

interface GetUpdatesRequestObservation {
  readonly sequence: number;
  readonly offset: number;
  readonly selectedUpdateIds: readonly number[];
  readonly state: "pending" | "settled" | "cancelled";
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message: {
    readonly message_id: number;
    readonly date: number;
    readonly from: {
      readonly id: number;
      readonly is_bot: false;
      readonly first_name: string;
      readonly username: string;
    };
    readonly chat: {
      readonly id: number;
      readonly type: "private";
      readonly first_name: string;
      readonly username: string;
    };
    readonly text: string;
    readonly entities?: readonly {
      readonly offset: 0;
      readonly length: number;
      readonly type: "bot_command";
    }[];
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reportPhase(phase: AcceptancePhase): void {
  process.stderr.write(`[packaged-telegram] ${phase}\n`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function clipboardBytes(): Promise<Buffer> {
  const result = await runCommand("/usr/bin/pbpaste", [], { allowFailure: true });
  return result.stdout;
}

async function writeClipboard(value: Buffer | string): Promise<void> {
  await runCommand("/usr/bin/pbcopy", [], { input: value });
}

function parseRequestBody(chunks: readonly Buffer[]): Record<string, unknown> {
  const source = Buffer.concat(chunks).toString("utf8");
  if (source.length === 0) return {};
  const value = JSON.parse(source) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bot API payload is invalid");
  }
  return value as Record<string, unknown>;
}

function botApiResponse(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    connection: "close",
  });
  response.end(bytes);
}

function privateUpdate(updateId: number, messageId: number, text: string): TelegramUpdate {
  const command = text.startsWith("/");
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 946_684_800 + messageId,
      from: {
        id: SENDER_ID,
        is_bot: false,
        first_name: "Acceptance",
        username: "acceptance_athlete",
      },
      chat: {
        id: SENDER_ID,
        type: "private",
        first_name: "Acceptance",
        username: "acceptance_athlete",
      },
      text,
      ...(command
        ? { entities: [{ offset: 0 as const, length: text.length, type: "bot_command" as const }] }
        : {}),
    },
  };
}

async function createTelegramBotApi(token: string) {
  let updateSequence = 1_000;
  let messageSequence = 2_000;
  let pollRequests = 0;
  let cancelledPolls = 0;
  let getUpdatesSequence = 0;
  const updates: TelegramUpdate[] = [];
  const sentMessages: SentMessage[] = [];
  const methods: string[] = [];
  const contentTypes = new Set<string>();
  const chatActions: Record<string, unknown>[] = [];
  const getUpdatesRequests: {
    sequence: number;
    offset: number;
    selectedUpdateIds: number[];
    state: "pending" | "settled" | "cancelled";
  }[] = [];
  const pending = new Set<{
    readonly payload: Record<string, unknown>;
    readonly response: ServerResponse;
    readonly observation: (typeof getUpdatesRequests)[number];
  }>();

  const requestOffset = (payload: Record<string, unknown>): number =>
    typeof payload.offset === "number" && Number.isSafeInteger(payload.offset) ? payload.offset : 0;
  const selectUpdates = (payload: Record<string, unknown>): readonly TelegramUpdate[] => {
    const offset = requestOffset(payload);
    const limit =
      typeof payload.limit === "number" && Number.isSafeInteger(payload.limit)
        ? payload.limit
        : 100;
    return updates.filter((update) => update.update_id >= offset).slice(0, limit);
  };
  const settleGetUpdates = (
    waiter: {
      readonly response: ServerResponse;
      readonly observation: (typeof getUpdatesRequests)[number];
    },
    selected: readonly TelegramUpdate[],
  ): void => {
    waiter.observation.selectedUpdateIds = selected.map((update) => update.update_id);
    waiter.observation.state = "settled";
    if (!waiter.response.writableEnded) {
      botApiResponse(waiter.response, 200, { ok: true, result: selected });
    }
  };
  const settlePending = (): void => {
    for (const waiter of pending) {
      const selected = selectUpdates(waiter.payload);
      if (selected.length === 0 && waiter.payload.limit !== 1) continue;
      pending.delete(waiter);
      settleGetUpdates(waiter, selected);
    }
  };

  const http = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1_048_576) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        if (request.method !== "POST" || request.url === undefined) {
          botApiResponse(response, 405, { ok: false, error_code: 405 });
          return;
        }
        const match = /^\/bot([^/]+)\/([A-Za-z][A-Za-z0-9]*)$/u.exec(request.url);
        if (match === null || match[1] !== token) {
          botApiResponse(response, 401, { ok: false, error_code: 401 });
          return;
        }
        const method = match[2];
        const contentType = request.headers["content-type"];
        if (contentType !== "application/json") {
          botApiResponse(response, 415, { ok: false, error_code: 415 });
          return;
        }
        methods.push(method);
        contentTypes.add(contentType);
        const payload = parseRequestBody(chunks);
        if (method === "getMe") {
          botApiResponse(response, 200, {
            ok: true,
            result: {
              id: BOT_ID,
              is_bot: true,
              first_name: "Enduragent Acceptance",
              username: BOT_USERNAME,
            },
          });
          return;
        }
        if (method === "getWebhookInfo") {
          botApiResponse(response, 200, {
            ok: true,
            result: { url: "", has_custom_certificate: false, pending_update_count: 0 },
          });
          return;
        }
        if (["deleteWebhook", "setMyCommands"].includes(method)) {
          botApiResponse(response, 200, { ok: true, result: true });
          return;
        }
        if (method === "sendChatAction") {
          chatActions.push(payload);
          botApiResponse(response, 200, { ok: true, result: true });
          return;
        }
        if (method === "getUpdates") {
          pollRequests += 1;
          const observation = {
            sequence: ++getUpdatesSequence,
            offset: requestOffset(payload),
            selectedUpdateIds: [] as number[],
            state: "pending" as const,
          };
          getUpdatesRequests.push(observation);
          const selected = selectUpdates(payload);
          if (selected.length > 0 || payload.limit === 1) {
            settleGetUpdates({ response, observation }, selected);
            return;
          }
          const waiter = { payload, response, observation };
          pending.add(waiter);
          response.once("close", () => {
            if (pending.delete(waiter) && !response.writableEnded) {
              observation.state = "cancelled";
              cancelledPolls += 1;
            }
          });
          return;
        }
        if (method === "sendMessage") {
          if (typeof payload.text !== "string" || payload.text.length === 0) {
            botApiResponse(response, 400, { ok: false, error_code: 400 });
            return;
          }
          const chatId = Number(payload.chat_id);
          if (!Number.isSafeInteger(chatId)) {
            botApiResponse(response, 400, { ok: false, error_code: 400 });
            return;
          }
          sentMessages.push({ chatId, text: payload.text });
          botApiResponse(response, 200, {
            ok: true,
            result: {
              message_id: ++messageSequence,
              date: 946_684_800 + messageSequence,
              chat: { id: chatId, type: "private", first_name: "Acceptance" },
              text: payload.text,
            },
          });
          return;
        }
        botApiResponse(response, 404, { ok: false, error_code: 404 });
      } catch {
        if (!response.writableEnded) {
          botApiResponse(response, 400, { ok: false, error_code: 400 });
        }
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    http.once("error", rejectListen);
    http.listen({ host: "127.0.0.1", port: 0 }, () => resolveListen());
  });
  const address = http.address();
  assert(address !== null && typeof address !== "string", "Bot API listener has no port");
  const listenerPort = address.port;
  return {
    origin: `http://127.0.0.1:${listenerPort}`,
    listenerPort,
    enqueue(text: string): TelegramUpdate {
      const update = privateUpdate(++updateSequence, ++messageSequence, text);
      updates.push(update);
      settlePending();
      return update;
    },
    sentMessages,
    chatActions,
    pollCount: () => pollRequests,
    cancelledPollCount: () => cancelledPolls,
    activePollCount: () => pending.size,
    getUpdatesRequests: (): readonly GetUpdatesRequestObservation[] =>
      getUpdatesRequests.map((request) => ({
        ...request,
        selectedUpdateIds: [...request.selectedUpdateIds],
      })),
    methods: () => [...methods],
    contentTypes: () => [...contentTypes],
    async close() {
      const closed = new Promise<void>((resolveClose, rejectClose) => {
        http.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
      for (const waiter of pending) {
        pending.delete(waiter);
        settleGetUpdates(waiter, []);
      }
      http.closeAllConnections();
      await withAcceptanceDeadline("Bot API shutdown", closed, {
        timeoutMs: 5_000,
        onTimeout: () => http.closeAllConnections(),
      });
    },
  };
}

function launchApplication(
  environment: NodeJS.ProcessEnv,
  debugPort: number,
  userData: string,
): RunningApplication {
  const args = [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`];
  const child = spawn(executable, args, {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const lifecycle = observeTelegramAcceptanceChild(child);
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let quitRequest: Promise<void> | undefined;
  const requestQuit = (): Promise<void> => {
    if (quitRequest !== undefined) return quitRequest;
    const delivery = new Promise<void>((resolveRequest) => {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        child.stdin === null ||
        child.stdin.destroyed ||
        !child.stdin.writable
      ) {
        resolveRequest();
        return;
      }
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolveRequest();
      };
      child.stdin.once("error", settle);
      try {
        child.stdin.end(TELEGRAM_ACCEPTANCE_QUIT_FRAME, settle);
      } catch {
        settle();
      }
    });
    quitRequest = withAcceptanceDeadline("packaged Desktop quit request", delivery, {
      timeoutMs: 2_000,
      onTimeout: () => child.stdin?.destroy(),
    }).catch(() => undefined);
    return quitRequest;
  };
  return {
    child,
    debugPort,
    ...lifecycle,
    browserConnection: undefined,
    requestQuit,
    output: () => ({ stdout, stderr }),
  };
}

function redactSensitiveText(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue !== "") redacted = redacted.replaceAll(sensitiveValue, "<redacted>");
  }
  return redacted;
}

function boundedDiagnostic(value: string, maximumLength = 4_000): string {
  if (value.length <= maximumLength) return value;
  const retainedLength = Math.max(0, maximumLength - "<truncated>".length);
  const headLength = Math.ceil(retainedLength / 2);
  return `${value.slice(0, headLength)}<truncated>${value.slice(-retainedLength + headLength)}`;
}

function redactedDiagnostic(value: string, sensitiveValues: readonly string[]): string {
  return boundedDiagnostic(redactSensitiveText(value, sensitiveValues));
}

function runningApplicationDiagnostic(
  running: RunningApplication,
  sensitiveValues: readonly string[],
): string {
  return telegramAcceptanceLaunchDiagnostic({
    pid: running.child.pid,
    code: running.child.exitCode,
    signal: running.child.signalCode,
    output: running.output(),
    sensitiveValues,
  });
}

function runningApplicationDiagnostics(
  runningApplications: readonly RunningApplication[],
  sensitiveValues: readonly string[],
): string {
  if (runningApplications.length === 0) return "applications=[]";
  return `applications=[${runningApplications
    .map(
      (running, index) =>
        `{index=${index}; ${runningApplicationDiagnostic(running, sensitiveValues)}}`,
    )
    .join(", ")}]`;
}

function errorWithRunningApplicationDiagnostics(
  error: unknown,
  runningApplications: readonly RunningApplication[],
  sensitiveValues: readonly string[],
): Error {
  const message = redactedDiagnostic(
    error instanceof Error ? error.message : "packaged Desktop execution failed",
    sensitiveValues,
  );
  return new Error(
    `${message}; ${runningApplicationDiagnostics(runningApplications, sensitiveValues)}`,
  );
}

interface MainRendererTarget {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

async function mainRendererTargets(
  port: number,
  authority: DebuggerAuthority,
): Promise<readonly MainRendererTarget[]> {
  await assertDebuggerListenerOwner(port, authority.pid, authority.environment);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error("Desktop debugging target list was unavailable");
  const targets = (await response.json()) as readonly MainRendererTarget[];
  await assertDebuggerListenerOwner(port, authority.pid, authority.environment);
  const rendererTargets = targets.filter(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.startsWith("enduragent://app/") &&
      typeof target.webSocketDebuggerUrl === "string",
  );
  for (const target of rendererTargets) {
    validateDebuggerUrl(target.webSocketDebuggerUrl as string, port, "/devtools/page/");
  }
  return rendererTargets;
}

function validateDebuggerUrl(value: string, port: number, pathPrefix: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== String(port) ||
    !url.pathname.startsWith(pathPrefix)
  ) {
    throw new TypeError("Desktop debugger target is invalid");
  }
}

async function connectCdpWithin(
  url: string,
  timeoutMs = 2_500,
): Promise<Awaited<ReturnType<typeof connectCdp>>> {
  let timedOut = false;
  const pending = connectCdp(url, () => undefined).then((connection) => {
    if (timedOut) {
      connection.socket.close();
      throw new Error("Desktop debugger connection timed out");
    }
    return connection;
  });
  void pending.catch(() => undefined);
  const connection = await withAcceptanceDeadline("Desktop debugger connection", pending, {
    timeoutMs,
    onTimeout: () => {
      timedOut = true;
    },
  });
  return connection;
}

async function debuggerListenerOwner(
  port: number,
  environment: NodeJS.ProcessEnv,
): Promise<number | undefined> {
  if (typeof environment.HOME !== "string") {
    throw new TypeError("Desktop debugger-listener environment is invalid");
  }
  const result = await runCommand(
    "/usr/sbin/lsof",
    ["-n", "-P", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-F0p"],
    {
      allowFailure: true,
      environment: { ...process.env, HOME: environment.HOME },
    },
  );
  return telegramAcceptanceDebuggerListenerOwner(result);
}

async function assertDebuggerListenerOwner(
  port: number,
  expectedPid: number,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if ((await debuggerListenerOwner(port, environment)) !== expectedPid) {
    throw new TypeError("Desktop debugger listener is outside the launched application");
  }
}

async function connectBrowserDebugger(
  port: number,
  expectedPid: number,
  environment: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof connectCdp>>> {
  let debuggerUrl: string | undefined;
  await waitUntil("Desktop browser debugger", async () => {
    const owner = await debuggerListenerOwner(port, environment);
    if (owner === undefined) return false;
    if (owner !== expectedPid) {
      throw new TypeError("Desktop debugger listener is outside the launched application");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return false;
      const target = (await response.json()) as { readonly webSocketDebuggerUrl?: unknown };
      if (typeof target.webSocketDebuggerUrl !== "string") return false;
      validateDebuggerUrl(target.webSocketDebuggerUrl, port, "/devtools/browser/");
      debuggerUrl = target.webSocketDebuggerUrl;
      return true;
    } catch (error) {
      if (error instanceof TypeError && error.message === "Desktop debugger target is invalid") {
        throw error;
      }
      return false;
    }
  });
  assert(debuggerUrl !== undefined, "Desktop browser debugger target is unavailable");
  const connection = await connectCdpWithin(debuggerUrl);
  try {
    await assertDebuggerListenerOwner(port, expectedPid, environment);
    return connection;
  } catch (error) {
    connection.socket.close();
    throw error;
  }
}

async function seedBackgroundAtLoginPreference(userData: string): Promise<void> {
  const root = join(userData, BACKGROUND_PREFERENCE_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, BACKGROUND_PREFERENCE_FILE),
    `${JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      loginLaunchBehavior: "background",
    })}\n`,
    { mode: 0o600 },
  );
}

async function cdpPage(port: number, authority: DebuggerAuthority) {
  const debuggerUrl = await waitForPage(port);
  validateDebuggerUrl(debuggerUrl, port, "/devtools/page/");
  await assertDebuggerListenerOwner(port, authority.pid, authority.environment);
  const connection = await connectCdpWithin(debuggerUrl);
  try {
    await assertDebuggerListenerOwner(port, authority.pid, authority.environment);
  } catch (error) {
    connection.socket.close();
    throw error;
  }
  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await callCdpWithin(connection, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined) {
      throw new Error("renderer evaluation failed");
    }
    const remote = response.result as { readonly value?: T } | undefined;
    return remote?.value as T;
  };
  return {
    connection,
    evaluate,
    async bodyText(): Promise<string> {
      return evaluate<string>("document.body?.innerText ?? ''");
    },
    async domHtml(): Promise<string> {
      return evaluate<string>("document.documentElement?.outerHTML ?? ''");
    },
    async telegramText(): Promise<string> {
      return evaluate<string>(
        "document.querySelector('section[aria-label=\"Telegram\"]')?.innerText ?? ''",
      );
    },
    async clickButton(label: string, scopeSelector?: string): Promise<void> {
      const clicked = await evaluate<boolean>(`(() => {
        const label = ${JSON.stringify(label)};
        const scopeSelector = ${JSON.stringify(scopeSelector)};
        const scope = scopeSelector === undefined ? document : document.querySelector(scopeSelector);
        if (scope === null) return false;
        const button = [...scope.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.trim() === label && !candidate.disabled
        );
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      assert(clicked, `enabled renderer button was not found: ${label}`);
    },
    async screenshot(path: string): Promise<void> {
      await callCdpWithin(connection, "Page.enable");
      const captured = await callCdpWithin(connection, "Page.captureScreenshot", {
        format: "png",
      });
      assert(typeof captured.data === "string", "renderer screenshot was not captured");
      await writeFile(path, Buffer.from(captured.data, "base64"), { mode: 0o600 });
    },
    closeSocket(): void {
      connection.socket.close();
    },
  };
}

async function waitForButton(
  page: Awaited<ReturnType<typeof cdpPage>>,
  label: string,
): Promise<void> {
  await waitUntil(`renderer button ${label}`, () =>
    page.evaluate<boolean>(`[...document.querySelectorAll("button")].some((candidate) =>
      candidate.textContent?.trim() === ${JSON.stringify(label)} && !candidate.disabled
    )`),
  );
}

async function waitForSettledAppShell(page: Awaited<ReturnType<typeof cdpPage>>): Promise<void> {
  await waitUntil("settled Desktop app shell", async () =>
    page
      .evaluate<boolean>(
        `document.querySelector('[data-shell="app"][data-onboarding="settled"]') !== null`,
      )
      .catch(() => false),
  );
}

async function telegramRendererSnapshot(
  page: Awaited<ReturnType<typeof cdpPage>>,
): Promise<unknown> {
  return page.evaluate(`(async () => {
    const bridgeStatus = await Promise.race([
      window.enduragentAuth.telegramStatus().then(
        (value) => ({ state: "resolved", value }),
        (error) => ({ state: "rejected", error: String(error) }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ state: "timeout" }), 2_500)),
    ]);
    return {
      rpc: document.documentElement.dataset.rpc ?? null,
      telegram: document.querySelector('section[aria-label="Telegram"]')?.innerText ?? "",
      buttons: [...document.querySelectorAll('section[aria-label="Telegram"] button')].map(
        (button) => ({ label: button.textContent?.trim() ?? "", disabled: button.disabled }),
      ),
      bridgeStatus,
    };
  })()`);
}

async function waitForTelegramText(
  page: Awaited<ReturnType<typeof cdpPage>>,
  expected: string,
): Promise<void> {
  try {
    await waitUntil(`Telegram UI text ${expected}`, async () =>
      (await page.telegramText()).includes(expected),
    );
  } catch {
    const visible = (await page.telegramText()).replace(/\s+/gu, " ").slice(0, 600);
    throw new Error(`Telegram UI did not reach expected state: ${visible}`);
  }
}

async function pairingCode(page: Awaited<ReturnType<typeof cdpPage>>): Promise<string> {
  let code = "";
  await waitUntil("Telegram pairing code", async () => {
    code = await page.evaluate<string>(
      "document.querySelector('[aria-label=\"Telegram pairing code\"]')?.textContent?.trim() ?? ''",
    );
    return /^[A-Z0-9]{6}$/u.test(code);
  });
  return code;
}

async function waitForSentMessage(
  messages: readonly SentMessage[],
  text: string,
  start: number,
): Promise<SentMessage> {
  let found: SentMessage | undefined;
  await waitUntil(
    `Bot API reply ${text}`,
    () => {
      found = messages
        .slice(start)
        .find((message) => message.chatId === SENDER_ID && message.text === text);
      return found !== undefined;
    },
    40_000,
  );
  return found as SentMessage;
}

async function launchTrackedApplication(
  environment: NodeJS.ProcessEnv,
  debugPort: number,
  userData: string,
  runningApplications: RunningApplication[],
  debuggerAuthorities: Map<number, DebuggerAuthority>,
): Promise<RunningApplication> {
  const running = launchApplication(environment, debugPort, userData);
  runningApplications.push(running);
  const launch = await running.launch;
  if (launch.state === "spawn-error") {
    throw new Error("packaged Desktop root process did not spawn", { cause: launch.error });
  }
  const existing = debuggerAuthorities.get(debugPort);
  if (existing !== undefined && existing.connection.socket.readyState === WebSocket.OPEN) {
    await assertDebuggerListenerOwner(debugPort, existing.pid, existing.environment);
    running.browserConnection = existing.connection;
    return running;
  }
  debuggerAuthorities.delete(debugPort);
  const connection = await connectBrowserDebugger(debugPort, launch.pid, environment);
  const authority = { pid: launch.pid, connection, environment };
  debuggerAuthorities.set(debugPort, authority);
  running.browserConnection = connection;
  return running;
}

function requireDebuggerAuthority(
  debuggerAuthorities: ReadonlyMap<number, DebuggerAuthority>,
  port: number,
): DebuggerAuthority {
  const authority = debuggerAuthorities.get(port);
  if (authority === undefined || authority.connection.socket.readyState !== WebSocket.OPEN) {
    throw new TypeError("Desktop debugger authority is unavailable");
  }
  return authority;
}

async function cleanApplicationExit(
  running: RunningApplication,
  timeoutMs: number,
): Promise<boolean> {
  const lifecycle = await withAcceptanceDeadline(
    "packaged Desktop clean exit",
    Promise.all([running.launch, running.terminal]),
    { timeoutMs },
  ).catch(() => undefined);
  return lifecycle !== undefined && telegramAcceptanceDirectExitIsClean(...lifecycle);
}

async function packagedProcessTableIsClear(
  operatorHome: string,
  timeoutMs: number,
): Promise<boolean> {
  const [processTable, bundleText] = await Promise.all([
    runCommand("/bin/ps", ["-ww", "-axo", "pid=", "-o", "ucomm="], {
      allowFailure: true,
      timeoutMs,
    }),
    runCommand("/usr/sbin/lsof", ["-n", "-P", "-a", "-d", "txt", "+D", application, "-F0pn"], {
      allowFailure: true,
      environment: { ...process.env, HOME: operatorHome },
      timeoutMs,
    }),
  ]);
  return (
    telegramAcceptanceProcessTableIsClear(processTable) &&
    telegramAcceptanceBundleTextIsClear(bundleText, application)
  );
}

async function waitForStablePackagedProcessExit(
  operatorHome: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveClear = 0;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    if (await packagedProcessTableIsClear(operatorHome, Math.min(2_000, remaining))) {
      consecutiveClear += 1;
      if (consecutiveClear === 3) return true;
    } else {
      consecutiveClear = 0;
    }
    await delay(100);
  }
  return false;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

async function gracefulQuit(
  running: RunningApplication,
  page: Awaited<ReturnType<typeof cdpPage>>,
  debugPort: number,
): Promise<void> {
  await running.requestQuit();
  assert(await cleanApplicationExit(running, 30_000), "packaged Desktop quit was not clean");
  await waitUntil("Desktop debugging listener exit", async () => !(await portOpen(debugPort)));
  page.closeSocket();
  running.browserConnection?.socket.close();
}

async function treeContains(root: string, value: string): Promise<boolean> {
  const marker = Buffer.from(value);
  for (const entry of await readdir(root, { recursive: true })) {
    try {
      if ((await readFile(join(root, entry))).includes(marker)) return true;
    } catch {}
  }
  return false;
}

function modelCredentialFreeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ACCESS_TOKEN",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "DEEPSEEK_API_KEY",
    "QWEN_API_KEY",
    "MINIMAX_API_KEY",
    "KIMI_API_KEY",
    "ZAI_API_KEY",
    "ENDURAGENT_LLM_API_KEY",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function assertOutputSecretFree(
  runningApplications: readonly RunningApplication[],
  token: string,
): Promise<void> {
  const output = runningApplications
    .flatMap((running) => Object.values(running.output()))
    .join("\n");
  assert(!output.includes(token), "Telegram credential reached packaged process output");
}

async function main(): Promise<void> {
  assert(process.platform === "darwin", "packaged Telegram acceptance requires macOS");
  assert(process.arch === "arm64", "packaged Telegram acceptance requires macOS arm64");
  assert(
    process.env.CI === "true" || process.env.ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT === "1",
    "packaged Telegram acceptance requires an explicit disposable safe-storage context",
  );
  assert(existsSync(executable), "packaged Telegram acceptance executable is missing");
  reportPhase("setup");
  const packageManifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  assert(typeof packageManifest.version === "string", "Desktop package version is invalid");

  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "eat-"));
  const athleteHome = join(scratch, "athlete-home");
  const configDirectory = join(athleteHome, "config");
  const operatorHome = join(scratch, "operator-home");
  const operatorPreferences = join(operatorHome, "Library/Preferences");
  const operatorKeychains = join(operatorHome, "Library/Keychains");
  const userData = join(scratch, "user-data");
  const screenshots = join(scratch, "screenshots");
  const results = join(scratch, "results");
  const keychainPath = join(operatorKeychains, "acceptance.keychain-db");
  const token = `123456789:${randomBytes(32).toString("base64url").slice(0, 35)}`;
  const originalClipboard = await clipboardBytes();
  const runningApplications: RunningApplication[] = [];
  const debuggerAuthorities = new Map<number, DebuggerAuthority>();
  let keychain: DisposableKeychain | undefined;
  let telegram: Awaited<ReturnType<typeof createTelegramBotApi>> | undefined;
  let primary: RunningApplication | undefined;
  let page: Awaited<ReturnType<typeof cdpPage>> | undefined;
  let executionError: unknown;
  let cleanupError: AggregateError | undefined;
  let successResult:
    | {
        readonly ok: true;
        readonly packagedVersion: string;
        readonly productionChain: true;
        readonly botApiOnlyFake: true;
        readonly coldStartBackground: true;
        readonly residentLifecycle: true;
        readonly persistedDisable: true;
        readonly removal: true;
      }
    | undefined;
  try {
    await Promise.all([
      mkdir(configDirectory, { recursive: true, mode: 0o700 }),
      mkdir(operatorPreferences, { recursive: true, mode: 0o700 }),
      mkdir(operatorKeychains, { recursive: true, mode: 0o700 }),
      mkdir(userData, { recursive: true, mode: 0o700 }),
      mkdir(screenshots, { recursive: true, mode: 0o700 }),
      mkdir(results, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(configDirectory, "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(athleteHome)}`,
        "llm:",
        "  provider: codex-agent",
        "  model: gpt-5.6-sol",
        "  codex_agent:",
        "    enabled: true",
        "    binary_path: /usr/bin/false",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: '0'",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await preparePackagedTelegramSetupFixture(athleteHome);
    const authProfilesPath = join(configDirectory, "auth-profiles.json");
    assert(!existsSync(authProfilesPath), "model auth profile unexpectedly exists");

    telegram = await createTelegramBotApi(token);
    reportPhase("keychain");
    keychain = await prepareDisposableKeychain({
      home: operatorHome,
      path: keychainPath,
      password: randomBytes(32).toString("base64url"),
      environment: process.env,
      run: (args, options) =>
        runCommand("/usr/bin/security", args, {
          allowFailure: true,
          environment: options.environment,
        }),
    });
    await keychain.activate();
    reportPhase("keychain-ready");
    assert(keychain.home === operatorHome, "keychain and application HOME differ");
    let debugPort = await reservePort();
    const environment = modelCredentialFreeEnvironment({
      ...process.env,
      HOME: operatorHome,
      ENDURAGENT_HOME: athleteHome,
      ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "file",
      ENDURAGENT_ACCEPTANCE_TELEGRAM_BOT_API_ORIGIN: telegram.origin,
      ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    });

    reportPhase("initial-launch");
    primary = await launchTrackedApplication(
      environment,
      debugPort,
      userData,
      runningApplications,
      debuggerAuthorities,
    );
    try {
      page = await cdpPage(debugPort, requireDebuggerAuthority(debuggerAuthorities, debugPort));
    } catch (error) {
      const processOutput = boundedDiagnostic(
        runningApplicationDiagnostic(primary, [token]),
        2_000,
      );
      throw new Error(
        `${error instanceof Error ? error.message : "Desktop renderer did not start"}; process=${processOutput}`,
        { cause: error },
      );
    }
    await waitForSettledAppShell(page);
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    await waitUntil("Settings after onboarding startup settled", async () =>
      page
        .evaluate<boolean>(
          `document.querySelector('[data-view="settings"][data-onboarding="settled"]') !== null`,
        )
        .catch(() => false),
    );
    try {
      await waitForButton(page, "Paste token from clipboard");
    } catch (error) {
      const renderer = telegramAcceptanceJsonDiagnostic(
        await telegramRendererSnapshot(page),
        [token],
        2_000,
      );
      const processOutput = boundedDiagnostic(
        runningApplicationDiagnostic(primary, [token]),
        1_000,
      );
      throw new Error(
        `${error instanceof Error ? error.message : "Telegram settings did not load"}; renderer=${renderer}; profile=${existsSync(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_PROFILE_FILE))}; desired-state=${existsSync(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_DESIRED_STATE_FILE))}; Bot API methods=${telegram.methods().join(",") || "none"}; process=${processOutput}`,
      );
    }

    reportPhase("token-configure");
    await writeClipboard(token);
    await page.clickButton("Paste token from clipboard");
    try {
      await waitForTelegramText(page, `@${BOT_USERNAME}`);
    } catch (error) {
      const processOutput = boundedDiagnostic(
        runningApplicationDiagnostic(primary, [token]),
        1_000,
      );
      throw new Error(
        `${error instanceof Error ? error.message : "Telegram setup failed"}; Bot API methods=${telegram.methods().join(",") || "none"}; content-types=${telegram.contentTypes().join(",") || "none"}; process=${processOutput}`,
      );
    }
    reportPhase("token-configured");
    assert((await clipboardBytes()).length === 0, "Telegram credential remained on the clipboard");
    const profilePath = join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_PROFILE_FILE);
    await waitUntil("encrypted Telegram profile", () => existsSync(profilePath));
    assert(
      !(await readFile(profilePath)).includes(Buffer.from(token)),
      "Telegram profile is plaintext",
    );
    assert(!(await page.bodyText()).includes(token), "Telegram credential reached renderer text");
    await assertOutputSecretFree(runningApplications, token);

    await page.clickButton("Start pairing and turn on");
    const code = await pairingCode(page);
    telegram.enqueue(code);
    await waitForTelegramText(page, "Paired with a primary Telegram user");
    await waitForTelegramText(page, "Online");
    reportPhase("paired");
    await page.evaluate(`(() => {
      const summary = [...document.querySelectorAll("summary")].find((candidate) =>
        candidate.textContent?.trim() === "Advanced · allowed users"
      );
      if (!(summary instanceof HTMLElement)) return false;
      summary.click();
      return true;
    })()`);
    await waitForTelegramText(page, String(SENDER_ID));
    await page.screenshot(join(screenshots, "paired.png"));

    let messageStart = telegram.sentMessages.length;
    telegram.enqueue("/version");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );

    messageStart = telegram.sentMessages.length;
    const freeTextMessageStart = messageStart;
    const chatActionStart = telegram.chatActions.length;
    const freeTextUpdate = telegram.enqueue("How should I train today?");
    let freeTextInitialSelectionSequence: number | undefined;
    await waitForSentMessage(telegram.sentMessages, GENERIC_FAILURE, messageStart);
    await waitUntil("free-text Telegram update transport progression", () => {
      const requests = telegram?.getUpdatesRequests() ?? [];
      const selections = requests.filter((request) =>
        request.selectedUpdateIds.includes(freeTextUpdate.update_id),
      );
      const selection = selections[0];
      const latest = requests.at(-1);
      const progressed =
        selections.length === 1 &&
        selection !== undefined &&
        latest !== undefined &&
        latest.sequence > selection.sequence &&
        latest.offset > freeTextUpdate.update_id &&
        latest.state === "pending" &&
        telegram?.activePollCount() === 1;
      if (progressed) freeTextInitialSelectionSequence = selection.sequence;
      return progressed;
    });

    const pairedDesired = JSON.parse(
      await readFile(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_DESIRED_STATE_FILE), "utf8"),
    ) as { readonly enabled?: unknown };
    assert(pairedDesired.enabled === true, "paired Telegram intent was not enabled before restart");
    const pairedAllowed = JSON.parse(
      await readFile(join(athleteHome, "allowed-senders.json"), "utf8"),
    ) as { readonly primaryOperator?: unknown; readonly allowFrom?: unknown };
    assert(
      pairedAllowed.primaryOperator === String(SENDER_ID) &&
        Array.isArray(pairedAllowed.allowFrom) &&
        pairedAllowed.allowFrom.includes(String(SENDER_ID)),
      "paired Telegram access state was not durable before restart",
    );
    await seedBackgroundAtLoginPreference(userData);
    reportPhase("initial-quit");
    await gracefulQuit(primary, page, debugPort);
    const freeTextActions = telegram.chatActions.slice(chatActionStart);
    assert(
      freeTextActions.length > 0 &&
        freeTextActions.every(
          (action) => action.action === "typing" && Number(action.chat_id) === SENDER_ID,
        ),
      "free-text Telegram handling produced an invalid typing-action sequence",
    );
    const freeTextReplies = telegram.sentMessages.slice(freeTextMessageStart);
    assert(
      freeTextReplies.every((message) => message.chatId === SENDER_ID),
      `credential-free acceptance replied to the wrong Telegram chat: ${telegramAcceptanceJsonDiagnostic(
        freeTextReplies,
        [token],
        600,
      )}`,
    );
    const freeTextReplyTexts = freeTextReplies.map((message) => message.text);
    assert(
      JSON.stringify(freeTextReplyTexts) === JSON.stringify([GENERIC_FAILURE]) ||
        JSON.stringify(freeTextReplyTexts) ===
          JSON.stringify([EXPECTED_WELCOME_MESSAGE, GENERIC_FAILURE]),
      `credential-free acceptance produced an invalid response set after daemon drain: ${telegramAcceptanceJsonDiagnostic(
        freeTextReplyTexts,
        [token],
        600,
      )}`,
    );
    primary = undefined;
    page = undefined;

    reportPhase("background-relaunch");
    debugPort = await reservePort();
    const backgroundEnvironment = {
      ...environment,
      [ACCEPTANCE_OS_LOGIN_MARKER_ENV]: ACCEPTANCE_OS_LOGIN_MARKER_VALUE,
    };
    primary = await launchTrackedApplication(
      backgroundEnvironment,
      debugPort,
      userData,
      runningApplications,
      debuggerAuthorities,
    );
    const backgroundDebuggerAuthority = requireDebuggerAuthority(debuggerAuthorities, debugPort);
    await waitUntil("cold-start Telegram long poll", () => telegram?.activePollCount() === 1);
    await waitUntil("cold-start debugger listener", () => portOpen(debugPort));
    assert(
      (await mainRendererTargets(debugPort, backgroundDebuggerAuthority)).length === 0,
      "OS-login cold start created a main renderer",
    );
    messageStart = telegram.sentMessages.length;
    telegram.enqueue("/version");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );
    reportPhase("background-ready");
    assert(
      freeTextInitialSelectionSequence !== undefined,
      "initial free-text Telegram selection was not observed",
    );
    const initialFreeTextSelectionSequence = freeTextInitialSelectionSequence;
    assert(
      telegram
        .getUpdatesRequests()
        .some(
          (request) =>
            request.sequence > initialFreeTextSelectionSequence &&
            request.state === "settled" &&
            request.selectedUpdateIds.includes(freeTextUpdate.update_id),
        ),
      "cold-start Telegram polling did not replay the persisted free-text update",
    );
    assert(
      (await mainRendererTargets(debugPort, backgroundDebuggerAuthority)).length === 0,
      "background Telegram handling created a main renderer",
    );

    reportPhase("resident-lifecycle");
    const foregroundRequest = await launchTrackedApplication(
      environment,
      debugPort,
      userData,
      runningApplications,
      debuggerAuthorities,
    );
    assert(
      await cleanApplicationExit(foregroundRequest, 20_000),
      "foreground second launch exit was not clean",
    );
    await waitUntil(
      "one foreground main renderer",
      async () => (await mainRendererTargets(debugPort, backgroundDebuggerAuthority)).length === 1,
    );
    await delay(250);
    assert(
      (await mainRendererTargets(debugPort, backgroundDebuggerAuthority)).length === 1,
      "second launch did not open exactly one main renderer",
    );
    page = await cdpPage(debugPort, requireDebuggerAuthority(debuggerAuthorities, debugPort));

    reportPhase("window-close");
    await page.evaluate("window.close(); true").catch(() => undefined);
    page.closeSocket();
    await waitUntil(
      "resident window closure",
      async () => {
        if ((await mainRendererTargets(debugPort, backgroundDebuggerAuthority)).length !== 0) {
          return false;
        }
        if (primary === undefined) return false;
        const launch = await primary.launch;
        return (
          launch.state === "spawned" &&
          primary.child.exitCode === null &&
          primary.child.signalCode === null
        );
      },
      25_000,
    );
    messageStart = telegram.sentMessages.length;
    telegram.enqueue("/version");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );

    reportPhase("secondary-launch");
    const secondary = await launchTrackedApplication(
      environment,
      debugPort,
      userData,
      runningApplications,
      debuggerAuthorities,
    );
    await delay(250);
    assert(
      await cleanApplicationExit(secondary, 20_000),
      "secondary Desktop instance exit was not clean",
    );
    page = await cdpPage(debugPort, requireDebuggerAuthority(debuggerAuthorities, debugPort));
    await waitForSettledAppShell(page);
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    await waitForButton(page, "Turn off");
    await waitUntil("active Telegram long poll", () => telegram?.activePollCount() === 1);
    reportPhase("disable");
    const cancelledPollCount = telegram.cancelledPollCount();
    await page.clickButton("Turn off");
    await waitForButton(page, "Turn on");
    await waitUntil("Telegram polling stop", () => telegram?.activePollCount() === 0);
    reportPhase("disabled");
    assert(
      telegram.cancelledPollCount() > cancelledPollCount,
      "turning Telegram off did not cancel the active long poll",
    );
    const disabledPollCount = telegram.pollCount();
    messageStart = telegram.sentMessages.length;
    const pendingUpdate = telegram.enqueue("/version");
    await delay(1_000);
    assert(telegram.sentMessages.length === messageStart, "disabled Telegram replied to an update");
    assert(telegram.pollCount() === disabledPollCount, "disabled Telegram continued polling");

    reportPhase("disabled-quit");
    await gracefulQuit(primary, page, debugPort);
    primary = undefined;
    page = undefined;

    reportPhase("disabled-relaunch");
    const relaunchPort = await reservePort();
    primary = await launchTrackedApplication(
      environment,
      relaunchPort,
      userData,
      runningApplications,
      debuggerAuthorities,
    );
    page = await cdpPage(relaunchPort, requireDebuggerAuthority(debuggerAuthorities, relaunchPort));
    await waitForSettledAppShell(page);
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    await waitForButton(page, "Turn on");
    const relaunchedDisabledPollCount = telegram.pollCount();
    await delay(1_000);
    assert(
      telegram.pollCount() === relaunchedDisabledPollCount,
      "Telegram did not remain disabled after relaunch",
    );
    await page.clickButton("Turn on");
    await waitForButton(page, "Turn off");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );
    await waitUntil("pending Telegram update acknowledgement progression", () => {
      const requests = telegram?.getUpdatesRequests() ?? [];
      const selections = requests.filter((request) =>
        request.selectedUpdateIds.includes(pendingUpdate.update_id),
      );
      const selection = selections[0];
      const latest = requests.at(-1);
      return (
        selections.length === 1 &&
        selection !== undefined &&
        latest !== undefined &&
        latest.sequence > selection.sequence &&
        latest.offset > pendingUpdate.update_id &&
        latest.state === "pending" &&
        telegram?.activePollCount() === 1
      );
    });
    assert(
      telegram.sentMessages
        .slice(messageStart)
        .filter((message) => message.text === `Cycling Coach Desktop v${packageManifest.version}`)
        .length === 1,
      "pending Telegram update was not delivered exactly once",
    );
    const resumedRequests = telegram.getUpdatesRequests();
    const latestResumedRequest = resumedRequests.at(-1);
    assert(
      resumedRequests.filter((request) =>
        request.selectedUpdateIds.includes(pendingUpdate.update_id),
      ).length === 1 &&
        latestResumedRequest !== undefined &&
        latestResumedRequest.offset > pendingUpdate.update_id &&
        latestResumedRequest.state === "pending",
      "pending Telegram update offset did not advance exactly once",
    );

    reportPhase("removal");
    await page.clickButton("Delete", 'section[aria-label="Telegram"]');
    await waitUntil("Telegram delete confirmation", () =>
      page.evaluate<boolean>(
        `document.querySelector('[data-inline-confirmation="delete-telegram"]') !== null`,
      ),
    );
    await page.clickButton("Delete connection", '[data-inline-confirmation="delete-telegram"]');
    await waitForButton(page, "Paste token from clipboard");
    await waitUntil("Telegram polling stop after removal", () => telegram?.activePollCount() === 0);
    assert(!existsSync(profilePath), "Telegram profile remained after removal");
    const acceptanceKeyPath = join(userData, ".enduragent-acceptance-key");
    assert(!existsSync(acceptanceKeyPath), "acceptance encryption key remained after removal");
    const desired = JSON.parse(
      await readFile(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_DESIRED_STATE_FILE), "utf8"),
    ) as { readonly enabled?: unknown };
    assert(desired.enabled === false, "Telegram desired state remained enabled after removal");
    const allowedPath = join(athleteHome, "allowed-senders.json");
    assert(existsSync(allowedPath), "allowed-senders.json is missing after removal");
    const allowedSource = await readFile(allowedPath, "utf8");
    const allowed = JSON.parse(allowedSource) as {
      readonly dmPolicy?: unknown;
      readonly allowFrom?: unknown;
      readonly primaryOperator?: unknown;
    };
    assert(allowed.dmPolicy === "pairing", "Telegram DM policy did not reset to pairing");
    assert(
      Array.isArray(allowed.allowFrom) && allowed.allowFrom.length === 0,
      "allowed users remained after removal",
    );
    assert(allowed.primaryOperator === null, "primary Telegram user remained after removal");
    assert(
      !allowedSource.includes(String(SENDER_ID)),
      "primary Telegram sender ID remained on disk",
    );
    assert(!existsSync(authProfilesPath), "model auth profile unexpectedly appeared");
    assert(
      !(await treeContains(userData, token)),
      "Telegram credential remained in Desktop user data",
    );
    assert(
      !(await treeContains(athleteHome, token)),
      "Telegram credential remained in the athlete home",
    );
    assert(!(await page.domHtml()).includes(token), "Telegram credential reached renderer DOM");
    await page.screenshot(join(screenshots, "removed.png"));
    await assertOutputSecretFree(runningApplications, token);
    const postFreeTextMessages = telegram.sentMessages.slice(freeTextMessageStart);
    const versionReply = `Cycling Coach Desktop v${packageManifest.version}`;
    assert(
      postFreeTextMessages.every((message) => message.chatId === SENDER_ID),
      "packaged Telegram acceptance sent a response to the wrong chat",
    );
    assert(
      JSON.stringify(postFreeTextMessages.map((message) => message.text)) ===
        JSON.stringify([...freeTextReplyTexts, versionReply, versionReply, versionReply]),
      "packaged Telegram acceptance produced a late, duplicate, or replayed response",
    );
    await writeFile(
      join(results, "summary.json"),
      `${JSON.stringify({
        ok: true,
        packagedVersion: packageManifest.version,
        paired: true,
        residentReply: true,
        coldStartBackground: true,
        remainedDisabled: true,
        pendingDeliveredOnce: true,
        removed: true,
      })}\n`,
      { mode: 0o600 },
    );
    reportPhase("final-quit");
    await gracefulQuit(primary, page, relaunchPort);
    primary = undefined;
    page = undefined;
    reportPhase("post-removal-relaunch");
    const postRemovalPort = await reservePort();
    primary = await launchTrackedApplication(
      environment,
      postRemovalPort,
      userData,
      runningApplications,
      debuggerAuthorities,
    );
    page = await cdpPage(
      postRemovalPort,
      requireDebuggerAuthority(debuggerAuthorities, postRemovalPort),
    );
    await waitForSettledAppShell(page);
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    await waitForButton(page, "Paste token from clipboard");
    assert(!existsSync(profilePath), "Telegram profile returned after removal relaunch");
    assert(
      !existsSync(acceptanceKeyPath),
      "acceptance encryption key returned after removal relaunch",
    );
    assert(!(await page.domHtml()).includes(token), "Telegram credential returned after relaunch");
    reportPhase("post-removal-ready");
    reportPhase("post-removal-quit");
    await gracefulQuit(primary, page, postRemovalPort);
    primary = undefined;
    page = undefined;
    successResult = {
      ok: true,
      packagedVersion: packageManifest.version,
      productionChain: true,
      botApiOnlyFake: true,
      coldStartBackground: true,
      residentLifecycle: true,
      persistedDisable: true,
      removal: true,
    };
  } catch (error) {
    executionError = errorWithRunningApplicationDiagnostics(error, runningApplications, [token]);
  } finally {
    reportPhase("cleanup");
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    await Promise.all(runningApplications.map((running) => running.requestQuit()));
    const directExits = await Promise.all(
      runningApplications.map((running) => cleanApplicationExit(running, 10_000)),
    );
    const directApplicationsExitedCleanly = directExits.every(Boolean);
    if (!directApplicationsExitedCleanly) {
      cleanupErrors.push(
        new Error(
          `a directly launched packaged Desktop process did not exit cleanly; ${runningApplicationDiagnostics(
            runningApplications,
            [token],
          )}`,
        ),
      );
    }
    const terminatedApplications = await Promise.all(
      runningApplications.map((running, index) =>
        directExits[index] ? Promise.resolve(true) : terminateAcceptanceChild(running.child),
      ),
    );
    if (!terminatedApplications.every(Boolean)) {
      cleanupErrors.push(new Error("a packaged Desktop process could not be terminated"));
    }
    await attempt(() => page?.closeSocket());
    for (const running of runningApplications) {
      await attempt(() => running.browserConnection?.socket.close());
    }
    let processTableClear = false;
    reportPhase("cleanup-processes");
    try {
      processTableClear = await waitForStablePackagedProcessExit(operatorHome, 5_000);
      if (!processTableClear) {
        cleanupErrors.push(
          new Error(
            `a packaged Desktop executable remained in the process table; ${runningApplicationDiagnostics(
              runningApplications,
              [token],
            )}`,
          ),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    const processTeardownSafe = telegramAcceptanceShutdownIsProven({
      executionSucceeded: executionError === undefined && successResult !== undefined,
      directApplicationsExitedCleanly,
      processTableClear,
    });
    let debuggerListenersClosed = true;
    for (const debugPort of new Set(runningApplications.map((running) => running.debugPort))) {
      try {
        await waitUntil(
          `Desktop debugging listener ${debugPort} to close`,
          async () => !(await portOpen(debugPort)),
          5_000,
        );
      } catch (error) {
        debuggerListenersClosed = false;
        cleanupErrors.push(error);
      }
    }
    await attempt(async () => {
      const botApi = telegram;
      if (botApi === undefined) return;
      await botApi.close();
      await waitUntil(
        "Bot API listener to close",
        async () => !(await portOpen(botApi.listenerPort)),
        5_000,
      );
    });
    await attempt(() => writeClipboard(originalClipboard));

    reportPhase("cleanup-storage");
    try {
      await releaseAcceptanceStorage({
        processesStopped: processTeardownSafe,
        debuggerListenersClosed,
        recoveryPath: keychain?.recoveryPath ?? keychainPath,
        restoreKeychain: async () => {
          if (keychain === undefined) return true;
          await keychain.restore();
          return keychain.restored();
        },
        removeScratch: () => rm(scratch, { recursive: true, force: true }),
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      cleanupError = new AggregateError(
        executionError === undefined ? cleanupErrors : [executionError, ...cleanupErrors],
        `packaged Telegram acceptance cleanup failed; ${runningApplicationDiagnostics(
          runningApplications,
          [token],
        )}`,
      );
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (executionError !== undefined) throw executionError;
  assert(successResult !== undefined, "packaged Telegram acceptance produced no result");
  reportPhase("complete");
  process.stdout.write(`${JSON.stringify(successResult)}\n`);
}

await main();
