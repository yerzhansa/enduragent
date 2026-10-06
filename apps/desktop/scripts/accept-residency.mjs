import { execFile, execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.env.ENDURAGENT_WINDOWED_ACK !== "1") {
  process.stderr.write(
    "accept:residency launches a real focused window on this display. " +
      "Announce the run to the operator first, then re-run with ENDURAGENT_WINDOWED_ACK=1.\n",
  );
  process.exit(2);
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(desktopRoot, "tests", "fixtures", "residency");
const processDeadlineMs = 20_000;
const sessions = new Set();
const knownPids = new Set();
let requestSequence = 0;
let fixtureExecutable;
let fixtureRootPath;
let cleanObserved = false;
let interrupted = false;

function requireValue(value) {
  if (!value) throw new TypeError();
  return value;
}

function assert(value) {
  if (!value) throw new TypeError();
}

function run(file, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      file,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...options },
      (error, stdout, stderr) => {
        if (error) rejectRun(error);
        else resolveRun({ stdout, stderr });
      },
    );
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withProcessDeadline(promise) {
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new TypeError()), processDeadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveWait(value);
      },
      () => {
        clearTimeout(timer);
        rejectWait(new TypeError());
      },
    );
  });
}

function processRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
        return match === null
          ? undefined
          : { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] };
      })
      .filter((row) => row !== undefined);
  } catch {
    return [];
  }
}

function collectDescendants(pid, target = new Set([pid])) {
  const rows = processRows();
  const frontier = [pid];
  while (frontier.length > 0) {
    const parentPid = frontier.shift();
    for (const row of rows) {
      if (row.parentPid !== parentPid || target.has(row.pid)) continue;
      target.add(row.pid);
      frontier.push(row.pid);
    }
  }
  for (const knownPid of target) knownPids.add(knownPid);
  return target;
}

function collectFixtureProcesses() {
  if (fixtureRootPath === undefined) return new Set();
  const pids = new Set(
    processRows()
      .filter((row) => row.command.includes(fixtureRootPath))
      .map((row) => row.pid),
  );
  for (const pid of pids) knownPids.add(pid);
  return pids;
}

async function waitDead(pid) {
  const deadline = Date.now() + processDeadlineMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new TypeError();
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function waitPidsDead(pids) {
  await Promise.all([...pids].map((pid) => waitDead(pid)));
}

async function findApp(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) return path;
    if (entry.isDirectory()) {
      const nested = await findApp(path);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function launch() {
  const child = spawn(requireValue(fixtureExecutable), [], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pid = requireValue(child.pid);
  knownPids.add(pid);
  const messages = [];
  const waiters = new Set();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    messages.push(value);
    for (const waiter of waiters) {
      if (!waiter.predicate(value)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(value);
    }
  });
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  const exited = new Promise((resolveExit) => {
    child.once("close", (code, signal) =>
      resolveExit(spawnFailed ? { code: null, signal: "spawn-error" } : { code, signal }),
    );
  });
  const session = {
    child,
    pid,
    exited,
    messages,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          reject: rejectWait,
          timer: undefined,
        };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          rejectWait(new TypeError());
        }, processDeadlineMs);
        waiters.add(waiter);
      });
    },
    command(command, value) {
      const id = `request-${++requestSequence}`;
      const response = session.waitFor((message) => message.id === id);
      child.stdin.write(
        `${JSON.stringify({ id, command, ...(value === undefined ? {} : { value }) })}\n`,
      );
      return response;
    },
  };
  sessions.add(session);
  child.once("close", () => {
    sessions.delete(session);
    lines.close();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new TypeError());
    }
    waiters.clear();
  });
  return session;
}

function isClean(response) {
  return (
    response.login?.openAtLogin === false &&
    response.login?.executableWillLaunchAtLogin === false &&
    ["not-found", "not-registered"].includes(response.login?.status)
  );
}

async function terminateSession(session) {
  const pids = collectDescendants(session.pid);
  await terminatePids(pids);
}

async function terminatePids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  try {
    await waitPidsDead(pids);
  } catch {
    for (const pid of pids) {
      if (!alive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await waitPidsDead(pids);
  }
}

async function quitSession(session) {
  const pids = collectDescendants(session.pid);
  const response = await session.command("quit");
  const exit = await withProcessDeadline(session.exited);
  collectDescendants(session.pid, pids);
  await waitPidsDead(pids);
  assert(response.trayAlive === false);
  assert(exit.code === 0 && exit.signal === null);
  return response;
}

async function cleanupRegistration() {
  if (fixtureExecutable === undefined) return;
  const cleanup = launch();
  const ready = await cleanup.waitFor((message) => message.event === "ready");
  assert(ready.ready === true);
  const cleared = await cleanup.command("set-open-at-login", false);
  cleanObserved = isClean(cleared);
  assert(cleanObserved);
  await quitSession(cleanup);
}

function result(ok) {
  if (!ok) return { ok: false };
  return {
    ok: true,
    singleTray: true,
    loserExitedPreReady: true,
    dockCloseSurvived: true,
    quitToreDown: true,
    loginPersisted: true,
    cleanUnregistered: true,
    finalStatus: "not-found-or-not-registered",
  };
}

async function executeScenario() {
  assert(process.platform === "darwin" && process.arch === "arm64");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "enduragent-residency-"));
  fixtureRootPath = temporaryRoot;
  const stage = join(temporaryRoot, "stage");
  const output = join(temporaryRoot, "output");
  const resources = join(stage, "resources");
  try {
    await mkdir(resources, { recursive: true });
    await Promise.all([
      copyFile(join(fixtureRoot, "package.json"), join(stage, "package.json")),
      copyFile(join(fixtureRoot, "tray-preload.cjs"), join(stage, "tray-preload.cjs")),
      copyFile(
        join(desktopRoot, "resources", "trayTemplate.png"),
        join(resources, "trayTemplate.png"),
      ),
      copyFile(
        join(desktopRoot, "resources", "trayTemplate@2x.png"),
        join(resources, "trayTemplate@2x.png"),
      ),
    ]);
    const environment = {
      ...process.env,
      RESIDENCY_FIXTURE_STAGE: stage,
      RESIDENCY_FIXTURE_OUTPUT: output,
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
      NO_COLOR: undefined,
    };
    await run(
      join(desktopRoot, "node_modules", ".bin", "electron-vite"),
      ["build", "--config", join(fixtureRoot, "electron.vite.config.ts")],
      { cwd: desktopRoot, env: environment },
    );
    const builderTemplate = await readFile(join(fixtureRoot, "electron-builder.yml"), "utf8");
    const desktopManifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
    const electronVersion = requireValue(desktopManifest.devDependencies?.electron);
    const builderConfigPath = join(temporaryRoot, "electron-builder.resolved.yml");
    await writeFile(
      builderConfigPath,
      [
        builderTemplate
          .replace("${env.RESIDENCY_FIXTURE_STAGE}", JSON.stringify(stage))
          .replace("${env.RESIDENCY_FIXTURE_OUTPUT}", JSON.stringify(output)),
        `electronVersion: ${JSON.stringify(electronVersion)}`,
        `electronDist: ${JSON.stringify(join(desktopRoot, "node_modules", "electron", "dist"))}`,
        "npmRebuild: false",
        "",
      ].join("\n"),
    );
    await run(
      join(desktopRoot, "node_modules", ".bin", "electron-builder"),
      ["--config", builderConfigPath, "--arm64"],
      { cwd: stage, env: environment },
    );
    const appPath = requireValue(await findApp(output));
    await run("codesign", ["--verify", "--deep", "--strict", appPath]);
    fixtureExecutable = join(appPath, "Contents", "MacOS", "Enduragent Residency Acceptance");
    assert(!interrupted);

    const generationA = launch();
    const readyA = await generationA.waitFor((message) => message.event === "ready");
    assert(readyA.ready === true);
    assert(readyA.trayCreationCount === 1 && readyA.trayAlive === true);
    assert(readyA.mainWindowAlive === true);
    assert(readyA.trayImageEmpty === false && readyA.trayImageTemplate === true);
    assert(readyA.trayImageSize?.width === 16 && readyA.trayImageSize?.height === 16);
    const initialClear = await generationA.command("set-open-at-login", false);
    assert(isClean(initialClear));
    const enabledA = await generationA.command("set-open-at-login", true);
    assert(enabledA.login?.openAtLogin === true);
    await quitSession(generationA);

    assert(!interrupted);
    const generationB = launch();
    const readyB = await generationB.waitFor((message) => message.event === "ready");
    assert(readyB.login?.openAtLogin === true);
    assert(readyB.trayCreationCount === 1);
    const closedB = await generationB.command("close-main-window");
    assert(closedB.mainWindowAlive === false);
    assert(closedB.trayAlive === true && closedB.trayCreationCount === 1);
    assert(alive(generationB.pid));
    const shownB = await generationB.command("show-main-window");
    assert(shownB.mainWindowAlive === true && shownB.trayCreationCount === 1);
    await quitSession(generationB);

    assert(!interrupted);
    const generationC = launch();
    const readyC = await generationC.waitFor((message) => message.event === "ready");
    assert(readyC.trayCreationCount === 1);
    assert(!interrupted);
    const generationD = launch();
    const deniedD = await generationD.waitFor((message) => message.event === "lock-denied");
    assert(deniedD.ready === false && deniedD.trayCreationCount === 0);
    const exitD = await withProcessDeadline(generationD.exited);
    assert(exitD.code === 0 && exitD.signal === null);
    assert(!generationD.messages.some((message) => message.event === "ready"));
    const secondC = await generationC.waitFor((message) => message.event === "second-instance");
    assert(secondC.secondInstanceCount === 1 && secondC.trayCreationCount === 1);
    assert(secondC.trayAlive === true);
    const clearedC = await generationC.command("set-open-at-login", false);
    cleanObserved = isClean(clearedC);
    assert(cleanObserved);
    await quitSession(generationC);

    await waitPidsDead(knownPids);
    assert(sessions.size === 0);
    assert(collectFixtureProcesses().size === 0);
  } finally {
    for (const session of sessions) {
      try {
        await terminateSession(session);
      } catch {}
    }
    try {
      await terminatePids(collectFixtureProcesses());
    } catch {}
    if (!cleanObserved && fixtureExecutable !== undefined) {
      try {
        await cleanupRegistration();
      } catch {}
    }
    for (const session of sessions) {
      try {
        await terminateSession(session);
      } catch {}
    }
    try {
      await terminatePids(collectFixtureProcesses());
    } catch {}
    try {
      await terminatePids(new Set([...knownPids].filter((pid) => alive(pid))));
    } catch {}
    fixtureExecutable = undefined;
    fixtureRootPath = undefined;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  assert(!interrupted && cleanObserved);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    for (const session of sessions) {
      try {
        session.child.kill("SIGTERM");
      } catch {}
    }
  });
}

let ok = false;
try {
  await executeScenario();
  ok = true;
} catch {}
process.stdout.write(`RESIDENCY_ACCEPTANCE ${JSON.stringify(result(ok && cleanObserved))}\n`);
process.exitCode = ok && cleanObserved ? 0 : 1;
