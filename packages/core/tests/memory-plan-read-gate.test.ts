import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
import { createMemoryTools } from "../../engine/src/sport/memory-tools.js";
import {
  boundToolResultProvenance,
  unwrapBoundToolResult,
} from "../../engine/src/sport/bound-tool-result.js";
import { EMPTY_PROVENANCE } from "../../engine/src/provenance.js";

const message = "This Plan is managed in Chat. Open the Plan page or ask in Chat about your Plan.";
const plan = { name: "Base", primaryGoal: "Ride consistently", totalWeeks: 8, status: "active" };
const provenance = { garmin: true, nonGarmin: false, unknown: false };
const sections = [{ name: "goals", description: "Athlete goals" }];
const executeOptions = { toolCallId: "read-plan", messages: [] };

describe("Memory plan read gate", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "memory-plan-read-gate-"));
    new Memory(dataDir).savePlan(plan, "migration", provenance);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("preserves context, provenance and tool results when the gate allows reading", async () => {
    const original = new Memory(dataDir);
    const memory = new Memory(dataDir, "UTC", { planReadGate: async () => null });
    await expect(memory.refreshPlanReadGate!()).resolves.toBeNull();

    expect(memory.getContext()).toBe(original.getContext());
    expect(memory.getContext()).toContain("## Current Plan");
    expect(memory.getContextWithProvenance()).toEqual(original.getContextWithProvenance());
    expect(memory.getContextWithProvenance().provenance).toEqual(provenance);
    expect(memory.provenanceForToolRead("plan_load", {})).toEqual(provenance);
    const tools = createMemoryTools(memory, sections, { bindProvenance: true });
    const result = await tools.plan_load.execute!({}, executeOptions);
    expect(unwrapBoundToolResult(result)).toEqual(plan);
    expect(boundToolResultProvenance(result)).toEqual(provenance);
    const context = await tools.memory_read.execute!({}, executeOptions);
    expect(unwrapBoundToolResult(context)).toBe(original.getContext());
    expect(boundToolResultProvenance(context)).toEqual(provenance);
  });

  it("hides the file plan and its provenance after refreshing the gate", async () => {
    const memory = new Memory(dataDir, "UTC", { planReadGate: async () => message });
    const path = join(dataDir, "plans", "current-plan.json");
    const original = readFileSync(path, "utf8");
    await expect(memory.refreshPlanReadGate!()).resolves.toBe(message);

    expect(memory.loadPlan()).toBeNull();
    expect(memory.getContext()).toBe("");
    expect(memory.getContextWithProvenance()).toEqual({ text: "", provenance: EMPTY_PROVENANCE });
    expect(memory.provenanceForToolRead("plan_load", {})).toEqual(EMPTY_PROVENANCE);
    expect(memory.provenanceForToolRead("memory_read", {})).toEqual(EMPTY_PROVENANCE);
    const tools = createMemoryTools(memory, sections, { bindProvenance: true });
    const result = await tools.plan_load.execute!({}, executeOptions);
    expect(unwrapBoundToolResult(result)).toBe(message);
    expect(boundToolResultProvenance(result)).toEqual(EMPTY_PROVENANCE);
    const context = await tools.memory_read.execute!({}, executeOptions);
    expect(unwrapBoundToolResult(context)).toBe(
      "Every stored section is already in your Athlete Context.",
    );
    expect(boundToolResultProvenance(context)).toEqual(EMPTY_PROVENANCE);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["plan_load", "memory_read"] as const)(
    "%s refreshes authority acquired after construction",
    async (name) => {
      let authority = false;
      const memory = new Memory(dataDir, "UTC", {
        planReadGate: async () => (authority ? message : null),
      });
      const tool = createMemoryTools(memory, sections)[name];
      await tool.execute!({}, executeOptions);
      expect(memory.getContext()).toContain("## Current Plan");

      authority = true;
      const result = await tool.execute!({}, executeOptions);

      expect(result).toBe(
        name === "plan_load" ? message : "Every stored section is already in your Athlete Context.",
      );
      expect(memory.getContext()).not.toContain("## Current Plan");
      expect(memory.getContextWithProvenance().provenance).toEqual(EMPTY_PROVENANCE);
    },
  );

  it("keeps other context and its provenance when the plan is hidden", async () => {
    const memory = new Memory(dataDir, "UTC", { planReadGate: async () => message });
    memory.writeSection("goals", "Enjoy riding", "chat-tool", {
      garmin: false,
      nonGarmin: true,
      unknown: false,
    });
    await memory.refreshPlanReadGate!();

    const context = memory.getContextWithProvenance();
    expect(context.text).toContain("Enjoy riding");
    expect(context.text).not.toContain("## Current Plan");
    expect(context.provenance).toEqual({ garmin: false, nonGarmin: true, unknown: false });
  });

  it("does not reopen reads when an older refresh finishes after authority was acquired", async () => {
    let resolveOld: (value: string | null) => void = () => {};
    const oldDecision = new Promise<string | null>((resolve) => {
      resolveOld = resolve;
    });
    let reads = 0;
    const memory = new Memory(dataDir, "UTC", {
      planReadGate: () => (++reads === 1 ? oldDecision : Promise.resolve(message)),
    });
    const pending = memory.refreshPlanReadGate!();
    await memory.refreshPlanReadGate!();
    resolveOld(null);

    await expect(pending).resolves.toBe(message);
    expect(memory.getContext()).not.toContain("## Current Plan");
  });
});
