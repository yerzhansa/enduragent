import { describe, it, expect } from "vitest";
import { asSchema, type FlexibleSchema } from "ai";
import type { AthleteDataReaderPort, AthleteReadResult } from "../src/host-ports.js";
import { createPureCoreIntervalsTools } from "../src/sport/platform-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { kind: string } };

function missing(): Promise<AthleteReadResult<never>> {
  return Promise.resolve({ ok: false, error: "not_found", message: "not found" });
}

async function inputAccepts(schema: unknown, value: unknown): Promise<boolean> {
  const validate = asSchema(schema as FlexibleSchema<unknown>).validate;
  if (validate === undefined) throw new Error("Tool input schema has no validator");
  return (await validate(value)).success;
}

function makeFakeReader(
  result: AnyResult,
  capture: { activityId?: string; types?: string[] },
): AthleteDataReaderPort {
  return {
    getAthlete: missing,
    listWellness: missing,
    listActivities: missing,
    getActivity: missing,
    getStreams: async ({ id, keys }) => {
      capture.activityId = id;
      capture.types = [...keys];
      if (!result.ok) {
        throw Object.assign(new Error(result.error.kind), {
          name: "PlatformApiError",
          apiError: result.error,
        });
      }
      return result;
    },
    listCalendar: missing,
    freshness: () => undefined,
  };
}

describe("intervals_fetch_streams", () => {
  it("is exported from createPureCoreIntervalsTools", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    expect(tools.intervals_fetch_streams).toBeDefined();
  });

  it("calls SDK with default five types when types omitted", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: { watts: [] } }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 12345 }, {} as never);

    expect(capture.activityId).toBe("12345");
    expect(capture.types).toEqual(["watts", "heartrate", "cadence", "time", "altitude"]);
  });

  it("passes a canonical activity ID to the reader unchanged", async () => {
    const activityId = "b".repeat(64);
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;

    expect(await inputAccepts(tool.inputSchema, { activityId, types: ["power"] })).toBe(true);
    await tool.execute!({ activityId, types: ["power"] }, {} as never);

    expect(capture.activityId).toBe(activityId);
  });

  it("passes an i-prefixed intervals-native activity ID to the reader verbatim", async () => {
    const activityId = "i12345";
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;

    expect(await inputAccepts(tool.inputSchema, { activityId })).toBe(true);
    await tool.execute!({ activityId }, {} as never);

    expect(capture.activityId).toBe("i12345");
  });

  it("accepts a legacy activity ID passed as a digit string", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;

    expect(await inputAccepts(tool.inputSchema, { activityId: "12345" })).toBe(true);
    await tool.execute!({ activityId: "12345" }, {} as never);

    expect(capture.activityId).toBe("12345");
  });

  it("rejects malformed, non-positive, fractional, and unsafe activity IDs", async () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;
    const invalidIds = [
      "i",
      "abc",
      "i12b45",
      "12345 ",
      "B".repeat(64),
      "b".repeat(63),
      "not-an-id",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const activityId of invalidIds) {
      expect(await inputAccepts(tool.inputSchema, { activityId })).toBe(false);
    }
  });

  it("forwards explicit types verbatim to SDK", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 999, types: ["watts", "heartrate"] }, {} as never);

    expect(capture.types).toEqual(["watts", "heartrate"]);
  });

  it("forwards provider-specific stream types without applying store-only restrictions", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;

    expect(
      await inputAccepts(tool.inputSchema, {
        activityId: 1,
        types: ["smooth_grade", "provider_specific"],
      }),
    ).toBe(true);
    await tool.execute!(
      { activityId: 1, types: ["smooth_grade", "provider_specific"] },
      {} as never,
    );

    expect(capture.types).toEqual(["smooth_grade", "provider_specific"]);
  });

  it("leaves stream-count and alias-uniqueness restrictions to the selected reader", async () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;
    const channels = [
      "time",
      "lat",
      "lng",
      "distance",
      "altitude",
      "speed",
      "heart_rate",
      "cadence",
      "fractional_cadence",
      "power",
      "temperature",
      "stance_time",
      "stance_time_balance",
      "vertical_oscillation",
      "vertical_ratio",
      "step_length",
      "left_right_balance",
    ];

    expect(
      await inputAccepts(tool.inputSchema, { activityId: 1, types: channels.slice(0, 16) }),
    ).toBe(true);
    expect(await inputAccepts(tool.inputSchema, { activityId: 1, types: channels })).toBe(true);
    expect(await inputAccepts(tool.inputSchema, { activityId: 1, types: ["watts", "watts"] })).toBe(
      true,
    );
    expect(await inputAccepts(tool.inputSchema, { activityId: 1, types: ["watts", "power"] })).toBe(
      true,
    );
  });

  it("accepts every supported direct channel and legacy alias", async () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;
    const supported = [
      "time",
      "lat",
      "lng",
      "distance",
      "altitude",
      "speed",
      "heart_rate",
      "cadence",
      "fractional_cadence",
      "power",
      "temperature",
      "stance_time",
      "stance_time_balance",
      "vertical_oscillation",
      "vertical_ratio",
      "step_length",
      "left_right_balance",
      "respiration_rate",
      "watts",
      "heartrate",
      "temp",
    ];

    for (const type of supported) {
      expect(await inputAccepts(tool.inputSchema, { activityId: 1, types: [type] })).toBe(true);
    }
  });

  it("treats empty types array the same as omitted (uses defaults)", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    expect(await inputAccepts(tool.inputSchema, { activityId: 1, types: [] })).toBe(true);
    await tool.execute!({ activityId: 1, types: [] }, {} as never);

    expect(capture.types).toEqual(["watts", "heartrate", "cadence", "time", "altitude"]);
  });

  it("returns a downsampled stream object on success", async () => {
    const streams = { watts: [100, 200, 300], time: [0, 1, 2] };
    const reader = makeFakeReader({ ok: true, value: streams }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    const result = (await tool.execute!({ activityId: 1 }, {} as never)) as {
      sampleCount: number;
      channels: Record<string, { max: number }>;
    };

    expect(result.sampleCount).toBe(3);
    expect(result.channels.watts.max).toBe(300);
  });

  it("returns { error: kind } on SDK error", async () => {
    const reader = makeFakeReader({ ok: false, error: { kind: "not_found" } }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    const result = await tool.execute!({ activityId: 1 }, {} as never);

    expect(result).toEqual({ error: "not_found" });
  });

  it("description carries the cost-warning language", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const description = (tools.intervals_fetch_streams as { description: string }).description;
    expect(description).toContain("Expensive");
    expect(description).toContain("only for Tier C");
    expect(description).toMatch(/legacy or canonical ID/i);
    expect(description).toContain("Store-backed reads accept up to 16 unique public channels");
    expect(description).toContain("platform-backed");
    expect(description).toContain("not timestamp-aligned");
    expect(description).toContain("Use only minimum, maximum, and mean as descriptive recorded observations.");
    expect(description).toContain("cannot establish session quality");
    expect(description).toContain("quartile trends, decoupling");
    expect(description).toContain("HR recovery, fade patterns, or indoor/outdoor comparisons");
    expect(description).toContain("do not use");
    expect(description).toContain("smooth_grade");
  });

  it("documents the i-prefixed shape in the activityId parameter description", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_streams!;
    const jsonSchema = asSchema(tool.inputSchema as FlexibleSchema<unknown>).jsonSchema;

    expect(JSON.stringify(jsonSchema)).toContain("i-prefixed");
  });
});
