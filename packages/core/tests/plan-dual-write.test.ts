import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "../../engine/src/sport/memory-tools.js";
import { Memory } from "../src/memory/store.js";

describe("plan_save compatibility dual-write", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps the legacy file byte-identical while awaiting the Plan row write", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-dual-write-"));
    roots.push(root);
    const persistPlan = vi.fn(async () => {});
    const memory = new Memory(root, "UTC", { persistPlan });
    const tool = createMemoryTools(memory, [{ name: "goals", description: "Goals" }]).plan_save;
    const plan = {
      id: "32cc7944-facd-4b56-b1a1-7dfe43e4bfe7",
      name: "Base Plan",
      primaryGoal: "Gran Fondo",
      totalWeeks: 8,
      status: "draft",
    };

    await expect(tool.execute!({ plan }, {} as never)).resolves.toEqual({ saved: true });
    expect(readFileSync(join(root, "plans", "current-plan.json"), "utf8")).toBe(
      JSON.stringify(plan, null, 2),
    );
    expect(persistPlan).toHaveBeenCalledWith(plan);
  });

  it("surfaces a Plan row failure after preserving the legacy file", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-dual-write-failure-"));
    roots.push(root);
    const failure = new Error("row write failed");
    const memory = new Memory(root, "UTC", {
      persistPlan: async () => Promise.reject(failure),
    });
    const tool = createMemoryTools(memory, [{ name: "goals", description: "Goals" }]).plan_save;
    const plan = { name: "Fallback Plan" };

    await expect(tool.execute!({ plan }, {} as never)).rejects.toBe(failure);
    expect(readFileSync(join(root, "plans", "current-plan.json"), "utf8")).toBe(
      JSON.stringify(plan, null, 2),
    );
  });
});
