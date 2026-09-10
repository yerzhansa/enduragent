import { createConnection, createServer } from "node:net";
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HANDOFF_RESERVED_MESSAGE,
  UPGRADE_FENCE_FRAME_MAX_BYTES,
  UPGRADE_FENCE_IO_TIMEOUT_MS,
  UPGRADE_FENCE_SOCKET_NAME,
  acquireUpgradeFence,
  admitStartupThroughUpgradeFence,
  type MonotonicTimer,
  type ScheduledMonotonicTimer,
} from "../src/daemon/upgrade-fence.js";
import {
  WINDOWS_UPGRADE_FENCE_CLAIM_NAME,
  acquireWindowsUpgradeFence,
} from "../src/daemon/windows-upgrade-fence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configDir(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "upgrade-fence-"));
  roots.push(root);
  return join(root, "config");
}

class FakeTimer implements MonotonicTimer {
  private now = 0;
  private scheduleCount = 0;
  private readonly scheduleWaiters = new Set<{
    readonly after: number;
    readonly resolve: () => void;
  }>();
  private readonly scheduled = new Set<{
    readonly at: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  nowMs(): number {
    return this.now;
  }

  schedule(delayMs: number, callback: () => void): ScheduledMonotonicTimer {
    const item = { at: this.now + delayMs, callback, cancelled: false };
    this.scheduled.add(item);
    this.scheduleCount += 1;
    for (const waiter of this.scheduleWaiters) {
      if (this.scheduleCount > waiter.after) {
        this.scheduleWaiters.delete(waiter);
        waiter.resolve();
      }
    }
    return {
      cancel: () => {
        item.cancelled = true;
        this.scheduled.delete(item);
      },
    };
  }

  waitForScheduleAfter(count: number): Promise<void> {
    if (this.scheduleCount > count) return Promise.resolve();
    return new Promise((resolve) => this.scheduleWaiters.add({ after: count, resolve }));
  }

  get totalSchedules(): number {
    return this.scheduleCount;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const item of this.scheduled) {
      if (!item.cancelled && item.at <= this.now) {
        this.scheduled.delete(item);
        item.callback();
      }
    }
  }
}

function rawAdmission(socketPath: string, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => socket.end(bytes));
  });
}

async function unixSocketAvailable(): Promise<boolean> {
  const path = join(await realpath(tmpdir()), `upgrade-fence-preflight-${process.pid}.sock`);
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER unix-listen EPERM upgrade-fence\n");
      }
      resolve(false);
    });
    server.listen(path, () => server.close(() => resolve(true)));
  });
}

const hasUnixSockets = await unixSocketAvailable();

describe("upgrade fence platform dispatch", () => {
  it("routes acquisition to the Windows claim-file transport", async () => {
    const dir = await configDir();
    const acquired = await acquireUpgradeFence({ configDir: dir, platform: "win32" });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    try {
      const claimPath = join(dir, WINDOWS_UPGRADE_FENCE_CLAIM_NAME);
      expect(acquired.handle.socketPath).toBe(claimPath);
      expect((await lstat(claimPath)).isFile()).toBe(true);
      await expect(lstat(join(dir, UPGRADE_FENCE_SOCKET_NAME))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await acquired.handle.release();
    }
  });

  it("routes admission to the Windows claim-file transport", async () => {
    const dir = await configDir();
    const acquired = await acquireWindowsUpgradeFence({ configDir: dir });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    try {
      expect((await lstat(join(dir, WINDOWS_UPGRADE_FENCE_CLAIM_NAME))).isFile()).toBe(true);
      await expect(
        admitStartupThroughUpgradeFence({
          configDir: dir,
          platform: "win32",
        }),
      ).resolves.toEqual({
        status: "reserved",
        exitCode: 3,
        message: HANDOFF_RESERVED_MESSAGE,
      });
      await expect(lstat(join(dir, UPGRADE_FENCE_SOCKET_NAME))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await acquired.handle.release();
    }
  });
});

describe.skipIf(!hasUnixSockets)("upgrade fence", () => {
  it.skipIf(process.platform !== "darwin")("reports an unusably long socket path", async () => {
    const dir = join(await configDir(), "a".repeat(104));
    expect(Buffer.byteLength(join(dir, UPGRADE_FENCE_SOCKET_NAME))).toBeGreaterThan(104);
    await expect(admitStartupThroughUpgradeFence({ configDir: dir })).rejects.toThrow(
      "upgrade fence socket path is too long for a Unix socket on this platform",
    );
  });

  it("refuses ordinary and wrong callers, admits one designated capability, and rejects replay", async () => {
    const dir = await configDir();
    const acquired = await acquireUpgradeFence({
      configDir: dir,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    expect(await admitStartupThroughUpgradeFence({ configDir: dir })).toEqual({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    expect(
      await admitStartupThroughUpgradeFence({
        configDir: dir,
        handoffCapability: Buffer.alloc(32, 8).toString("base64url"),
      }),
    ).toMatchObject({ status: "reserved" });
    await expect(
      admitStartupThroughUpgradeFence({
        configDir: dir,
        handoffCapability: acquired.handle.handoffCapability,
      }),
    ).resolves.toEqual({ status: "designated" });
    await expect(
      admitStartupThroughUpgradeFence({
        configDir: dir,
        handoffCapability: acquired.handle.handoffCapability,
      }),
    ).resolves.toMatchObject({ status: "reserved" });
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(acquired.handle.socketPath)).mode & 0o777).toBe(0o600);
    await acquired.handle.release();
    await acquired.handle.release();
    await expect(admitStartupThroughUpgradeFence({ configDir: dir })).resolves.toEqual({
      status: "clear",
    });
  });

  it("enforces byte boundaries and the incomplete-frame monotonic deadline", async () => {
    const dir = await configDir();
    const timer = new FakeTimer();
    const acquired = await acquireUpgradeFence({ configDir: dir, timer });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    const ordinary = JSON.stringify({ kind: "ordinary-starter" });
    const exact = Buffer.from(`${ordinary.padEnd(UPGRADE_FENCE_FRAME_MAX_BYTES - 1, " ")}\n`);
    expect(exact.length).toBe(UPGRADE_FENCE_FRAME_MAX_BYTES);
    await expect(rawAdmission(acquired.handle.socketPath, exact)).resolves.toBe(
      `${JSON.stringify({ status: "reserved" })}\n`,
    );
    const oversized = Buffer.from(`${ordinary.padEnd(UPGRADE_FENCE_FRAME_MAX_BYTES, " ")}\n`);
    expect(oversized.length).toBe(UPGRADE_FENCE_FRAME_MAX_BYTES + 1);
    await expect(rawAdmission(acquired.handle.socketPath, oversized)).resolves.toBe(
      `${JSON.stringify({ status: "reserved" })}\n`,
    );
    const incompleteBytes = Buffer.alloc(UPGRADE_FENCE_FRAME_MAX_BYTES - 1, "é");
    expect(incompleteBytes.length).toBe(UPGRADE_FENCE_FRAME_MAX_BYTES - 1);
    const priorSchedules = timer.totalSchedules;
    const incomplete = rawAdmission(acquired.handle.socketPath, incompleteBytes);
    await timer.waitForScheduleAfter(priorSchedules);
    timer.advance(UPGRADE_FENCE_IO_TIMEOUT_MS);
    await expect(incomplete).resolves.toBe(`${JSON.stringify({ status: "reserved" })}\n`);
    await acquired.handle.release();
  });

  it("does not unlink a replacement socket-path inode during release", async () => {
    const dir = await configDir();
    const acquired = await acquireUpgradeFence({ configDir: dir });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    const moved = `${acquired.handle.socketPath}.moved`;
    await rename(acquired.handle.socketPath, moved);
    await writeFile(acquired.handle.socketPath, "replacement\n", { mode: 0o600 });
    await acquired.handle.release();
    await expect(readFile(acquired.handle.socketPath, "utf8")).resolves.toBe("replacement\n");
  });
});
