import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteJson, enqueueCommit } from "../src/io/atomic-write-json.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ref-atomic-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("atomicWriteJson — happy path", () => {
  it("writes JSON-serialized value to the target path", async () => {
    const target = join(tempDir, "cache.json");
    const payload = { name: "Reference", count: 3, when: "2026-05-09" };

    await atomicWriteJson(target, payload);

    expect(existsSync(target)).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual(payload);
  });

  it("formats output with 2-space indentation for human inspection", async () => {
    const target = join(tempDir, "pretty.json");
    await atomicWriteJson(target, { a: 1, nested: { b: 2 } });

    const raw = readFileSync(target, "utf-8");
    expect(raw).toContain("  ");
    expect(raw).toContain("\n");
  });

  it("overwrites a pre-existing file with the new value", async () => {
    const target = join(tempDir, "replaceable.json");
    writeFileSync(target, JSON.stringify({ old: true }), "utf-8");

    await atomicWriteJson(target, { fresh: 42 });

    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual({ fresh: 42 });
  });

  it.runIf(process.platform !== "win32")(
    "creates the target with owner-only 0o600 permissions",
    async () => {
      const target = join(tempDir, "private.json");
      await atomicWriteJson(target, { hrv: 62 });

      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "tightens a pre-existing world-readable target to 0o600 on overwrite",
    async () => {
      const target = join(tempDir, "was-readable.json");
      writeFileSync(target, JSON.stringify({ old: true }), { encoding: "utf-8", mode: 0o644 });

      await atomicWriteJson(target, { fresh: true });

      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it("handles repeated writes without leaving dangling temp files", async () => {
    const target = join(tempDir, "repeated.json");
    for (let i = 0; i < 5; i++) {
      await atomicWriteJson(target, { iter: i });
    }
    const entries = readdirSync(tempDir);
    expect(entries).toContain("repeated.json");
    // No `repeated.json.tmp.*` siblings should linger on a clean run.
    const orphans = entries.filter((e) => e.startsWith("repeated.json.tmp"));
    expect(orphans).toEqual([]);
  });

  it("keeps Windows write failures path-free and stage-coded", async () => {
    const target = join(tempDir, "missing", "private-athlete.json");
    const failure = await atomicWriteJson(target, { private: true }, { platform: "win32" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "content-write", category: "io-failure" });
    expect(String(failure)).not.toContain(target);
    expect(JSON.stringify(failure)).not.toContain(target);
  });

  it("keeps Windows rename failures path-free and stage-coded", async () => {
    const target = join(tempDir, "existing-directory");
    mkdirSync(target);
    const failure = await atomicWriteJson(target, { private: true }, { platform: "win32" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "rename", category: "io-failure" });
    expect(String(failure)).not.toContain(target);
    expect(JSON.stringify(failure)).not.toContain(target);
  });
});

describe("atomicWriteJson — atomicity invariant", () => {
  it("commits the canonical target through the asynchronous rename primitive", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const rename = vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args));
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, rename }));
    try {
      const { atomicWriteJson: isolatedAtomicWriteJson } =
        await import("../src/io/atomic-write-json.js");
      const target = join(tempDir, "asynchronous-commit.json");
      await isolatedAtomicWriteJson(target, { committed: true });
      expect(rename).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ committed: true });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("serializes same-path commits so an in-flight rename blocks a later writer's commit", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let renameCalls = 0;
    const rename = vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      renameCalls += 1;
      if (renameCalls === 1) await firstGate;
      return actual.rename(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, rename }));
    try {
      const { atomicWriteJson: isolatedAtomicWriteJson } =
        await import("../src/io/atomic-write-json.js");
      const target = join(tempDir, "serialized.json");
      const first = isolatedAtomicWriteJson(target, { gen: 1 });
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      const second = isolatedAtomicWriteJson(target, { gen: 2 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(rename).toHaveBeenCalledTimes(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(rename).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ gen: 2 });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("skips a queued commit whose signal aborted while an earlier commit was in flight", async () => {
    const target = join(tempDir, "fenced.json");
    await atomicWriteJson(target, { live: true });

    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const blocked = enqueueCommit(target, () => queueGate);

    const controller = new AbortController();
    const stale = atomicWriteJson(target, { stale: true }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    releaseQueue();
    await blocked;
    await expect(stale).resolves.toBeUndefined();

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ live: true });
    const orphans = readdirSync(tempDir).filter((e) => e.includes(".tmp."));
    expect(orphans).toEqual([]);
  });

  it("writes via a temp sibling so the original is never partial mid-write", async () => {
    // We can't reliably crash mid-rename in a unit test, but we can assert the
    // canonical pattern: between the moment data is committed to disk and the
    // moment the target is replaced, the data lives at a *.tmp.* sibling.
    // We observe this by listing the directory while a write is in flight.
    // Since atomicWriteJson is async, we kick it off and snapshot mid-write.
    //
    // Pragmatic alternative: check that the final on-disk content matches an
    // atomic write expectation — exactly one file at the target path with full
    // valid JSON (never partial). Repeated rapid writes never produce partial
    // reads if atomicity holds.
    const target = join(tempDir, "concurrent.json");
    const writes = Array.from({ length: 10 }, (_, i) =>
      atomicWriteJson(target, { gen: i, payload: "x".repeat(1024) }),
    );
    await Promise.all(writes);

    // Final content must parse cleanly — never half-written.
    const raw = readFileSync(target, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const final = JSON.parse(raw);
    expect(typeof final.gen).toBe("number");
    expect(final.payload).toBe("x".repeat(1024));
  });

  it("preserves the original file when the new payload throws during serialization", async () => {
    const target = join(tempDir, "preserve.json");
    const original = { keep: "me" };
    await atomicWriteJson(target, original);

    // A circular value can't be JSON.stringified — atomicWriteJson must throw
    // BEFORE any disk write so the original on-disk file is untouched.
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(atomicWriteJson(target, circular)).rejects.toThrow();

    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual(original);
  });
});

describe("atomicWriteJson — abort semantics", () => {
  it("skips the rename when the signal is already aborted and leaves the target untouched", async () => {
    const target = join(tempDir, "guarded.json");
    await atomicWriteJson(target, { old: true });

    const controller = new AbortController();
    controller.abort();

    // The aborted-skip is a clean no-op, not a rejection.
    await expect(
      atomicWriteJson(target, { fresh: 1 }, { signal: controller.signal }),
    ).resolves.toBeUndefined();

    // Rename was skipped — the live file still holds the prior payload.
    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual({ old: true });

    // The aborted branch unlinked its temp sibling — none should linger.
    const orphans = readdirSync(tempDir).filter((e) => e.includes(".tmp."));
    expect(orphans).toEqual([]);
  });

  it("renames normally when the signal is present but not aborted", async () => {
    const target = join(tempDir, "live.json");
    const controller = new AbortController();

    await atomicWriteJson(target, { fresh: 1 }, { signal: controller.signal });

    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual({ fresh: 1 });
  });
});
