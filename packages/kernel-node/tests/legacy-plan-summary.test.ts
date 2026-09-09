import { LegacyPlanSummarySchema, type LegacyPlanSummary } from "../../coach-contract/src/index.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { readLegacyCurrentPlanSummary } from "../src/planning/index.js";
import { legacyCurrentPlanJson } from "./helpers/legacy-v11-store.js";

describe("legacy current Plan summary", () => {
  let root: string;
  const logger = { warn: vi.fn() };
  const home = () => ({
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  });
  const read = () => readLegacyCurrentPlanSummary({ home: home(), logger });
  const write = (value: unknown) =>
    writeFile(join(root, "plans", "current-plan.json"), JSON.stringify(value));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "legacy-plan-summary-"));
    await mkdir(join(root, "plans"));
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns null without warning when the file is missing", async () => {
    expect(await read()).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns null and warns once for malformed JSON", async () => {
    await writeFile(join(root, "plans", "current-plan.json"), "{broken");
    expect(await read()).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns null when the logger itself throws", async () => {
    await writeFile(join(root, "plans", "current-plan.json"), "{broken");
    const throwing = {
      warn: () => {
        throw new Error("logger unavailable");
      },
    };
    await expect(
      readLegacyCurrentPlanSummary({ home: home(), logger: throwing }),
    ).resolves.toBeNull();
  });

  it.each([{}, { name: "" }, { name: "   " }, { name: 12 }, null, [], "Plan", 12])(
    "returns null and warns once for an invalid source %j",
    async (value) => {
      await write(value);
      expect(await read()).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it("reads the exact summary without changing the source or needing an imported row", async () => {
    await write(legacyCurrentPlanJson("with-workouts"));
    const path = join(root, "plans", "current-plan.json");
    const bytes = await readFile(path);
    const before = await stat(path);
    const summary = await read();
    expectTypeOf(summary).toEqualTypeOf<LegacyPlanSummary | null>();
    expect(LegacyPlanSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toEqual({
      name: "8-Week Plan",
      goal: "Gran Fondo",
      weeks: 8,
      sourceStatus: "draft",
      createdAt: "1998-07-04",
      targetDate: "1998-08-30",
      readOnly: true,
      source: "current-plan.json",
    });
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps valid partial fields while nulling wrong types independently", async () => {
    await write({
      name: "Partial Plan",
      primaryGoal: "Build fitness",
      totalWeeks: "8",
      createdAt: 12,
      status: 3,
      targetDate: "1998-08-30T12:00:00Z",
    });
    expect(await read()).toEqual({
      name: "Partial Plan",
      goal: "Build fitness",
      weeks: null,
      sourceStatus: null,
      createdAt: null,
      targetDate: "1998-08-30",
      readOnly: true,
      source: "current-plan.json",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "nulls invalid weeks %s",
    async (totalWeeks) => {
      await write({ name: "Plan", totalWeeks });
      expect(await read()).toMatchObject({ weeks: null });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("preserves raw strings and nulls absent or invalid optional values", async () => {
    await write({
      name: " Plan ",
      primaryGoal: " ",
      status: "unknown legacy status",
      createdAt: "not a date",
      targetDate: "+010000-01-01T00:00:00Z",
    });
    expect(await read()).toEqual({
      name: " Plan ",
      goal: null,
      weeks: null,
      sourceStatus: "unknown legacy status",
      createdAt: null,
      targetDate: null,
      readOnly: true,
      source: "current-plan.json",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("normalizes parseable dates to UTC calendar dates", async () => {
    await write({ name: "Plan", createdAt: "1998-07-04T23:00:00-02:00", targetDate: "1998-08-30" });
    expect(await read()).toMatchObject({ createdAt: "1998-07-05", targetDate: "1998-08-30" });
  });

  it("returns null and warns once when the source cannot be read", async () => {
    await mkdir(join(root, "plans", "current-plan.json"));
    expect(await read()).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
