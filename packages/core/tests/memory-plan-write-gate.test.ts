import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";

describe("Memory plan write gate", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "memory-plan-write-gate-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("waits for the gate and rejects without writing any files or persisting the plan", async () => {
    let resolveDecision: (message: string | null) => void = () => {};
    const decision = new Promise<string | null>((resolve) => {
      resolveDecision = resolve;
    });
    const persistPlan = vi.fn(async () => {});
    const memory = new Memory(dataDir, "UTC", {
      planWriteGate: () => decision,
      persistPlan,
    });
    const pending = memory.savePlan({ name: "Base" });

    expect(readdirSync(join(dataDir, "memory"))).toEqual([]);
    expect(readdirSync(join(dataDir, "plans"))).toEqual([]);
    expect(persistPlan).not.toHaveBeenCalled();

    const message =
      "This Plan is managed in Chat. Change or stop it from Chat or the Plan library.";
    resolveDecision(message);
    await expect(pending).rejects.toThrow(new Error(message));

    expect(readdirSync(join(dataDir, "memory"))).toEqual([]);
    expect(readdirSync(join(dataDir, "plans"))).toEqual([]);
    expect(persistPlan).not.toHaveBeenCalled();
    expect(memory.loadPlan()).toBeNull();
  });

  it("writes and persists the plan when the gate allows it", async () => {
    const persistPlan = vi.fn(async () => {});
    const memory = new Memory(dataDir, "UTC", {
      planWriteGate: async () => null,
      persistPlan,
    });
    const plan = { name: "Base" };

    await memory.savePlan(plan);

    expect(memory.loadPlan()).toEqual(plan);
    expect(persistPlan).toHaveBeenCalledExactlyOnceWith(plan);
  });

  it("preserves synchronous file writes when no gate is configured", () => {
    const memory = new Memory(dataDir);
    const plan = { name: "Base" };

    expect(memory.savePlan(plan)).toBeUndefined();
    expect(memory.loadPlan()).toEqual(plan);
  });
});
