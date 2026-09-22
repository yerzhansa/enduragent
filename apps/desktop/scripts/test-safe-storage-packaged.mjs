import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDisposableSafeStorageContext } from "../smoke/safe-storage-test-context.mjs";

delete process.env.FORCE_COLOR;
delete process.env.CLICOLOR_FORCE;
requireDisposableSafeStorageContext(process.env, process.platform);
const { build } = await import("esbuild");

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
const scratch = await mkdtemp(join(base, "eav-"));
const staging = join(scratch, "fixture");
const userData = join(scratch, "user-data");
const electronUserData = join(scratch, "electron-user-data");
const operatorHome = join(scratch, "operator-home");
const athleteHome = join(scratch, "athlete-home");
const commandPath = join(scratch, "command.json");
const resultPath = join(scratch, "result.json");
const sentinel = "synthetic-packaged-safe-storage-sentinel";
const unaffected = "synthetic-packaged-unaffected-sentinel";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { timeoutMs = 120_000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function executable() {
  const entries = await readdir(join(staging, "dist"), { recursive: true });
  const relative = entries.find((entry) =>
    entry.endsWith("Safe Storage Fixture.app/Contents/MacOS/Safe Storage Fixture"),
  );
  if (relative === undefined) throw new TypeError();
  return join(staging, "dist", relative);
}

async function treeContains(root, value) {
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries) {
    try {
      if ((await readFile(join(root, entry))).includes(Buffer.from(value))) return true;
    } catch {}
  }
  return false;
}

const fixtureMain = `
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { CREDENTIAL_DIRECTORY_NAME, createCredentialVault } = require("./credential-vault.cjs");

const command = JSON.parse(readFileSync(process.env.W9_SAFE_STORAGE_COMMAND, "utf8"));

async function execute() {
  const applied = new Map();
  const vault = createCredentialVault({
    root: join(command.userData, CREDENTIAL_DIRECTORY_NAME),
    encryption: safeStorage,
    async applyCredential(slot, value) {
      applied.set(slot, value);
    },
  });
  if (command.mode === "write") {
    const first = await vault.writeCredential({ slot: "anthropic", value: command.sentinel });
    const second = await vault.writeCredential({ slot: "openrouter", value: command.unaffected });
    const ciphertext = first.status === "configured"
      ? await readFile(join(command.userData, CREDENTIAL_DIRECTORY_NAME, "anthropic.bin"))
      : Buffer.alloc(0);
    await writeFile(command.resultPath, JSON.stringify({
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      ciphertextContainsPlaintext: ciphertext.includes(Buffer.from(command.sentinel)),
      firstConfigured: first.status === "configured",
      secondConfigured: second.status === "configured",
      firstReason: first.status === "refused" ? first.reason : null,
      secondReason: second.status === "refused" ? second.reason : null,
    }), { mode: 0o600 });
    app.exit(0);
    return;
  }
  await vault.reapplyConfigured();
  const relaunchRoundTrip = applied.get("anthropic") === command.sentinel;
  const ciphertextPath = join(command.userData, CREDENTIAL_DIRECTORY_NAME, "anthropic.bin");
  const ciphertext = await readFile(ciphertextPath);
  ciphertext[ciphertext.length - 1] ^= 0x01;
  await writeFile(ciphertextPath, ciphertext, { mode: 0o600 });
  const statuses = await vault.credentialStatuses();
  const corrupt = statuses.find((entry) => entry.slot === "anthropic");
  const healthy = statuses.find((entry) => entry.slot === "openrouter");
  await writeFile(command.resultPath, JSON.stringify({
    relaunchRoundTrip,
    corruptionRejected: corrupt?.state === "re-prompt",
    corruptSlotState: corrupt?.state,
    unaffectedSlotState: healthy?.state,
  }), { mode: 0o600 });
  app.exit(0);
}

app.whenReady().then(execute).catch(() => app.exit(1));
`;

try {
  await Promise.all([
    mkdir(staging, { recursive: true, mode: 0o700 }),
    mkdir(userData, { recursive: true, mode: 0o700 }),
    mkdir(electronUserData, { recursive: true, mode: 0o700 }),
    mkdir(operatorHome, { recursive: true, mode: 0o700 }),
    mkdir(athleteHome, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(staging, "main.cjs"), fixtureMain);
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify({
      name: "enduragent-safe-storage-fixture",
      version: "0.0.0",
      private: true,
      main: "main.cjs",
    }),
  );
  await writeFile(
    join(staging, "electron-builder.yml"),
    [
      "appId: icu.enduragent.safe-storage-fixture",
      "productName: Safe Storage Fixture",
      "electronVersion: 44.4.3",
      "asar: true",
      "directories:",
      "  output: dist",
      "files:",
      "  - main.cjs",
      "  - credential-vault.cjs",
      "  - package.json",
      "mac:",
      "  identity: null",
      "  target:",
      "    - target: dir",
      "      arch: [arm64]",
      "",
    ].join("\n"),
  );
  const vaultSource = join(desktopRoot, "src/main/credential-vault.ts");
  await build({
    stdin: {
      contents: `export { CREDENTIAL_DIRECTORY_NAME, createCredentialVault } from ${JSON.stringify(vaultSource)};`,
      loader: "js",
      resolveDir: desktopRoot,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    treeShaking: true,
    logLevel: "silent",
    plugins: [
      {
        name: "credential-vault-fixture-boundary",
        setup(buildContext) {
          buildContext.onResolve({ filter: /^@enduragent\/coach-contract$/ }, () => ({
            path: "coach-contract",
            namespace: "fixture-boundary",
          }));
          buildContext.onResolve({ filter: /^\.\/llm-selection\.js$/ }, () => ({
            path: "llm-selection",
            namespace: "fixture-boundary",
          }));
          buildContext.onLoad({ filter: /.*/, namespace: "fixture-boundary" }, (args) => ({
            contents:
              args.path === "coach-contract"
                ? "export const isKeylessProvider = () => false;"
                : "export const parseOnboardingLlmSelection = () => { throw new TypeError(); };",
            loader: "js",
          }));
        },
      },
    ],
    outfile: join(staging, "credential-vault.cjs"),
  });
  const packaged = await run(
    resolve(desktopRoot, "node_modules/.bin/electron-builder"),
    ["--dir", `--projectDir=${staging}`],
    {
      cwd: desktopRoot,
      env: { ...process.env, FORCE_COLOR: undefined, CLICOLOR_FORCE: undefined },
    },
  );
  if (packaged.code !== 0 || packaged.signal !== null) {
    throw new Error(packaged.stderr || packaged.stdout || "packaging failed");
  }
  const appExecutable = await executable();
  const launchEnvironment = {
    ...process.env,
    HOME: operatorHome,
    ENDURAGENT_HOME: athleteHome,
    W9_SAFE_STORAGE_COMMAND: commandPath,
    ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  await writeFile(
    commandPath,
    JSON.stringify({ mode: "write", userData, resultPath, sentinel, unaffected }),
    { mode: 0o600 },
  );
  await chmod(commandPath, 0o600);
  const launchArguments = [`--user-data-dir=${electronUserData}`];
  const firstExit = await run(appExecutable, launchArguments, {
    env: launchEnvironment,
    timeoutMs: 20_000,
  });
  if (firstExit.timedOut || firstExit.code !== 0 || firstExit.signal !== null) {
    throw new Error(firstExit.stderr || firstExit.stdout || "first fixture launch failed");
  }
  const first = JSON.parse(await readFile(resultPath, "utf8"));
  if (first.firstConfigured !== true || first.secondConfigured !== true) {
    throw new Error(JSON.stringify(first));
  }
  await writeFile(
    commandPath,
    JSON.stringify({ mode: "read", userData, resultPath, sentinel, unaffected }),
    { mode: 0o600 },
  );
  const secondExit = await run(appExecutable, launchArguments, {
    env: launchEnvironment,
    timeoutMs: 20_000,
  });
  if (secondExit.timedOut || secondExit.code !== 0 || secondExit.signal !== null) {
    throw new Error(secondExit.stderr || secondExit.stdout || "second fixture launch failed");
  }
  const second = JSON.parse(await readFile(resultPath, "utf8"));
  const captured = JSON.stringify({
    packaged,
    firstExit,
    secondExit,
    first,
    second,
    command: { path: commandPath },
  });
  const packageEntries = await readdir(join(staging, "dist"), { recursive: true });
  const packageContainsPlaintext = await treeContains(join(staging, "dist"), sentinel);
  const appExitObserved =
    firstExit.code === 0 &&
    firstExit.signal === null &&
    secondExit.code === 0 &&
    secondExit.signal === null;
  const summary = {
    ok:
      first.encryptionAvailable === true &&
      first.ciphertextContainsPlaintext === false &&
      first.firstConfigured === true &&
      first.secondConfigured === true &&
      second.relaunchRoundTrip === true &&
      second.corruptionRejected === true &&
      second.corruptSlotState === "re-prompt" &&
      second.unaffectedSlotState === "configured" &&
      appExitObserved &&
      !captured.includes(sentinel) &&
      !packageContainsPlaintext &&
      !packageEntries.some((entry) => entry.includes("vitest") || entry.endsWith(".map")),
    encryptionAvailable: first.encryptionAvailable,
    ciphertextContainsPlaintext: first.ciphertextContainsPlaintext,
    relaunchRoundTrip: second.relaunchRoundTrip,
    corruptionRejected: second.corruptionRejected,
    corruptSlotState: second.corruptSlotState,
    unaffectedSlotState: second.unaffectedSlotState,
    appExitObserved,
  };
  if (!summary.ok) throw new Error(JSON.stringify(summary));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
