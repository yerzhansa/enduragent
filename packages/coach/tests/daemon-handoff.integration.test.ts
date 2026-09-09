import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { HANDOFF_RESERVED_MESSAGE } from "../src/daemon/handshake.js";

const fixture = fileURLToPath(new URL("./fixtures/daemon-process.ts", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function syntheticHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-handoff-"));
  roots.push(root);
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

function spawn(role: string, home: AthleteHome): ChildProcess {
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
    env[name] = home.root;
  }
  const child = fork(fixture, [role], {
    execArgv: ["--import", "tsx"],
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function nextMessage<T>(child: ChildProcess, type: string): Promise<T> {
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

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function unixSocketAvailable(): Promise<boolean> {
  const path = join(await realpath(tmpdir()), `handoff-preflight-${process.pid}.sock`);
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER unix-listen EPERM daemon-handoff\n");
      }
      resolve(false);
    });
    server.listen(path, () => server.close(() => resolve(true)));
  });
}

const hasUnixSockets = await unixSocketAvailable();

describe.skipIf(!hasUnixSockets)("real successor-held handoff fence", () => {
  it("reserves every third starter, consumes one capability, coalesces controllers, and crash-releases", async () => {
    const home = await syntheticHome();
    const events: Array<{ readonly name: string; readonly at: number }> = [];
    const holder = spawn("fence-holder", home);
    const holderReady = nextMessage<{
      readonly result: {
        readonly status: "acquired";
        readonly handoffCapability: string;
      };
    }>(holder, "fence");
    await send(holder, { type: "start", home });
    const fence = await holderReady;
    events.push({ name: "fence-acquired", at: performance.now() });

    const ordinary = spawn("fence-admit", home);
    const ordinaryResult = nextMessage<{
      readonly result: {
        readonly status: string;
        readonly exitCode: number;
        readonly message: string;
      };
    }>(ordinary, "admission");
    await send(ordinary, { type: "start", home });
    await expect(ordinaryResult).resolves.toMatchObject({
      result: {
        status: "reserved",
        exitCode: 3,
        message: HANDOFF_RESERVED_MESSAGE,
      },
    });

    const designated = spawn("fence-admit", home);
    const designatedResult = nextMessage(designated, "admission");
    await send(designated, {
      type: "start",
      home,
      handoffCapability: fence.result.handoffCapability,
    });
    await expect(designatedResult).resolves.toMatchObject({
      result: { status: "designated" },
    });
    events.push({ name: "designated-admitted", at: performance.now() });

    const replay = spawn("fence-admit", home);
    const concurrentController = spawn("fence-admit", home);
    const replayResult = nextMessage(replay, "admission");
    const concurrentResult = nextMessage(concurrentController, "admission");
    await Promise.all([
      send(replay, {
        type: "start",
        home,
        handoffCapability: fence.result.handoffCapability,
      }),
      send(concurrentController, { type: "start", home }),
    ]);
    await expect(replayResult).resolves.toMatchObject({ result: { status: "reserved" } });
    const losing = (await concurrentResult) as {
      readonly result: { readonly status: string; readonly message: string };
    };
    expect(losing.result).toMatchObject({
      status: "reserved",
      message: HANDOFF_RESERVED_MESSAGE,
    });
    expect(losing.result.message).not.toContain("handoff-reservation-refused");

    const holderExit = exited(holder);
    holder.kill("SIGKILL");
    await holderExit;
    events.push({ name: "fence-crashed", at: performance.now() });
    const recovery = spawn("fence-admit", home);
    const recoveryResult = nextMessage(recovery, "admission");
    await send(recovery, { type: "start", home });
    await expect(recoveryResult).resolves.toMatchObject({ result: { status: "clear" } });
    events.push({ name: "recovery-clear", at: performance.now() });
    expect(events.map((event) => event.name)).toEqual([
      "fence-acquired",
      "designated-admitted",
      "fence-crashed",
      "recovery-clear",
    ]);
    expect(events.every((event, index) => index === 0 || event.at >= events[index - 1]!.at)).toBe(
      true,
    );
  });
});
