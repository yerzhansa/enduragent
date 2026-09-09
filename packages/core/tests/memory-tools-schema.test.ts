import { describe, expect, it, vi } from "vitest";
import { zodSchema } from "ai";
import type { MemoryStore } from "../src/memory.js";
import {
  buildMemoryWriteInputSchema,
  createMemoryTools,
  PlanSaveInputSchema,
} from "../src/sport.js";

const sections = [{ name: "profile", description: "Athlete profile" }];

function memorySpy() {
  return {
    writeSection: vi.fn(),
    appendDailyNote: vi.fn(),
    savePlan: vi.fn(),
    getContext: vi.fn(),
    readDailyNotesInRange: vi.fn(() => []),
    readEventsRaw: vi.fn(() => ""),
    readJournalRaw: vi.fn(() => ""),
    loadPlan: vi.fn(),
  } as unknown as MemoryStore;
}

describe("memory_write schema and guard", () => {
  const schema = buildMemoryWriteInputSchema(["profile"]);

  it("keeps an object-rooted serialized input schema", () => {
    expect(zodSchema(schema).jsonSchema.type).toBe("object");
  });

  it("allows omitted section at schema level but refuses the memory write", async () => {
    const memory = memorySpy();
    expect(schema.safeParse({ type: "memory", content: "x" }).success).toBe(true);
    const tool = createMemoryTools(memory, sections).memory_write;

    const result = await tool.execute!({ type: "memory", content: "x" }, {} as never);

    expect(result).toMatchObject({ error: "section_required" });
    expect(memory.writeSection).not.toHaveBeenCalled();
  });

  it("rejects unknown sections and writes a valid section", async () => {
    expect(
      schema.safeParse({ type: "memory", section: "unknown", content: "x" }).success,
    ).toBe(false);
    const memory = memorySpy();
    const tool = createMemoryTools(memory, sections).memory_write;
    await tool.execute!(
      { type: "memory", section: "profile", content: "x" },
      {} as never,
    );
    expect(memory.writeSection).toHaveBeenCalledWith("profile", "x", "chat-tool");
  });

  it("appends daily content without a section", async () => {
    const memory = memorySpy();
    expect(schema.safeParse({ type: "daily", content: "x" }).success).toBe(true);
    await createMemoryTools(memory, sections).memory_write.execute!(
      { type: "daily", content: "x" },
      {} as never,
    );
    expect(memory.appendDailyNote).toHaveBeenCalledWith("x");
  });
});

describe("PlanSaveInputSchema", () => {
  it("requires a name and typed headline fields", () => {
    expect(PlanSaveInputSchema.safeParse({}).success).toBe(false);
    expect(PlanSaveInputSchema.safeParse({ name: "P", totalWeeks: null }).success).toBe(
      false,
    );
    expect(PlanSaveInputSchema.safeParse({ name: "P", totalWeeks: 0 }).success).toBe(false);
    expect(PlanSaveInputSchema.safeParse({ name: "P", totalWeeks: 12.5 }).success).toBe(
      false,
    );
  });

  it("preserves passthrough fields", () => {
    const result = PlanSaveInputSchema.safeParse({ name: "P", extra: "kept" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.extra).toBe("kept");
  });
});
