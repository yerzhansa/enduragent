import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  archiveAndResetDurably,
  ChatStore,
  createChatStoreWithHooks,
  MAX_CHAT_SESSION_BYTES,
  TURN_FAILURE_MARKER,
} from "../src/agent/chat-store.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";
import { makeSummaryMessage } from "@enduragent/engine";

// ESM module namespaces are non-configurable, so vi.spyOn cannot intercept a
// named fs import. Mock the module up front: appendFileSync is a spy that
// delegates to the real implementation (captured inside the factory so it is
// not itself the mock) unless a test flips throwState.shouldThrow. vi.hoisted
// makes the spy + flag available to the hoisted vi.mock factory.
const { appendFileSyncSpy, throwState, fchmodThrowState } = vi.hoisted(() => ({
  appendFileSyncSpy: vi.fn(),
  throwState: { shouldThrow: null as (() => never) | null },
  fchmodThrowState: { shouldThrow: null as (() => never) | null },
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const realAppend = actual.appendFileSync;
  const realFchmod = actual.fchmodSync;
  appendFileSyncSpy.mockImplementation((path: string, data: string, opts?: unknown) => {
    if (throwState.shouldThrow) throwState.shouldThrow();
    return realAppend(path, data, opts as Parameters<typeof realAppend>[2]);
  });
  return {
    ...actual,
    appendFileSync: (...args: [string, string, unknown?]) => appendFileSyncSpy(...args),
    fchmodSync: (descriptor: number, mode: number) => {
      if (fchmodThrowState.shouldThrow) fchmodThrowState.shouldThrow();
      return realFchmod(descriptor, mode);
    },
  };
});

let dataDir: string;
let sessionsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-chat-store-"));
  sessionsDir = join(dataDir, "sessions");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  throwState.shouldThrow = null;
  fchmodThrowState.shouldThrow = null;
  appendFileSyncSpy.mockClear();
});

const LINEAGE = {
  templateHash: "t",
  assembledHash: "h",
  provider: "p",
  model: "m",
  lineageVersion: "1",
};
const DURABLE_RESET = {
  resetId: "d".repeat(64),
  boundaryAt: "2026-07-22T01:02:03.000Z",
};

function durableArchivePath(chatId: string): string {
  return join(
    sessionsDir,
    `${chatId}.jsonl.reset.${DURABLE_RESET.boundaryAt.replace(/:/g, "-")}.${DURABLE_RESET.resetId}`,
  );
}

function windowsSessionPath(chatId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(sessionsDir, `${digest}.jsonl`);
}

function windowsDurableArchivePath(chatId: string): string {
  return `${windowsSessionPath(chatId)}.reset.${DURABLE_RESET.boundaryAt.replace(/:/g, "-")}.${
    DURABLE_RESET.resetId
  }`;
}

function listArchives(chatId: string): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`${chatId}.jsonl.reset.`))
    .sort();
}

function listPrecompactArchives(chatId: string): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`${chatId}.jsonl.precompact.`))
    .sort();
}

const MS_PER_DAY = 86_400_000;

function plantArchive(chatId: string, date: Date, suffix = "reset"): string {
  const name = `${chatId}.jsonl.${suffix}.${date.toISOString().replace(/:/g, "-")}`;
  writeFileSync(join(sessionsDir, name), "{}\n", "utf-8");
  return name;
}

describe("ChatStore — on-disk permissions", () => {
  it("creates the sessions directory with owner-only 0o700", () => {
    new ChatStore(dataDir);

    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
  });

  it("appendMessage creates the session file with owner-only 0o600", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "How was my HRV this week?");

    expect(statSync(join(sessionsDir, "123.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("overwriteHistory writes the session file with owner-only 0o600", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "hello");
    store.overwriteHistory("123", [{ role: "assistant", content: "compacted" }]);

    expect(statSync(join(sessionsDir, "123.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("migrates a pre-existing permissive sessions directory to 0o700", () => {
    mkdirSync(sessionsDir, { mode: 0o755 });
    chmodSync(sessionsDir, 0o755);

    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "hello");

    expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o700);
    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf8")).toContain("hello");
  });

  it("migrates a group- and world-writable sessions directory, preserving its contents", () => {
    mkdirSync(sessionsDir, { mode: 0o777 });
    chmodSync(sessionsDir, 0o777);
    writeFileSync(join(sessionsDir, "123.jsonl"), '{"role":"user","content":"a","ts":"t"}\n', {
      mode: 0o600,
    });

    const store = new ChatStore(dataDir);

    expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o700);
    expect(store.hasSession("123")).toBe(true);
  });

  it("refuses when the migration cannot harden the directory", () => {
    mkdirSync(sessionsDir, { mode: 0o755 });
    chmodSync(sessionsDir, 0o755);
    fchmodThrowState.shouldThrow = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };

    expect(() => new ChatStore(dataDir)).toThrow("Sessions directory is unsafe.");
    expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o755);
  });

  it("refuses a symlinked sessions directory without following or repairing it", () => {
    const outside = join(dataDir, "synthetic-outside-sessions");
    mkdirSync(outside, { mode: 0o777 });
    chmodSync(outside, 0o777);
    symlinkSync(outside, sessionsDir);

    expect(() => new ChatStore(dataDir)).toThrow("Sessions directory is unsafe.");
    expect(lstatSync(sessionsDir).isSymbolicLink()).toBe(true);
    expect(lstatSync(outside).mode & 0o7777).toBe(0o777);
  });

  it("refuses a sessions path that is not a directory", () => {
    writeFileSync(sessionsDir, "synthetic not-a-directory\n", { mode: 0o600 });

    expect(() => new ChatStore(dataDir)).toThrow("Sessions directory is unsafe.");
    expect(lstatSync(sessionsDir).isFile()).toBe(true);
  });
});

describe("ChatStore — Windows private paths", () => {
  it("persists and reopens a session through injected Windows semantics", () => {
    const chatId = "telegram:synthetic-restart";
    const first = new ChatStore(dataDir, 0, { platform: "win32" });
    first.appendTurn(chatId, "synthetic athlete", "synthetic coach", LINEAGE);
    first.archivePreCompact(chatId);

    const reopened = new ChatStore(dataDir, 0, { platform: "win32" });

    expect(reopened.load(chatId).messages).toEqual([
      { role: "user", content: "synthetic athlete" },
      { role: "assistant", content: "synthetic coach" },
    ]);
    expect(readdirSync(sessionsDir)).toHaveLength(2);
    expect(
      readdirSync(sessionsDir).every((name) => /^[a-f0-9]{64}\.jsonl(?:\.|$)/.test(name)),
    ).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "does not inspect or repair POSIX modes under injected Windows semantics",
    () => {
      mkdirSync(sessionsDir, { mode: 0o755 });
      chmodSync(sessionsDir, 0o755);
      const path = windowsSessionPath("mode");
      writeFileSync(
        path,
        '{"role":"user","content":"synthetic","ts":"2026-07-22T00:00:00.000Z"}\n',
        { mode: 0o644 },
      );
      chmodSync(path, 0o644);

      const store = new ChatStore(dataDir, 0, { platform: "win32" });

      expect(store.load("mode").messages).toEqual([{ role: "user", content: "synthetic" }]);
      expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o755);
      expect(lstatSync(path).mode & 0o7777).toBe(0o644);
    },
  );

  it("rejects a replaced sessions directory as path-free corruption", () => {
    const store = new ChatStore(dataDir, 0, { platform: "win32" });
    store.appendTurn("directory-swap", "synthetic athlete", "synthetic coach", LINEAGE);
    const original = `${sessionsDir}.original`;
    renameSync(sessionsDir, original);
    mkdirSync(sessionsDir, { mode: 0o700 });

    let failure: unknown;
    try {
      store.load("directory-swap");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "binding-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(sessionsDir);
    expect(JSON.stringify(failure)).not.toContain(sessionsDir);
    expect(existsSync(join(original, basename(windowsSessionPath("directory-swap"))))).toBe(true);
  });

  it("rejects an oversized Windows session before allocating its contents", () => {
    const chatId = "telegram:synthetic-oversized";
    const store = new ChatStore(dataDir, 0, { platform: "win32" });
    store.appendTurn(chatId, "synthetic athlete", "synthetic coach", LINEAGE);
    const path = windowsSessionPath(chatId);
    truncateSync(path, MAX_CHAT_SESSION_BYTES + 1);

    let failure: unknown;
    try {
      store.load(chatId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
    expect(lstatSync(path).size).toBe(MAX_CHAT_SESSION_BYTES + 1);
  });

  it("rejects malformed Windows session content without quarantining or rewriting it", () => {
    const chatId = "telegram:synthetic-corrupt";
    const store = new ChatStore(dataDir, 0, { platform: "win32" });
    const path = windowsSessionPath(chatId);
    const corrupt = '{"role":"user","content":}\n';
    writeFileSync(path, corrupt, { mode: 0o600 });

    let loadFailure: unknown;
    try {
      store.load(chatId);
    } catch (error) {
      loadFailure = error;
    }
    let appendFailure: unknown;
    try {
      store.appendTurn(chatId, "synthetic athlete", "synthetic coach", LINEAGE);
    } catch (error) {
      appendFailure = error;
    }

    for (const failure of [loadFailure, appendFailure]) {
      expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
      expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
      expect(failure).not.toHaveProperty("path");
      expect(failure).not.toHaveProperty("cause");
      expect(String(failure)).not.toContain(path);
      expect(JSON.stringify(failure)).not.toContain(path);
    }
    expect(readFileSync(path, "utf8")).toBe(corrupt);
    expect(readdirSync(sessionsDir)).toEqual([basename(path)]);
  });

  it("classifies directory sync as unavailable while retaining file flushes", () => {
    const syncDirectory = vi.fn(() => {
      throw new Error("Windows directory sync hook must not run");
    });
    const syncFile = vi.fn((descriptor: number) => fsyncSync(descriptor));
    const store = createChatStoreWithHooks(
      dataDir,
      0,
      { syncDirectory, syncFile },
      { platform: "win32" },
    );
    store.appendTurn("durable", "synthetic athlete", "synthetic coach", LINEAGE);

    archiveAndResetDurably(store, "durable", DURABLE_RESET);

    expect(syncDirectory).not.toHaveBeenCalled();
    expect(syncFile).toHaveBeenCalledTimes(2);
    expect(existsSync(windowsDurableArchivePath("durable"))).toBe(true);
  });

  it("opens copied and reset session targets with writable Windows flush handles", () => {
    let syncs = 0;
    const store = createChatStoreWithHooks(
      dataDir,
      0,
      {
        syncFile: (descriptor) => {
          syncs += 1;
          if (syncs > 1) {
            const firstByte = Buffer.allocUnsafe(1);
            expect(readSync(descriptor, firstByte, 0, 1, 0)).toBe(1);
            expect(writeSync(descriptor, firstByte, 0, 1, 0)).toBe(1);
          }
          fsyncSync(descriptor);
        },
      },
      { platform: "win32" },
    );
    store.appendTurn("writable-flush", "synthetic athlete", "synthetic coach", LINEAGE);

    store.archivePreCompact("writable-flush");
    archiveAndResetDurably(store, "writable-flush", DURABLE_RESET);

    expect(syncs).toBe(3);
    expect(existsSync(windowsDurableArchivePath("writable-flush"))).toBe(true);
  });

  it("rejects a hardlinked active session as path-free corruption", () => {
    const store = new ChatStore(dataDir, 0, { platform: "win32" });
    store.appendTurn("linked", "synthetic athlete", "synthetic coach", LINEAGE);
    const active = windowsSessionPath("linked");
    linkSync(active, join(dataDir, "synthetic-shared-session.jsonl"));

    let failure: unknown;
    try {
      archiveAndResetDurably(store, "linked", DURABLE_RESET);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "binding-check", category: "corruption" });
    expect(String(failure)).not.toContain(active);
    expect(JSON.stringify(failure)).not.toContain(active);
  });

  it("does not swallow a Windows sharing violation during file flush", () => {
    const active = windowsSessionPath("locked");
    let syncs = 0;
    const store = createChatStoreWithHooks(
      dataDir,
      0,
      {
        syncFile: (descriptor) => {
          syncs += 1;
          if (syncs === 2) {
            throw Object.assign(new Error(`locked ${active}`), { code: "EACCES", path: active });
          }
          fsyncSync(descriptor);
        },
      },
      { platform: "win32" },
    );
    store.appendTurn("locked", "synthetic athlete", "synthetic coach", LINEAGE);

    let failure: unknown;
    try {
      archiveAndResetDurably(store, "locked", DURABLE_RESET);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "file-flush", category: "sharing-violation" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(active);
    expect(JSON.stringify(failure)).not.toContain(active);
  });

  it("does not swallow a Windows sharing violation during archive rename", () => {
    const active = windowsSessionPath("rename-locked");
    const store = createChatStoreWithHooks(
      dataDir,
      0,
      {
        rename: () => {
          throw Object.assign(new Error(`locked ${active}`), { code: "EACCES", path: active });
        },
      },
      { platform: "win32" },
    );
    store.appendTurn("rename-locked", "synthetic athlete", "synthetic coach", LINEAGE);

    let failure: unknown;
    try {
      store.archiveAndReset("rename-locked");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "rename", category: "sharing-violation" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(active);
    expect(JSON.stringify(failure)).not.toContain(active);
    expect(existsSync(active)).toBe(true);
  });
});

describe("ChatStore durable reset — private race-checked targets", () => {
  it("archives one exact 0600 session from an exact 0700 directory without changing bytes", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("safe", "synthetic user", "synthetic assistant", LINEAGE);
    const active = join(sessionsDir, "safe.jsonl");
    const before = readFileSync(active);

    archiveAndResetDurably(store, "safe", DURABLE_RESET);

    const archive = durableArchivePath("safe");
    expect(existsSync(active)).toBe(false);
    expect(readFileSync(archive)).toEqual(before);
    expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(archive).mode & 0o7777).toBe(0o600);
    expect(lstatSync(archive).nlink).toBe(1);
  });

  it("marks a flush-pending archive, serves it oldest first, and clears it on flush or delete", () => {
    const store = new ChatStore(dataDir);
    const older = { resetId: "a".repeat(64), boundaryAt: "2026-07-21T01:02:03.000Z" };
    const ref = (reset: typeof older) =>
      `${reset.boundaryAt.replace(/:/g, "-")}.${reset.resetId}`;
    const marker = (reset: typeof older) =>
      join(sessionsDir, `pending.jsonl.flush-pending.${ref(reset)}`);
    store.appendTurn("pending", "synthetic older user", "synthetic older coach", LINEAGE);
    archiveAndResetDurably(store, "pending", { ...older, flushPending: true });
    store.appendTurn("pending", "synthetic newer user", "synthetic newer coach", LINEAGE);
    archiveAndResetDurably(store, "pending", { ...DURABLE_RESET, flushPending: true });
    store.appendTurn("pending", "synthetic flushed user", "synthetic flushed coach", LINEAGE);
    archiveAndResetDurably(store, "pending", {
      resetId: "f".repeat(64),
      boundaryAt: "2026-07-23T01:02:03.000Z",
    });

    expect(existsSync(marker(older))).toBe(true);
    expect(existsSync(marker(DURABLE_RESET))).toBe(true);
    expect(listArchives("pending")).toHaveLength(3);
    expect(readdirSync(sessionsDir).filter((f) => f.includes("flush-pending"))).toHaveLength(2);

    const first = store.loadUnflushedResetArchive("pending");
    expect(first?.archiveRef).toBe(ref(older));
    expect(first?.messages.map((m) => m.content)).toEqual([
      "synthetic older user",
      "synthetic older coach",
    ]);

    store.markResetArchiveFlushed("pending", ref(older));
    expect(existsSync(marker(older))).toBe(false);
    expect(store.loadUnflushedResetArchive("pending")?.archiveRef).toBe(ref(DURABLE_RESET));

    expect(
      store.deleteResetArchive("pending", DURABLE_RESET.resetId, DURABLE_RESET.boundaryAt),
    ).toBe(true);
    expect(existsSync(marker(DURABLE_RESET))).toBe(false);
    expect(store.loadUnflushedResetArchive("pending")).toBeNull();
    expect(() => store.markResetArchiveFlushed("pending", "../escape")).toThrow(
      "Reset archive reference is invalid.",
    );
  });

  it("drops a flush-pending marker whose archive is gone", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("orphan", "synthetic user", "synthetic coach", LINEAGE);
    archiveAndResetDurably(store, "orphan", { ...DURABLE_RESET, flushPending: true });
    rmSync(durableArchivePath("orphan"));

    expect(store.loadUnflushedResetArchive("orphan")).toBeNull();
    expect(readdirSync(sessionsDir).filter((f) => f.includes("flush-pending"))).toHaveLength(0);
  });

  it("refuses a permissive active file without chmodding or archiving it", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("permissive", "synthetic user", "synthetic assistant", LINEAGE);
    const active = join(sessionsDir, "permissive.jsonl");
    const before = readFileSync(active);
    chmodSync(active, 0o644);

    expect(() => archiveAndResetDurably(store, "permissive", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(readFileSync(active)).toEqual(before);
    expect(lstatSync(active).mode & 0o7777).toBe(0o644);
    expect(existsSync(durableArchivePath("permissive"))).toBe(false);
  });

  it("refuses symbolic and non-regular active reset targets", () => {
    const store = new ChatStore(dataDir);
    const outside = join(dataDir, "synthetic-outside.jsonl");
    writeFileSync(outside, "synthetic outside\n", { mode: 0o600 });
    symlinkSync(outside, join(sessionsDir, "symbolic.jsonl"));
    mkdirSync(join(sessionsDir, "non-regular.jsonl"), { mode: 0o700 });

    expect(() => archiveAndResetDurably(store, "symbolic", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(() => archiveAndResetDurably(store, "non-regular", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(readFileSync(outside, "utf8")).toBe("synthetic outside\n");
    expect(lstatSync(join(sessionsDir, "symbolic.jsonl")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(sessionsDir, "non-regular.jsonl")).isDirectory()).toBe(true);
  });

  it("refuses an unexpected active link count", () => {
    const store = new ChatStore(dataDir);
    const active = join(sessionsDir, "linked.jsonl");
    writeFileSync(active, "synthetic linked session\n", { mode: 0o600 });
    linkSync(active, join(dataDir, "synthetic-shared-session.jsonl"));

    expect(() => archiveAndResetDurably(store, "linked", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(lstatSync(active).nlink).toBe(2);
    expect(existsSync(durableArchivePath("linked"))).toBe(false);
  });

  it("refuses a permissive completed archive without repairing it", () => {
    const store = new ChatStore(dataDir);
    const archive = durableArchivePath("archive-mode");
    writeFileSync(archive, "synthetic archive\n", { mode: 0o644 });
    chmodSync(archive, 0o644);

    expect(() => archiveAndResetDurably(store, "archive-mode", DURABLE_RESET)).toThrow(
      "Reset archive target is unsafe.",
    );
    expect(lstatSync(archive).mode & 0o7777).toBe(0o644);
  });

  it("rechecks sessions directory mode and identity before durable reset", () => {
    const modeStore = new ChatStore(dataDir);
    modeStore.appendTurn("mode-drift", "synthetic user", "synthetic assistant", LINEAGE);
    chmodSync(sessionsDir, 0o755);

    expect(() => archiveAndResetDurably(modeStore, "mode-drift", DURABLE_RESET)).toThrow(
      "Sessions directory is unsafe.",
    );
    expect(existsSync(join(sessionsDir, "mode-drift.jsonl"))).toBe(true);

    chmodSync(sessionsDir, 0o700);
    const identityStore = new ChatStore(dataDir);
    identityStore.appendTurn("identity-drift", "synthetic user", "synthetic assistant", LINEAGE);
    renameSync(sessionsDir, `${sessionsDir}.original`);
    mkdirSync(sessionsDir, { mode: 0o700 });

    expect(() => archiveAndResetDurably(identityStore, "identity-drift", DURABLE_RESET)).toThrow(
      "Sessions directory is unsafe.",
    );
    expect(existsSync(join(`${sessionsDir}.original`, "identity-drift.jsonl"))).toBe(true);
    expect(readdirSync(sessionsDir)).toEqual([]);
  });
});

describe("ChatStore.archiveAndReset — archive retention", () => {
  it("archives the live session exactly once and clears it", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "hello");

    store.archiveAndReset("123");

    expect(store.hasSession("123")).toBe(false);
    expect(listArchives("123")).toHaveLength(1);
  });

  it("keeps every archive by default — count-based pruning is gone", () => {
    const store = new ChatStore(dataDir);
    const planted = Array.from({ length: 25 }, (_, i) => {
      const name = `123.jsonl.reset.2026-06-01T00-00-${String(i).padStart(2, "0")}.000Z`;
      writeFileSync(join(sessionsDir, name), "{}\n", "utf-8");
      return name;
    });

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    const archives = listArchives("123");
    expect(archives).toHaveLength(26);
    for (const kept of planted) {
      expect(archives).toContain(kept);
    }
  });

  it("is a no-op when no live session exists", () => {
    const store = new ChatStore(dataDir);

    store.archiveAndReset("123");

    expect(existsSync(join(sessionsDir, "123.jsonl"))).toBe(false);
    expect(listArchives("123")).toHaveLength(0);
  });
});

describe("ChatStore.archiveAndReset — opt-in age-based retention", () => {
  it("deletes archives older than the horizon and keeps newer ones", () => {
    const store = new ChatStore(dataDir, 365);
    const old = plantArchive("123", new Date(Date.now() - 366 * MS_PER_DAY));
    const recent = plantArchive("123", new Date(Date.now() - 1 * MS_PER_DAY));

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    const archives = listArchives("123");
    expect(archives).not.toContain(old);
    expect(archives).toContain(recent);
    expect(archives).toHaveLength(2);
  });

  it("never deletes an archive whose timestamp suffix cannot be parsed", () => {
    const store = new ChatStore(dataDir, 1);
    const odd = "123.jsonl.reset.not-a-timestamp";
    writeFileSync(join(sessionsDir, odd), "{}\n", "utf-8");

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("123")).toContain(odd);
  });

  it("prunes only the resetting chat's archives", () => {
    const store = new ChatStore(dataDir, 1);
    const otherOld = plantArchive("456", new Date(Date.now() - 400 * MS_PER_DAY));

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("456")).toContain(otherOld);
  });

  it("does not prune even ancient archives when retention is disabled", () => {
    const store = new ChatStore(dataDir);
    const ancient = plantArchive("123", new Date(Date.now() - 4000 * MS_PER_DAY));

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("123")).toContain(ancient);
  });
});

describe("ChatStore.archivePreCompact — pre-compaction archives", () => {
  it("copies the session file, leaving the original intact", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "precious context");

    store.archivePreCompact("123");

    expect(store.hasSession("123")).toBe(true);
    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf-8")).toContain("precious context");
    const archives = listPrecompactArchives("123");
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(sessionsDir, archives[0]), "utf-8")).toContain("precious context");
  });

  it("writes the archive with owner-only 0o600", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "precious context");

    store.archivePreCompact("123");

    const archives = listPrecompactArchives("123");
    expect(statSync(join(sessionsDir, archives[0])).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when no live session exists", () => {
    const store = new ChatStore(dataDir);

    store.archivePreCompact("ghost");

    expect(existsSync(join(sessionsDir, "ghost.jsonl"))).toBe(false);
    expect(listPrecompactArchives("ghost")).toHaveLength(0);
  });

  it("never prunes pre-compaction archives when retention is disabled", () => {
    const store = new ChatStore(dataDir);
    const old = plantArchive("123", new Date(Date.now() - 40 * MS_PER_DAY), "precompact");

    store.appendMessage("123", "user", "hello");
    store.archivePreCompact("123");

    expect(listPrecompactArchives("123")).toContain(old);
  });

  it("prunes only its own suffix when opt-in retention is active", () => {
    const store = new ChatStore(dataDir, 30);
    const oldPrecompact = plantArchive("123", new Date(Date.now() - 40 * MS_PER_DAY), "precompact");
    const oldReset = plantArchive("123", new Date(Date.now() - 40 * MS_PER_DAY), "reset");

    store.appendMessage("123", "user", "hello");
    store.archivePreCompact("123");

    expect(listPrecompactArchives("123")).not.toContain(oldPrecompact);
    expect(listPrecompactArchives("123")).toHaveLength(1);
    expect(listArchives("123")).toContain(oldReset);

    store.archiveAndReset("123");

    expect(listArchives("123")).not.toContain(oldReset);
    expect(listPrecompactArchives("123")).toHaveLength(1);
  });
});

describe("ChatStore.appendTurn — single-buffer atomic two-line append", () => {
  it("issues exactly one appendFileSync writing both the user and assistant line", () => {
    const store = new ChatStore(dataDir);
    appendFileSyncSpy.mockClear();

    store.appendTurn("c1", "u", "a", LINEAGE);

    // The ChatStore constructor's mkdir does not append, so the only append in
    // this turn is appendTurn's single write.
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
    const buffer = appendFileSyncSpy.mock.calls[0][1] as string;
    expect(buffer).toContain('"role":"user"');
    expect(buffer).toContain('"role":"assistant"');

    const { messages } = store.load("c1");
    expect(messages).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("throws on an fs error and leaves no dangling user line", () => {
    const store = new ChatStore(dataDir);
    throwState.shouldThrow = () => {
      throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
    };

    expect(() => store.appendTurn("c1", "u", "a", LINEAGE)).toThrow();

    throwState.shouldThrow = null;
    expect(existsSync(join(sessionsDir, "c1.jsonl"))).toBe(false);
    expect(store.load("c1").messages).toEqual([]);
  });
});

describe("ChatStore — empty assistant guard", () => {
  function assistantCount(store: ChatStore, chatId: string): number {
    return store.load(chatId).messages.filter((m) => m.role === "assistant").length;
  }

  it("appendTurn with empty assistant content writes no assistant line", () => {
    const store = new ChatStore(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendTurn("g", "user text", "", LINEAGE);
    expect(assistantCount(store, "g")).toBe(0);
  });

  it("appendTurn with whitespace-only assistant content is treated as empty", () => {
    const store = new ChatStore(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendTurn("g", "user text", "   \n  ", LINEAGE);
    expect(assistantCount(store, "g")).toBe(0);
  });

  it("appendTurn with real assistant content persists normally", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("g2", "u", "real reply", LINEAGE);
    const assistants = store.load("g2").messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("real reply");
  });

  it('appendMessage("assistant", "") writes nothing', () => {
    const store = new ChatStore(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendMessage("g3", "assistant", "");
    expect(assistantCount(store, "g3")).toBe(0);
  });
});

describe("ChatStore.overwriteHistory — timestamp preservation", () => {
  const OLD_TS = "1998-03-01T10:00:00.000Z";

  function rawLines(chatId: string): Array<{ role: string; content: string; ts: string }> {
    return readFileSync(join(sessionsDir, `${chatId}.jsonl`), "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { role: string; content: string; ts: string });
  }

  it("keeps a surviving message's original ts and stamps summary lines fresh", () => {
    const store = new ChatStore(dataDir);
    writeFileSync(
      join(sessionsDir, "ts.jsonl"),
      JSON.stringify({ role: "user", content: "keep me", ts: OLD_TS }) +
        "\n" +
        JSON.stringify({ role: "assistant", content: "kept reply", ts: OLD_TS }) +
        "\n",
      "utf-8",
    );

    const before = Date.now();
    store.overwriteHistory("ts", [
      makeSummaryMessage("older stuff summarized"),
      { role: "user", content: "keep me" },
      { role: "assistant", content: "kept reply" },
    ]);

    const lines = rawLines("ts");
    const summary = lines.find((l) => l.role === "system")!;
    const user = lines.find((l) => l.role === "user")!;
    const assistant = lines.find((l) => l.role === "assistant")!;
    expect(user.ts).toBe(OLD_TS);
    expect(assistant.ts).toBe(OLD_TS);
    expect(Date.parse(summary.ts)).toBeGreaterThanOrEqual(before);
  });

  it("stamps a brand-new (non-surviving) message with a fresh ts", () => {
    const store = new ChatStore(dataDir);
    writeFileSync(
      join(sessionsDir, "ts2.jsonl"),
      JSON.stringify({ role: "user", content: "original", ts: OLD_TS }) + "\n",
      "utf-8",
    );
    const before = Date.now();
    store.overwriteHistory("ts2", [{ role: "assistant", content: "totally new" }]);
    expect(Date.parse(rawLines("ts2")[0].ts)).toBeGreaterThanOrEqual(before);
  });
});

describe("ChatStore.appendFailureMarker", () => {
  it("appends a system failure marker after a durable user line", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("f1", "user", "remember I hate hills");
    store.appendFailureMarker("f1");
    const { messages } = store.load("f1");
    expect(messages).toEqual([
      { role: "user", content: "remember I hate hills" },
      { role: "system", content: TURN_FAILURE_MARKER },
    ]);
  });

  it("is a no-op when no session file exists", () => {
    const store = new ChatStore(dataDir);
    store.appendFailureMarker("ghost");
    expect(existsSync(join(sessionsDir, "ghost.jsonl"))).toBe(false);
  });
});
