import { describe, it, expect } from "vitest";

import { MOCK_TOOLS, MOCK_TOOL_NAMES, buildToolSet, toAnthropicToolsJson } from "./tools.js";
import type { ToolCallRecorder } from "./tools.js";

const SAMPLE_INPUT = {
  from: "1998-01-01",
  to: "1998-12-31",
  content: "x",
  entry: "x",
  plan: "x",
  days: 7,
  activityId: 90101,
  streams: ["watts", "heartrate"],
  metricKey: "form",
  sport: "cycling",
  topic: "taper",
  anchorValue: 250,
  target: "calendar",
  doc: "x",
  date: "1998-07-10",
  weeks: 8,
  goal: "tri",
  phase: "build",
  segments: ["bike", "run"],
  raceDate: "1998-08-30",
  disciplines: ["swim", "bike", "run"],
  eventId: 90301,
};

describe("mock tool union", () => {
  it("has exactly 25 unique tool names", () => {
    expect(MOCK_TOOL_NAMES).toHaveLength(25);
    expect(new Set(MOCK_TOOL_NAMES).size).toBe(25);
  });

  it("every executor is deterministic for the same args", () => {
    for (const spec of MOCK_TOOLS) {
      const a = JSON.stringify(spec.makeResult(SAMPLE_INPUT));
      const b = JSON.stringify(spec.makeResult(SAMPLE_INPUT));
      expect(a).toBe(b);
    }
  });

  it("skill_read returns file content and an error shape without throwing", () => {
    const spec = MOCK_TOOLS.find((t) => t.name === "skill_read");
    expect(spec).toBeDefined();
    const ok = spec!.makeResult({ sport: "cycling", topic: "taper" }) as { content?: string };
    expect(typeof ok.content).toBe("string");
    expect(ok.content).toContain("Day -8");
    const bad = spec!.makeResult({ sport: "cycling", topic: "does-not-exist" }) as {
      error?: string;
      available?: unknown;
    };
    expect(bad.error).toBe("unknown_topic");
    expect(Array.isArray(bad.available)).toBe(true);
  });

  it("toAnthropicToolsJson produces 25 object-schema entries", () => {
    const json = toAnthropicToolsJson();
    expect(json).toHaveLength(25);
    for (const entry of json) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect((entry.input_schema as { type?: string }).type).toBe("object");
    }
  });

  it("records every executor call in invocation order (not last-step-only)", () => {
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const rec: ToolCallRecorder = (c) => calls.push(c);
    const set = buildToolSet(rec) as unknown as Record<string, { execute: (i: unknown) => unknown }>;
    set["memory_read"].execute({});
    set["activities_list"].execute({ days: 7 });
    expect(calls.map((c) => c.toolName)).toEqual(["memory_read", "activities_list"]);
  });
});
