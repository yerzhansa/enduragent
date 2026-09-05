import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { extractFile } from "@electron/asar";
import { CoachRpcRemoteError, connectCoachClient } from "@enduragent/coach-client";
import type { TurnEvent } from "@enduragent/coach-contract";
import { connectCdp, reservePort, waitForPage } from "./support/desktop-cdp.js";
import {
  runAcceptanceCommand,
  withAcceptanceDeadline,
} from "./support/packaged-telegram/acceptance-deadline.js";
import {
  verifyTelegramAcceptanceMainEntry,
  verifyTelegramAcceptanceManifest,
} from "./support/packaged-telegram/package-acceptance.mjs";
import { TELEGRAM_ACCEPTANCE_QUIT_FRAME } from "./support/packaged-telegram/process-safety.js";
import { preparePackagedTelegramSetupFixture } from "./support/packaged-telegram/setup-fixture.js";
import {
  startOAuthProviderFixture,
  syntheticOAuthCredential,
} from "./support/packaged-telegram/oauth-provider-fixture.js";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This acceptance launcher requires macOS arm64");
const desktopRoot = resolve(import.meta.dirname, "..");
const application = join(
  desktopRoot,
  "dist/telegram-acceptance-package/mac-arm64/Enduragent Telegram Acceptance.app",
);
const executable = join(application, "Contents/MacOS/Enduragent Telegram Acceptance");
const archive = join(application, "Contents/Resources/app.asar");
const sourceManifest = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const manifest = JSON.parse(extractFile(archive, "package.json").toString());
verifyTelegramAcceptanceManifest(manifest, sourceManifest.version);
verifyTelegramAcceptanceMainEntry(extractFile(archive, "out/main/index.js").toString(), (path) =>
  extractFile(archive, path).toString(),
);
await runAcceptanceCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", application]);
const evidence = await mkdtemp(join(await realpath("/tmp"), "enduragent-oauth-acceptance-"));
const home = join(evidence, "home");
const athleteHome = join(home, "athlete");
const configDir = join(athleteHome, "config");
const userData = join(home, "user-data");
for (const directory of [
  configDir,
  userData,
  join(home, "tmp"),
  join(home, "Library/Preferences"),
]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
await writeFile(
  join(configDir, "config.yaml"),
  [
    "data_source: store",
    `data_dir: ${JSON.stringify(athleteHome)}`,
    "llm:",
    "  provider: openai-codex",
    "  model: gpt-5.5",
    "  auth_profile: openai-codex",
    "intervals:",
    "  api_key: ''",
    "  athlete_id: '0'",
    "session:",
    "  timezone: UTC",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const profilesPath = join(configDir, "auth-profiles.json");
await writeFile(profilesPath, JSON.stringify({ "openai-codex": syntheticOAuthCredential() }), {
  mode: 0o600,
});
await preparePackagedTelegramSetupFixture(athleteHome);
let child: ChildProcess | undefined;
let terminal: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
const report = {
  ok: false,
  packageVersion: sourceManifest.version,
  archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  nativeKeychainVerified: false,
  nativeDpapiVerified: false,
  proof:
    "Distinct ad-hoc acceptance package; synthetic loopback provider; production owner, private IPC, utility, coach and engine; file-backed encryption key.",
  checks: [] as string[],
  launches: [] as {
    sequence: number;
    exit: { code: number | null; signal: NodeJS.Signals | null };
  }[],
  failure: undefined as string | undefined,
  privacyChecks: 0,
  reauthenticationEvents: [] as Extract<TurnEvent, { type: "error" }>[],
};
const credentialMarkers = [
  "synthetic-refresh-",
  "synthetic.eyJ",
  "synthetic-authorization-",
  "acceptance-synthetic-account",
];
let launchSequence = 0;
let captured = "";
let outputExceeded = false;
function markerFree(value: string, label: string) {
  assert(
    !credentialMarkers.some((marker) => value.includes(marker)),
    `${label} exposed a synthetic OAuth credential`,
  );
}
async function inspectHome(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (entry.isDirectory()) await inspectHome(path);
    else if (entry.isFile()) markerFree((await readFile(path)).toString(), "Disposable home file");
  }
}
async function verifyPrivacy() {
  assert(!outputExceeded, "Package output exceeded capture limit");
  markerFree(captured, "Package output");
  await inspectHome(home);
  const projection = await evaluate(
    "(async()=>({dom:document.documentElement.outerHTML,local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage),status:await window.enduragentAuth.chatgptStatus(),recovery:await window.enduragentAuth.credentialRecoveryStatus()}))()",
  );
  markerFree(JSON.stringify(projection), "Renderer projection");
  const table = await runAcceptanceCommand("/bin/ps", ["-axo", "pid=,ppid="]);
  const relationships = table.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  assert(child?.pid !== undefined);
  const pids = new Set([child.pid]);
  for (let i = 0; i < relationships.length; i++) {
    const before = pids.size;
    for (const [pid, parent] of relationships) if (pids.has(parent)) pids.add(pid);
    if (pids.size === before) break;
  }
  const processes = await runAcceptanceCommand("/bin/ps", [
    "eww",
    "-p",
    [...pids].join(","),
    "-o",
    "command=",
  ]);
  markerFree(processes.stdout.toString(), "Owned process arguments/environment");
  assert(
    !processes.stdout.toString().includes("enduragent-keychain"),
    "Native credential helper was launched",
  );
  report.privacyChecks++;
}
async function ownedListener(port: number): Promise<boolean> {
  if (child?.pid === undefined) return false;
  const result = await runAcceptanceCommand(
    "/usr/sbin/lsof",
    ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { allowFailure: true },
  );
  return result.stdout.toString().trim() === String(child.pid);
}
const provider = await startOAuthProviderFixture({
  verifyCallbackOwner: () => ownedListener(1455),
});
async function until(description: string, test: () => Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(100);
  }
  throw new Error(`${description} timed out`);
}
async function evaluate(expression: string): Promise<unknown> {
  assert(cdp);
  const response = await withAcceptanceDeadline(
    "renderer evaluation",
    cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    { timeoutMs: 30000, onTimeout: () => cdp?.socket.close() },
  );
  assert(!response.exceptionDetails, "Renderer evaluation failed");
  const result = response.result;
  assert(result !== null && typeof result === "object" && "value" in result);
  return result.value;
}
function envelope(): Record<string, unknown> {
  const bytes = readFileSync(join(userData, "credentials-v1/oauth.bin"));
  const key = readFileSync(join(userData, ".enduragent-acceptance-key"));
  try {
    assert.equal(bytes.subarray(0, 11).toString(), "ENDURAGENT1");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(12, 24));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const value: unknown = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(24, -16)), decipher.final()]).toString(),
    );
    assert(
      value !== null && typeof value === "object" && "home" in value && value.home === configDir,
    );
    return Object.fromEntries(Object.entries(value));
  } finally {
    key.fill(0);
  }
}
async function launch() {
  assert(child === undefined);
  launchSequence++;
  captured = "";
  outputExceeded = false;
  const debugPort = await reservePort();
  child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`],
    {
      cwd: home,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: join(home, "tmp"),
        LANG: "en_US.UTF-8",
        ENDURAGENT_HOME: athleteHome,
        ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
        ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
        ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "file",
        ENDURAGENT_ACCEPTANCE_TELEGRAM_BOT_API_ORIGIN: provider.origin,
        ENDURAGENT_ACCEPTANCE_OAUTH_ORIGIN: provider.origin,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const launched = child;
  terminal = new Promise((resolveTerminal, reject) => {
    launched.once("error", reject);
    launched.once("close", (code, signal) => resolveTerminal({ code, signal }));
  });
  const capture = (bytes: Buffer) => {
    if (captured.length + bytes.length > 2 * 1024 * 1024) outputExceeded = true;
    else captured += bytes.toString();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  await until("owned debugger", () => ownedListener(debugPort));
  const debuggerUrl = await waitForPage(debugPort);
  const debuggerAddress = new URL(debuggerUrl);
  assert.equal(debuggerAddress.protocol, "ws:");
  assert.equal(debuggerAddress.hostname, "127.0.0.1");
  assert.equal(debuggerAddress.port, String(debugPort));
  cdp = await connectCdp(debuggerUrl, () => {});
  await until(
    "settled renderer",
    async () =>
      (await evaluate(
        "document.querySelector('[data-shell][data-onboarding=\"settled\"]') !== null",
      )) === true,
  );
}
async function quit() {
  if (!child || !terminal) return;
  child.stdin?.end(TELEGRAM_ACCEPTANCE_QUIT_FRAME);
  try {
    const result = await withAcceptanceDeadline("packaged app quit", terminal, {
      timeoutMs: 15000,
      onTimeout: () => child?.kill("SIGTERM"),
    });
    report.launches.push({ sequence: launchSequence, exit: result });
    assert.deepEqual(result, { code: 0, signal: null });
    markerFree(captured, "Package output at shutdown");
    assert(!outputExceeded, "Package output exceeded capture limit");
  } finally {
    cdp?.socket.close();
    cdp = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await withAcceptanceDeadline("packaged app termination", terminal, { timeoutMs: 5000 });
    }
    await writeFile(
      join(evidence, `launch-${launchSequence}.log`),
      captured.replace(
        /synthetic-(?:refresh|authorization)-[0-9]+|synthetic\.[A-Za-z0-9_-]+\.synthetic|acceptance-synthetic-account/g,
        "<synthetic-credential-redacted>",
      ),
      { mode: 0o600 },
    );
    child = undefined;
    terminal = undefined;
  }
}
async function turn(label: string, onEvent?: (event: TurnEvent) => void) {
  const connection = await evaluate("window.enduragentAuth.getDaemonConnection()");
  assert(
    connection !== null &&
      typeof connection === "object" &&
      "url" in connection &&
      typeof connection.url === "string",
  );
  const client = await connectCoachClient({
    url: connection.url,
    token: readFileSync(join(configDir, "daemon.token"), "utf8").trim(),
    expectedAthleteHome: athleteHome,
  });
  try {
    return await client.call(
      "chat",
      { chatId: `acceptance-${label}`, message: "Reply with a short greeting." },
      { signal: AbortSignal.timeout(30000), onEvent },
    );
  } finally {
    await client.close();
  }
}
const count = (kind: string) => provider.observations.filter((item) => item.kind === kind).length;
try {
  await launch();
  assert.equal((await turn("migration")).text, "Synthetic packaged coach response.");
  assert.deepEqual(JSON.parse(readFileSync(profilesPath, "utf8")), {});
  await verifyPrivacy();
  assert.equal((await lstat(join(userData, "credentials-v1/oauth.bin"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(userData, ".enduragent-acceptance-key"))).mode & 0o777, 0o600);
  const migratedEnvelope = envelope();
  assert(migratedEnvelope.profiles);
  report.checks.push("migrated credential reached the actual packaged coach model request");
  await quit();
  await launch();
  assert.deepEqual(envelope(), migratedEnvelope);
  assert.equal((await turn("restart")).text, "Synthetic packaged coach response.");
  report.checks.push("encrypted credential survived restart and reached the actual coach");
  await verifyPrivacy();
  const deleted = await evaluate(
    "window.enduragentAuth.deleteCredential({credential:'openai-codex'})",
  );
  assert(
    deleted !== null &&
      typeof deleted === "object" &&
      "status" in deleted &&
      deleted.status === "deleted",
  );
  provider.expireNewLogin();
  const login = await evaluate(
    "window.enduragentAuth.chatgptLogin({operationId:'synthetic-acceptance-login',selection:{provider:'openai-codex',model:'gpt-5.5',endpoint:{mode:'automatic'}}})",
  );
  assert(
    login !== null && typeof login === "object" && "status" in login && login.status === "stored",
    "Synthetic production login was not stored",
  );
  assert.equal((await turn("expired-login")).text, "Synthetic packaged coach response.");
  assert.equal(count("authorize"), 1);
  assert.equal(count("refresh"), 1);
  report.checks.push(
    "real browser state/PKCE callback and token exchange; expired login refreshed before actual coach request",
  );
  await verifyPrivacy();
  provider.rejectNextModel();
  const modelsBefore = count("model");
  assert.equal((await turn("model-retry")).text, "Synthetic packaged coach response.");
  assert.equal(count("model") - modelsBefore, 2);
  assert.equal(count("refresh"), 2);
  report.checks.push("model 401 caused exactly one refresh and one successful retry");
  await verifyPrivacy();
  provider.rejectNextModel();
  provider.rejectRefresh();
  const modelsBeforeReauthentication = count("model");
  const tokensBeforeReauthentication = count("token");
  await assert.rejects(
    turn("reauthentication", (event) => {
      if (event.type === "error") report.reauthenticationEvents.push(event);
    }),
    CoachRpcRemoteError,
  );
  assert.equal(report.reauthenticationEvents.length, 1);
  assert.equal(report.reauthenticationEvents[0].kind, "provider-auth");
  assert.equal(
    report.reauthenticationEvents[0].athleteMessage,
    "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.",
  );
  assert.equal(count("model") - modelsBeforeReauthentication, 1);
  assert.equal(count("token"), tokensBeforeReauthentication);
  assert.equal(count("refresh"), 3);
  report.checks.push("invalid_grant prevented a successful coach turn without retrying refresh");
  await verifyPrivacy();
  const finalDeletion = await evaluate(
    "window.enduragentAuth.deleteCredential({credential:'openai-codex'})",
  );
  assert(
    finalDeletion !== null &&
      typeof finalDeletion === "object" &&
      "status" in finalDeletion &&
      finalDeletion.status === "deleted",
  );
  await assert.rejects(lstat(join(userData, "credentials-v1/oauth.bin")), { code: "ENOENT" });
  await quit();
  await launch();
  const state = await evaluate("window.enduragentAuth.chatgptStatus()");
  assert(
    state !== null &&
      typeof state === "object" &&
      "runtimeReady" in state &&
      state.runtimeReady === false,
  );
  report.checks.push("deletion remained disconnected after restart");
  await verifyPrivacy();
  assert.equal(count("fixture-rejected-request"), 0);
  report.ok = true;
} catch (error) {
  report.failure =
    error instanceof Error
      ? error.message.replace(
          /synthetic-(?:refresh|authorization)-[0-9]+|synthetic\.[A-Za-z0-9_-]+\.synthetic|acceptance-synthetic-account/g,
          "<synthetic-credential-redacted>",
        )
      : "Acceptance run failed";
  process.exitCode = 1;
} finally {
  try {
    await quit();
  } catch {
    report.ok = false;
    report.failure ??= "Package shutdown failed";
    process.exitCode = 1;
  } finally {
    await provider.close();
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify({ ...report, observations: provider.observations }, null, 2),
      { mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ ok: report.ok, evidence: join(evidence, "result.json") })}\n`,
    );
  }
}
