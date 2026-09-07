import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCoachClient } from "../../../packages/coach-client/dist/index.js";
import { createClientHandshakeFrame } from "../../../packages/coach-contract/dist/index.js";
import {
  cleanupSecuritySmokeEnvironment,
  createElectronLaunchArguments,
  createSecuritySmokeEnvironment,
  createSecuritySmokeLaunchEnvironment,
} from "../smoke/security-smoke-environment.mjs";
import { createDevelopmentPackagePlan } from "./development-package-plan.mjs";
import { createWindowsDevelopmentPackagePlan } from "./windows-development-package-plan.mjs";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const developmentPackagePlan =
  process.platform === "win32"
    ? createWindowsDevelopmentPackagePlan({ desktopRoot })
    : createDevelopmentPackagePlan({ desktopRoot });
const command = process.argv[2];
const options = Object.fromEntries(
  process.argv
    .slice(3)
    .filter((value) => value.startsWith("--") && value.includes("="))
    .map((value) => {
      const separator = value.indexOf("=");
      return [value.slice(2, separator), value.slice(separator + 1)];
    }),
);
const mode = options.mode ?? "development";

function packagedExecutable() {
  return developmentPackagePlan.executablePath;
}

async function startElectron(flag, env, extraArgs = []) {
  const executable = mode === "packaged" ? packagedExecutable() : require("electron");
  const args = createElectronLaunchArguments(mode, desktopRoot, flag, extraArgs);
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const lines = [];
  const waiters = [];
  let pendingLine = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    pendingLine += text;
    const parts = pendingLine.split(/\r?\n/u);
    pendingLine = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (const waiter of waiters.slice()) waiter();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const waitForLine = (prefix) =>
    new Promise((resolveLine, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`timed out waiting for ${prefix}`)),
        30_000,
      );
      const inspect = () => {
        const line = lines.find((candidate) => candidate.startsWith(`${prefix} `));
        if (line === undefined) return;
        clearTimeout(deadline);
        const index = waiters.indexOf(inspect);
        if (index >= 0) waiters.splice(index, 1);
        resolveLine(JSON.parse(line.slice(prefix.length + 1)));
      };
      waiters.push(inspect);
      inspect();
    });
  return {
    child,
    args,
    env,
    exited,
    waitForLine,
    output: () => ({ stdout, stderr }),
  };
}

async function launch(flag, env, extraArgs = []) {
  const running = await startElectron(flag, env, extraArgs);
  const result = await running.exited;
  const { stdout, stderr } = running.output();
  if (result.code !== 0 || result.signal !== null)
    throw new Error(`Electron smoke failed: ${result.code}/${result.signal}\n${stderr}`);
  return { stdout, stderr };
}

function summaryLine(stdout, prefix) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const matches = lines.filter((line) => line.startsWith(`${prefix} `));
  if (matches.length !== 1) throw new Error(`expected one ${prefix} line`);
  return JSON.parse(matches[0].slice(prefix.length + 1));
}

async function runtime() {
  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const userDataDirectory = await mkdtemp(join(base, "ear-"));
  try {
    const result = await launch(
      "--desktop-runtime-smoke",
      {
        ...process.env,
        FORCE_COLOR: undefined,
        CLICOLOR_FORCE: undefined,
        ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
      },
      [`--user-data-dir=${userDataDirectory}`],
    );
    const summary = summaryLine(result.stdout, "DESKTOP_RUNTIME_SMOKE");
    if (
      summary.electron !== "43.1.1" ||
      summary.node !== "24.18.0" ||
      summary.result !== "tempo threshold" ||
      existsSync(summary.directory)
    ) {
      throw new Error("desktop runtime assertions failed");
    }
    process.stdout.write(`DESKTOP_RUNTIME_SMOKE ${JSON.stringify(summary)}\n`);
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function spoofOriginResponse(url) {
  const target = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    let response = "";
    socket.setEncoding("ascii");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("close", () => resolveResponse(response));
    socket.once("connect", () => {
      socket.end(
        [
          "GET /rpc HTTP/1.1",
          `Host: 127.0.0.1:${target.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: c3ludGhldGljLXNtb2tl",
          "Sec-WebSocket-Version: 13",
          "Origin: https://spoof.invalid",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

async function wrongTokenCloseCode(url) {
  return new Promise((resolveCode, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("wrong-token socket did not close"));
    }, 5_000);
    socket.addEventListener(
      "open",
      () => {
        socket.send(JSON.stringify(createClientHandshakeFrame("w".repeat(43))));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolveCode(event.code);
      },
      { once: true },
    );
  });
}

async function operationalObserverOrder(url, token) {
  const client = await connectCoachClient({ url, token });
  const order = [];
  try {
    await client.call(
      "sync",
      {},
      {
        onNotificationEnvelope: (envelope) => order.push(`envelope:${envelope.params.event.phase}`),
        onEvent: (event) => order.push(`event:${event.phase}`),
        onTerminalEnvelope: () => order.push("terminal"),
      },
    );
  } finally {
    await client.close();
  }
  return order;
}

async function security() {
  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "eas-"));
  const environment = createSecuritySmokeEnvironment(scratch, options.output);
  let running;
  try {
    await Promise.all([
      mkdir(environment.configDirectory, { recursive: true, mode: 0o700 }),
      mkdir(environment.operatorHome, { recursive: true, mode: 0o700 }),
      mkdir(environment.electronUserData, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(environment.configDirectory, "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(environment.athleteHome)}`,
        "llm:",
        "  provider: anthropic",
        "  model: synthetic",
        "  api_key: synthetic",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: synthetic",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
    );
    if (environment.outputDirectory !== undefined)
      await mkdir(environment.outputDirectory, { recursive: true });
    const launchEnvironment = {
      ...createSecuritySmokeLaunchEnvironment(process.env, environment, process.platform),
      ...(mode === "packaged" ? { ELECTRON_RENDERER_URL: ":///synthetic-malformed-renderer" } : {}),
      ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
    };
    running = await startElectron(
      "--desktop-security-smoke",
      launchEnvironment,
      environment.extraArguments,
    );
    const ready = await running.waitForLine("DESKTOP_SECURITY_READY");
    const token = (
      await readFile(join(environment.configDirectory, "daemon.token"), "utf8")
    ).trim();
    const [spoofed, wrongCode, observerOrder] = await Promise.all([
      spoofOriginResponse(ready.rpcUrl),
      wrongTokenCloseCode(ready.rpcUrl),
      operationalObserverOrder(ready.rpcUrl, token),
    ]);
    running.child.stdin.end("shutdown\n");
    const exit = await running.exited;
    const result = running.output();
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Electron smoke failed: ${exit.code}/${exit.signal}\n${result.stderr}`);
    }
    const expectedForbidden =
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    const expectedOrder = [
      "envelope:started",
      "event:started",
      "envelope:completed",
      "event:completed",
      "terminal",
    ];
    const summary = {
      passes: {
        rendererIsolation: ready.noNodeGlobals === true,
        originAuth:
          ready.url === "enduragent://app/index.html" &&
          ready.rendererNavigationValid === true &&
          ready.rpcConnected === true,
        spoofOrigin: spoofed === expectedForbidden,
        wrongToken: wrongCode === 1008,
        observerOrder: JSON.stringify(observerOrder) === JSON.stringify(expectedOrder),
        preloadBridge:
          JSON.stringify(ready.bridgeKeys) ===
          JSON.stringify([
            "acknowledgeTelegramGapWarning",
            "addTelegramAllowedSender",
            "applyLlmSelection",
            "beginTelegramPairing",
            "cancelChatgptLogin",
            "cancelTelegramPairing",
            "chatgptLogin",
            "chatgptStatus",
            "checkForUpdates",
            "chooseChatAttachments",
            "chooseImportFiles",
            "choosePlanRaceCourseFile",
            "claudeCliRecheck",
            "claudeCliStatus",
            "credentialRecoveryStatus",
            "credentialStatuses",
            "deleteArchivedConversation",
            "deleteCredential",
            "disableTelegram",
            "enableTelegram",
            "executePlanTransition",
            "exportTrainingFile",
            "getArchivedTranscriptPage",
            "getDaemonConnection",
            "getPlanState",
            "getPlanningReadModel",
            "getTranscriptPage",
            "getUpdateState",
            "initialSetupStatusSettled",
            "listArchivedConversations",
            "listTelegramAllowedSenders",
            "llmConfiguration",
            "onChatgptLoginProgress",
            "onDroppedChatAttachments",
            "onDroppedImportFiles",
            "onOpenSettings",
            "onPlanProgress",
            "onUpdateState",
            "pasteChatAttachment",
            "pasteIntervalsApiKeyFromClipboard",
            "pasteTelegramTokenFromClipboard",
            "platform",
            "reconcileTelegram",
            "removeTelegram",
            "removeTelegramAllowedSender",
            "removeTelegramWebhook",
            "resetAllCredentials",
            "restartToUpdate",
            "retryCredentialRecovery",
            "retryFailedCredentials",
            "setAppearance",
            "telegramStatus",
            "writeCredential",
          ]),
        credentialMetadata: ready.credentialStatusesMetadataOnly === true,
      },
      url: ready.url,
      blockedOffPort: ready.blockedOffPort,
      rendererSurface: ready.rendererSurface,
      tokenAbsent:
        ready.tokenAbsentInRendererSurfaces === true &&
        !JSON.stringify(running.args).includes(token) &&
        !JSON.stringify(running.env).includes(token) &&
        !result.stdout.includes(token) &&
        !result.stderr.includes(token) &&
        !JSON.stringify(ready.credentialStatuses).includes(token) &&
        !environment.screenshotPath.includes(token),
    };
    if (
      Object.values(summary.passes).some((value) => value !== true) ||
      summary.blockedOffPort !== true ||
      summary.rendererSurface !== "setup-gate" ||
      summary.tokenAbsent !== true ||
      !existsSync(environment.screenshotPath)
    ) {
      throw new Error(`desktop security assertions failed: ${JSON.stringify(summary)}`);
    }
    if (environment.outputDirectory !== undefined)
      await writeFile(
        join(environment.outputDirectory, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
    process.stdout.write(`DESKTOP_SECURITY_SMOKE ${JSON.stringify(summary)}\n`);
  } finally {
    if (running !== undefined) {
      if (!running.child.stdin.destroyed) running.child.stdin.end("shutdown\n");
      const settled = await Promise.race([
        running.exited.then(() => true),
        new Promise((resolveSettled) => setTimeout(() => resolveSettled(false), 5_000)),
      ]);
      if (!settled) running.child.kill();
    }
    await cleanupSecuritySmokeEnvironment(environment);
  }
}

if (command === "runtime") await runtime();
else if (command === "security") await security();
else throw new Error("unknown Electron smoke command");
