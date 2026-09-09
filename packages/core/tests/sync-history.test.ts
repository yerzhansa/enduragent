import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_HISTORY_FILE,
  createSyncHistoryWriter,
  resetSyncHistoryEscalation,
  type SyncOutcomeLine,
} from "../src/reference/sync/sync-history.js";

describe("createSyncHistoryWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-history-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetSyncHistoryEscalation();
    vi.restoreAllMocks();
  });

  it("appends exactly one JSONL line per call, with the full outcome shape, to sync-history.jsonl", () => {
    const path = join(dir, SYNC_HISTORY_FILE);
    const writer = createSyncHistoryWriter(dir);

    const line: SyncOutcomeLine = {
      schema_version: "1",
      ts: "1998-05-09T14:00:00.000Z",
      caller: "scheduled",
      kind: "failed",
      reason: "gate_rejected",
      duration_ms: 1234,
    };
    writer(line);
    writer({
      schema_version: "1",
      ts: "1998-05-09T14:01:00.000Z",
      caller: "lazy",
      kind: "ran",
      duration_ms: 5,
    });

    // The file lives beside error_state.json — NOT under logs/, NOT log.jsonl.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, "logs", "log.jsonl"))).toBe(false);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      schema_version: "1",
      ts: "1998-05-09T14:00:00.000Z",
      caller: "scheduled",
      kind: "failed",
      reason: "gate_rejected",
      duration_ms: 1234,
    });
    // A `ran` line carries no reason.
    expect(JSON.parse(lines[1]).reason).toBeUndefined();
  });

  it("rotates to .1 on size overflow and applies NO age-based pruning (size-only cap, ~30-day retention)", () => {
    const path = join(dir, SYNC_HISTORY_FILE);
    const writer = createSyncHistoryWriter(dir, { maxBytes: 256 });

    // Seed the live file above the (tiny, injected) cap with an ANCIENT line.
    const ancient: SyncOutcomeLine = {
      schema_version: "1",
      ts: "1990-01-01T00:00:00.000Z",
      caller: "scheduled",
      kind: "ran",
      reason: undefined,
      duration_ms: 1,
    };
    writeFileSync(path, JSON.stringify({ ...ancient, filler: "x".repeat(512) }) + "\n");
    expect(statSync(path).size).toBeGreaterThan(256);

    // The next write trips the size rotate: the seeded content moves to `.1`,
    // the live file holds only the fresh line.
    writer({
      schema_version: "1",
      ts: "1998-05-09T14:00:00.000Z",
      caller: "lazy",
      kind: "ran",
      duration_ms: 9,
    });

    expect(existsSync(`${path}.1`)).toBe(true);
    const live = readFileSync(path, "utf-8").trim().split("\n");
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]).caller).toBe("lazy");

    // The ancient line is NOT dropped — it survives in `.1`. A size-only cap has
    // no age prune, so ~30-day-old lines persist until rotated out by SIZE.
    const rotated = readFileSync(`${path}.1`, "utf-8");
    expect(rotated).toContain("1990-01-01T00:00:00.000Z");
  });

  it("never throws when the append target is unwritable; warns once per process and swallows", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Point dataDir at a path whose parent is a regular file, so mkdir/append
    // fails — mirrors the rolling logger's unwritable-target test.
    const blocker = join(dir, "block");
    writeFileSync(blocker, "i am a file, not a dir");
    const writer = createSyncHistoryWriter(join(blocker, "nested"));

    const line: SyncOutcomeLine = {
      schema_version: "1",
      ts: "1998-05-09T14:00:00.000Z",
      caller: "scheduled",
      kind: "ran",
      duration_ms: 7,
    };

    expect(() => writer(line)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();

    // The once-per-process latch holds: a second failing write does not re-warn.
    expect(() => writer(line)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
