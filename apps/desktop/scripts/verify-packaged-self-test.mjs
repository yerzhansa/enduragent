import { spawn } from "node:child_process";
import { connect } from "node:net";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVELOPMENT_PRODUCT_NAME,
  createDevelopmentPackagePlan,
} from "./development-package-plan.mjs";
import { KEYCHAIN_BINDING_ASAR_PATH } from "./package-inventory.mjs";

const APP_READY_TIMEOUT_MS = 30_000;
const SELF_TEST_TIMEOUT_MS = 120_000;
const CLEAN_EXIT_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 600_000;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const cliEntry = join(repositoryRoot, "packages/coach/dist/enduragent.js");
const developmentPackagePlan = createDevelopmentPackagePlan({ desktopRoot });

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function checked(condition, message) {
  if (!condition) throw new Error(message);
}

function runChecked(file, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("build command timed out"));
    }, BUILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolveRun();
      else rejectRun(new Error("build command failed"));
    });
  });
}

function capture(file, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("self-test command timed out"));
    }, SELF_TEST_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function applicationEnvironment(athleteHome) {
  const environment = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
    "__CF_USER_TEXT_ENCODING",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.ENDURAGENT_HOME = athleteHome;
  environment.ENDURAGENT_ACCEPTANCE_HIDDEN = "1";
  return environment;
}

async function createAthleteHome(root, name) {
  const athleteHome = join(root, name);
  const configDirectory = join(athleteHome, "config");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDirectory, "config.yaml"),
    [
      "data_source: store",
      `data_dir: ${JSON.stringify(athleteHome)}`,
      "llm:",
      "  provider: anthropic",
      "  model: synthetic",
      "  api_key: synthetic",
      "intervals:",
      "  api_key: ''",
      "  athlete_id: '0'",
      "session:",
      "  timezone: UTC",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return athleteHome;
}

function packagedApplication() {
  return developmentPackagePlan.applicationPath;
}

function executableFor(application) {
  return join(application, "Contents", "MacOS", DEVELOPMENT_PRODUCT_NAME);
}

function launchApplication(application, athleteHome, screenshotPath) {
  const environment = applicationEnvironment(athleteHome);
  checked(environment.CYCLING_COACH_HOME === undefined, "legacy home override is present");
  const child = spawn(
    executableFor(application),
    [
      "--desktop-security-smoke",
      `--desktop-security-output=${screenshotPath}`,
      `--user-data-dir=${screenshotPath}.user-data`,
    ],
    { env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let pending = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const readyTimer = setTimeout(
    () => rejectReady(new Error("packaged application was not ready")),
    APP_READY_TIMEOUT_MS,
  );
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    pending += text;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("DESKTOP_SECURITY_READY ")) continue;
      clearTimeout(readyTimer);
      try {
        resolveReady(JSON.parse(line.slice("DESKTOP_SECURITY_READY ".length)));
      } catch {
        rejectReady(new Error("packaged readiness frame was invalid"));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, ready, exited, environment, output: () => ({ stdout, stderr }) };
}

async function processLines(application) {
  const result = await capture("ps", ["-axo", "pid=,ppid=,command="], {
    timeout: CLEAN_EXIT_TIMEOUT_MS,
  });
  checked(result.code === 0, "process inspection failed");
  return result.stdout.split("\n").filter((line) => line.includes(application));
}

function listenerClosed(url) {
  const target = new URL(url);
  return new Promise((resolveClosed) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveClosed(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveClosed(false);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveClosed(true);
    });
  });
}

async function stopApplication(running, application, rpcUrl) {
  if (!running.child.stdin.destroyed) running.child.stdin.end("shutdown\n");
  const outcome = await Promise.race([
    running.exited,
    delay(CLEAN_EXIT_TIMEOUT_MS).then(() => undefined),
  ]);
  if (outcome === undefined) {
    running.child.kill("SIGKILL");
    await running.exited;
    throw new Error("packaged application did not stop cleanly");
  }
  checked(
    outcome.code === 0 && outcome.signal === null,
    "packaged application exited unsuccessfully",
  );
  const deadline = Date.now() + CLEAN_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await processLines(application)).length === 0 && (await listenerClosed(rpcUrl))) return;
    await delay(100);
  }
  throw new Error("packaged application resources remained active");
}

async function invokeCli(athleteHome, schema, expectedExit) {
  const environment = applicationEnvironment(athleteHome);
  checked(environment.CYCLING_COACH_HOME === undefined, "legacy home override is present");
  const result = await capture(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cliEntry, "self-test"],
    { cwd: repositoryRoot, env: environment },
  );
  checked(result.code === expectedExit && result.signal === null, "self-test exit was unexpected");
  checked(result.stderr === "", "self-test wrote an error stream");
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  checked(lines.length === 1 && result.stdout.endsWith("\n"), "self-test output was not one line");
  const terminal = schema.parse(JSON.parse(lines[0]));
  const token = (await readFile(join(athleteHome, "config/daemon.token"), "utf8")).trim();
  checked(
    !result.stdout.includes(token) && !result.stdout.includes(athleteHome),
    "self-test output exposed private data",
  );
  return terminal;
}

async function runApplicationCase(input) {
  const screenshotPath = join(input.scratch, `${input.name}.png`);
  const running = launchApplication(input.application, input.athleteHome, screenshotPath);
  let ready;
  try {
    ready = await running.ready;
    checked(typeof ready.rpcUrl === "string", "packaged readiness omitted the RPC address");
    const terminal = await invokeCli(input.athleteHome, input.schema, input.expectedExit);
    await stopApplication(running, input.application, ready.rpcUrl);
    return terminal;
  } catch (error) {
    if (!running.child.stdin.destroyed) running.child.stdin.end("shutdown\n");
    const settled = await Promise.race([
      running.exited.then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (!settled) {
      running.child.kill("SIGKILL");
      await running.exited;
    }
    throw error;
  }
}

async function main() {
  checked(process.platform === "darwin", "packaged self-test verification requires macOS");
  checked(process.argv.length === 2, "arguments are not supported");
  await runChecked("pnpm", ["--filter", "@enduragent/desktop...", "build"]);
  await runChecked("pnpm", ["--filter", "@enduragent/desktop", "package:dir"]);
  const { SelfTestCommandTerminalSchema } = await import("@enduragent/coach-contract");
  const base = await realpath("/tmp");
  const scratch = await mkdtemp(join(base, "ea7-"));
  try {
    const originalApplication = packagedApplication();
    const firstHome = await createAthleteHome(scratch, "h1");
    const success = await runApplicationCase({
      name: "success",
      scratch,
      application: originalApplication,
      athleteHome: firstHome,
      schema: SelfTestCommandTerminalSchema,
      expectedExit: 0,
    });
    checked(success.ok, "packaged self-test did not succeed");
    checked(success.runtime.electron === "43.1.1", "packaged Electron version was unexpected");
    checked(
      Number(success.runtime.node.split(".")[0]) >= 24,
      "packaged Node version was unexpected",
    );

    const copiedApplication = join(scratch, `c/${DEVELOPMENT_PRODUCT_NAME}.app`);
    await mkdir(dirname(copiedApplication), { recursive: true });
    await cp(originalApplication, copiedApplication, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const matrixPath = join(copiedApplication, "Contents/Resources/self-test/matrix.json");
    const matrix = await readFile(matrixPath);
    matrix[0] = matrix[0] === 97 ? 98 : 97;
    await writeFile(matrixPath, matrix);
    await runChecked("codesign", [
      "--force",
      "--sign",
      "-",
      join(
        copiedApplication,
        "Contents/Resources/app.asar.unpacked",
        KEYCHAIN_BINDING_ASAR_PATH,
      ),
    ]);
    const frameworksDirectory = join(copiedApplication, "Contents/Frameworks");
    for (const entry of (await readdir(frameworksDirectory)).sort()) {
      const componentPath = entry.endsWith(".framework")
        ? join(frameworksDirectory, entry, "Versions/A")
        : join(frameworksDirectory, entry);
      await runChecked("codesign", ["--force", "--sign", "-", componentPath]);
    }
    await runChecked("codesign", ["--force", "--sign", "-", copiedApplication]);
    await runChecked("codesign", ["--verify", "--strict", copiedApplication]);
    const secondHome = await createAthleteHome(scratch, "h2");
    const failure = await runApplicationCase({
      name: "corruption",
      scratch,
      application: copiedApplication,
      athleteHome: secondHome,
      schema: SelfTestCommandTerminalSchema,
      expectedExit: 7,
    });
    checked(
      !failure.ok &&
        failure.error.code === "CHECKSUM_MISMATCH" &&
        failure.error.location === "extraResources",
      "corruption result was unexpected",
    );
    process.stdout.write(
      `${JSON.stringify({ successExit: 0, corruptionExit: 7, suites: success.suites })}\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
