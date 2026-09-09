import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
} from "../src/reference/schemas/error-state.js";
import { clearErrorState, writeErrorState } from "../src/reference/sync/error-state-writer.js";
import { enqueueCommit } from "../src/io/atomic-write-json.js";

describe("writeErrorState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-error-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes error_state.json with step, detail, phase, schema_version, and ISO ts", async () => {
    await writeErrorState(dir, {
      step: "outer_timeout",
      phase: "writing_cache",
      detail: "fetch hung past 2-min budget",
    });

    const raw = readFileSync(join(dir, "error_state.json"), "utf-8");
    const parsed = ErrorStateSchema.parse(JSON.parse(raw));
    expect(parsed.step).toBe("outer_timeout");
    expect(parsed.phase).toBe("writing_cache");
    expect(parsed.detail).toBe("fetch hung past 2-min budget");
    expect(parsed.schema_version).toBe(ERROR_STATE_SCHEMA_VERSION);
    expect(new Date(parsed.ts).toString()).not.toBe("Invalid Date");
  });

  it("omits phase when not supplied (gate-failure path)", async () => {
    await writeErrorState(dir, {
      step: "gate_rejected",
      detail: "ftp_source_missing",
    });

    const raw = readFileSync(join(dir, "error_state.json"), "utf-8");
    const parsed = ErrorStateSchema.parse(JSON.parse(raw));
    expect(parsed.step).toBe("gate_rejected");
    expect(parsed.phase).toBeUndefined();
  });

  it("routes through an injected write and threads the signal (B1)", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();

    await writeErrorState(
      dir,
      { step: "gate_rejected", detail: "x", mitigation: "block_coaching" },
      { write: spy, signal: controller.signal },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as string).endsWith("error_state.json")).toBe(true);
    const value = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(value.step).toBe("gate_rejected");
    expect(value.detail).toBe("x");
    expect(value.mitigation).toBe("block_coaching");
    expect(value.schema_version).toBe(ERROR_STATE_SCHEMA_VERSION);
    expect(typeof value.ts).toBe("string");
    expect(spy.mock.calls[0][2]).toEqual({ signal: controller.signal });
  });

  it("default write honours an already-aborted signal — no file lands (B2)", async () => {
    const aborted = new AbortController();
    aborted.abort();

    await writeErrorState(dir, { step: "gate_rejected", detail: "x" }, { signal: aborted.signal });
    expect(existsSync(join(dir, "error_state.json"))).toBe(false);

    // A fresh, non-aborted write lands the file — proving the seam threads the
    // signal into the real abort-aware atomicWriteJson rather than swallowing it.
    await writeErrorState(dir, { step: "gate_rejected", detail: "x" });
    expect(existsSync(join(dir, "error_state.json"))).toBe(true);
  });
});

describe("clearErrorState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-error-state-clear-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes the canonical target through the asynchronous unlink primitive", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const unlink = vi.fn((...args: Parameters<typeof actual.unlink>) => actual.unlink(...args));
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, unlink }));
    try {
      const { clearErrorState: isolatedClearErrorState, writeErrorState: isolatedWriteErrorState } =
        await import("../src/reference/sync/error-state-writer.js");
      await isolatedWriteErrorState(dir, { step: "gate_rejected", detail: "x" });
      unlink.mockClear();
      await isolatedClearErrorState(dir);
      expect(unlink).toHaveBeenCalledOnce();
      expect(existsSync(join(dir, "error_state.json"))).toBe(false);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("skips a queued unlink whose signal aborted while an earlier commit was in flight", async () => {
    await writeErrorState(dir, { step: "gate_rejected", detail: "x" });
    const path = join(dir, "error_state.json");

    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const blocked = enqueueCommit(path, () => queueGate);

    const controller = new AbortController();
    const clearing = clearErrorState(dir, { signal: controller.signal });
    controller.abort();
    releaseQueue();
    await blocked;
    await expect(clearing).resolves.toBeUndefined();

    expect(existsSync(path)).toBe(true);
  });

  it("skips the unlink when the signal is aborted (B3)", async () => {
    await writeErrorState(dir, { step: "gate_rejected", detail: "x" });
    expect(existsSync(join(dir, "error_state.json"))).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    await clearErrorState(dir, { signal: aborted.signal });
    expect(existsSync(join(dir, "error_state.json"))).toBe(true);

    await clearErrorState(dir);
    expect(existsSync(join(dir, "error_state.json"))).toBe(false);
  });

  it("swallows a missing error state and rejects other unlink failures", async () => {
    await expect(clearErrorState(dir)).resolves.toBeUndefined();
    mkdirSync(join(dir, "error_state.json"));
    await expect(clearErrorState(dir)).rejects.toThrow();
  });
});

describe("ErrorStateSchema (forward-design)", () => {
  it("accepts the forward-design fields (caller, gate_check, expected, observed, mitigation)", () => {
    // Future sync-gate writers will populate these fields. The current stub
    // writer doesn't, but the on-disk schema accepts them now so those
    // writers won't need a schema_version bump. Locks in field names so a
    // typo (e.g. `gate-check` vs `gate_check`) gets caught even before the
    // first real sample.
    const forwardSample = {
      schema_version: ERROR_STATE_SCHEMA_VERSION,
      step: "gate_rejected",
      detail: "FTP source missing on athlete profile",
      ts: new Date().toISOString(),
      caller: "scheduled",
      gate_check: "ftp_source_check",
      expected: { source: "test" },
      observed: { source: null },
      mitigation: "warn_only",
    };
    const parsed = ErrorStateSchema.parse(forwardSample);
    expect(parsed.caller).toBe("scheduled");
    expect(parsed.gate_check).toBe("ftp_source_check");
    expect(parsed.mitigation).toBe("warn_only");
  });

  it("rejects unknown fields (.strict() boundary)", () => {
    // Forward-compat hard line: unrecognized fields are rejected so a
    // typo in a future writer fails loud instead of silently persisting.
    expect(() =>
      ErrorStateSchema.parse({
        schema_version: ERROR_STATE_SCHEMA_VERSION,
        step: "gate_rejected",
        detail: "x",
        ts: new Date().toISOString(),
        future_field_typo: "nope",
      }),
    ).toThrow();
  });
});
