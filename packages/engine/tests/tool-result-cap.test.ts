import { describe, it, expect } from "vitest";
import type { Tool } from "ai";
import { capToolResult, TOOL_RESULT_MAX_TOKENS } from "../src/agent/tool-result-cap.js";
import { estimateTokens } from "../src/agent/token-utils.js";

const stubTool = (value: unknown): Tool =>
  ({ description: "stub", execute: async () => value }) as unknown as Tool;

describe("capToolResult", () => {
  it("pins the absolute token limit", () => {
    expect(TOOL_RESULT_MAX_TOKENS).toBe(24_000);
  });

  it("truncates a 30,000-token result with the absolute limit", async () => {
    const value = "x".repeat(100_000);
    expect(estimateTokens(value)).toBe(30_000);
    const wrapped = capToolResult(stubTool(value), {
      maxResultTokens: TOOL_RESULT_MAX_TOKENS,
    });
    expect(await wrapped.execute!({}, {} as never)).toEqual({
      truncated: true,
      notice:
        "Tool result too large (~30000 tokens) and was omitted to protect context. " +
        "Rerun with narrower arguments (e.g. a smaller date range, fewer stream types, or a shorter activity).",
      omittedSamples: 0,
      estimatedTokens: 30_000,
    });
  });

  it("small result passes through byte-identical (same reference)", async () => {
    const value = { watts: [100, 200, 300] };
    const wrapped = capToolResult(stubTool(value), { maxResultTokens: 50_000 });
    const out = await wrapped.execute!({}, {} as never);
    expect(out).toBe(value);
  });

  it("string result under the cap passes through unchanged", async () => {
    const wrapped = capToolResult(stubTool("short answer"), { maxResultTokens: 50_000 });
    const out = await wrapped.execute!({}, {} as never);
    expect(out).toBe("short answer");
  });

  it("oversized stream result is truncated with a count-preserving notice", async () => {
    const big = {
      watts: Array(10800).fill(250),
      heartrate: Array(10800).fill(150),
      cadence: Array(10800).fill(90),
      time: Array(10800).fill(1),
      altitude: Array(10800).fill(500),
    };
    const wrapped = capToolResult(stubTool(big), { maxResultTokens: 50_000 });
    const out = (await wrapped.execute!({}, {} as never)) as {
      truncated: boolean;
      notice: string;
      omittedSamples: number;
    };
    expect(out.truncated).toBe(true);
    expect(out.notice).toMatch(/narrower/i);
    expect(out.omittedSamples).toBeGreaterThan(0);
  });

  it("a tool with no execute is returned unchanged", () => {
    const t = { description: "no-exec" } as unknown as Tool;
    expect(capToolResult(t, { maxResultTokens: 50_000 })).toBe(t);
  });

  it("respects the caller-supplied budget boundary", async () => {
    const value = { watts: Array(200).fill(250) };
    const passes = capToolResult(stubTool(value), { maxResultTokens: 50_000 });
    expect(await passes.execute!({}, {} as never)).toBe(value);

    const capped = capToolResult(stubTool(value), { maxResultTokens: 10 });
    const out = (await capped.execute!({}, {} as never)) as { truncated?: boolean };
    expect(out.truncated).toBe(true);
  });
});
