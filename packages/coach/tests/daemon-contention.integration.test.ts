import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AthleteHome } from "@enduragent/kernel-node/home";

const fixture = fileURLToPath(new URL("./fixtures/daemon-process.ts", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function syntheticHome(label: string): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), `${label}-`));
  roots.push(root);
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  for (const name of [
    "HOME",
    "ENDURAGENT_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "UV_CACHE_DIR",
  ]) {
    env[name] = root;
  }
  return env;
}

function spawn(role: string, home: AthleteHome): ChildProcess {
  const child = fork(fixture, [role], {
    execArgv: ["--import", "tsx"],
    env: isolatedEnv(home.root),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function message<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown): void => {
      const record = value as { readonly type?: unknown };
      if (record.type === "error") {
        cleanup();
        reject(new Error("fixture failed"));
      } else if (record.type === type) {
        cleanup();
        resolve(value as T);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`fixture exited before ${type}: ${code}`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function send(child: ChildProcess, value: Parameters<ChildProcess["send"]>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(value, (error) => (error === null ? resolve() : reject(error)));
  });
}

function exit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM daemon-contention\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => server.close(() => resolve(true)));
  });
}

const hasLoopback = await loopbackAvailable();

describe.skipIf(!hasLoopback)("real daemon contention matrix", () => {
  it(
    "covers healthy, SIGKILL-stale, bound-unresponsive, and foreign-port processes",
    { timeout: 20_000 },
    async () => {
      const healthyHome = await syntheticHome("contention-healthy");
      const healthy = spawn("writer", healthyHome);
      const healthyReadyPromise = message<{
        readonly rawPort: number;
        readonly protocolPort: number;
        readonly pid: number;
      }>(healthy, "ready");
      await send(healthy, { type: "start", home: healthyHome, mode: "healthy" });
      const healthyReady = await healthyReadyPromise;
      expect(healthyReady.rawPort).not.toBe(healthyReady.protocolPort);
      const healthyStarter = spawn("classify", healthyHome);
      const healthyClassification = message<{
        readonly result: { readonly status: string; readonly peer?: { readonly port: number } };
      }>(healthyStarter, "classification");
      await send(healthyStarter, { type: "start", home: healthyHome });
      await expect(healthyClassification).resolves.toMatchObject({
        result: { status: "peer-healthy", peer: { port: healthyReady.protocolPort } },
      });
      const healthyExit = exit(healthy);
      await send(healthy, { type: "stop" });
      await healthyExit;

      const staleHome = await syntheticHome("contention-stale");
      const killed = spawn("writer", staleHome);
      const killedReady = message(killed, "ready");
      await send(killed, { type: "start", home: staleHome, mode: "healthy" });
      await killedReady;
      const killedExit = exit(killed);
      killed.kill("SIGKILL");
      await killedExit;
      const successor = spawn("writer", staleHome);
      const successorReady = message<{ readonly rw: string }>(successor, "ready");
      await send(successor, { type: "start", home: staleHome, mode: "healthy" });
      await expect(successorReady).resolves.toMatchObject({ rw: "open" });
      const successorExit = exit(successor);
      await send(successor, { type: "stop" });
      await successorExit;

      const boundHome = await syntheticHome("contention-bound");
      const bound = spawn("writer", boundHome);
      const boundReady = message(bound, "ready");
      await send(bound, { type: "start", home: boundHome, mode: "bound" });
      await boundReady;
      const boundStarter = spawn("classify", boundHome);
      const boundClassification = message(boundStarter, "classification");
      await send(boundStarter, { type: "start", home: boundHome });
      await expect(boundClassification).resolves.toMatchObject({
        result: { status: "bound-unresponsive", stdout: "" },
      });
      const boundExit = exit(bound);
      await send(bound, { type: "stop" });
      await boundExit;

      const foreignHome = await syntheticHome("contention-foreign");
      const foreign = spawn("writer", foreignHome);
      const foreignReady = message(foreign, "ready");
      await send(foreign, { type: "start", home: foreignHome, mode: "foreign" });
      await foreignReady;
      const foreignStarter = spawn("classify", foreignHome);
      const foreignClassification = message(foreignStarter, "classification");
      await send(foreignStarter, { type: "start", home: foreignHome });
      await expect(foreignClassification).resolves.toMatchObject({
        result: { status: "foreign-port", stdout: "" },
      });
      const foreignExit = exit(foreign);
      await send(foreign, { type: "stop" });
      await foreignExit;
    },
  );
});
