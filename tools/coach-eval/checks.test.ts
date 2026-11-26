import { describe, expect, it } from "vitest";
import {
  argumentMatches,
  containsNumber,
  evaluate,
  metricNumbers,
  mentions,
  wattFigures,
  type Expectation,
  type TurnObservation,
} from "./checks.js";
import { DEFAULT_MAX_USD, SpendLimitReachedError, SpendMeter, lineCostUsd, parseRunArgs } from "./spend.js";

function turn(overrides: Partial<TurnObservation> = {}): TurnObservation {
  return {
    reply: "",
    offeredTools: [],
    attempts: [],
    proposals: [],
    pendingProposal: false,
    writes: [],
    ...overrides,
  };
}

function passes(expectation: Expectation, observation: TurnObservation): boolean {
  return evaluate(expectation, observation).pass;
}

describe("reply text checks", () => {
  it("matches whole words only, ignoring case", () => {
    expect(mentions("Your Form is +6 today.", "Form")).toBe(true);
    expect(mentions("your form is fine", "Form")).toBe(true);
    expect(mentions("You perform well; more information soon.", "Form")).toBe(false);
    expect(mentions("Start with a 10-minute warm-up.", "warm-up")).toBe(true);
    expect(mentions("Start warm.", "warm-up")).toBe(false);
  });

  it("finds a number only as a whole number", () => {
    expect(containsNumber("Your Load was 324 this week.", 324)).toBe(true);
    expect(containsNumber("Total: 324.", 324)).toBe(true);
    expect(containsNumber("Total: 324.0 points", 324)).toBe(true);
    expect(containsNumber("Total: 1324", 324)).toBe(false);
    expect(containsNumber("Total: 3245", 324)).toBe(false);
    expect(containsNumber("Total: 324.5", 324)).toBe(false);
    expect(containsNumber("Total: 1,324", 324)).toBe(false);
  });

  it("collects watt figures, including both ends of a range", () => {
    expect(wattFigures("Ride 684-756 W, then 200 watts, then 3 x 250W.")).toEqual([684, 756, 200, 250]);
    expect(wattFigures("Hold 210–230 W")).toEqual([210, 230]);
    expect(wattFigures("Three weeks of 45 min rides at 3.5 W/kg")).toEqual([]);
  });

  it("collects numbers quoted next to a metric name", () => {
    expect(metricNumbers("Fitness 55, Fatigue: 48, Form is -3, FTP of 268")).toEqual([
      "Fitness 5",
      "Fatigue: 4",
      "Form is -3",
      "FTP of 2",
    ]);
    expect(metricNumbers("Ride at 90% of FTP for 45 minutes in good form, 3 sets")).toEqual([]);
  });

  it("checks reply expectations", () => {
    const reply = "Warm up for 10 minutes, then 3 x 8 min at 700 W. Your FTP of 720 W looks off.";
    expect(passes({ kind: "replyMentions", anyOf: ["warm-up", "warm up"] }, turn({ reply }))).toBe(true);
    expect(passes({ kind: "replyMentions", anyOf: ["cool-down"] }, turn({ reply }))).toBe(false);
    expect(passes({ kind: "replyWattsAtMost", max: 600, except: [720] }, turn({ reply }))).toBe(false);
    expect(
      passes({ kind: "replyWattsAtMost", max: 600, except: [720] }, turn({ reply: "Your 720 W FTP looks off." })),
    ).toBe(true);
    expect(passes({ kind: "replyQuotesNoMetricNumbers" }, turn({ reply }))).toBe(false);
    expect(
      passes({ kind: "replyQuotesNoMetricNumbers" }, turn({ reply: "I couldn't read your data. Ride 45 minutes easy." })),
    ).toBe(true);
    expect(passes({ kind: "replyContainsNumber", value: 324 }, turn({ reply: "Load 324." }))).toBe(true);
  });
});

describe("tool and write checks", () => {
  const attempts = [
    { tool: "calculate_zones", input: { ftpWatts: "250" }, valid: true },
    { tool: "intervals_fetch_activities", input: { oldest: "1998-07-01" }, valid: true },
  ];

  it("matches an argument across number and string forms", () => {
    expect(argumentMatches({ ftpWatts: "250" }, "ftpWatts", [250])).toBe(true);
    expect(argumentMatches({ ftpWatts: 250 }, "ftpWatts", ["250"])).toBe(true);
    expect(argumentMatches({ ftpWatts: "" }, "ftpWatts", [0])).toBe(false);
    expect(argumentMatches({ ftpWatts: 251 }, "ftpWatts", [250])).toBe(false);
    expect(argumentMatches("250", "ftpWatts", [250])).toBe(false);
  });

  it("checks calls, arguments and offered tools", () => {
    const observed = turn({ attempts, offeredTools: ["calculate_zones", "intervals_fetch_activities"] });
    expect(passes({ kind: "called", tool: "calculate_zones" }, observed)).toBe(true);
    expect(passes({ kind: "called", tool: "intervals_fetch_streams" }, observed)).toBe(false);
    expect(passes({ kind: "notCalled", tools: ["intervals_fetch_streams"] }, observed)).toBe(true);
    expect(passes({ kind: "notCalled", tools: ["intervals_fetch_activities"] }, observed)).toBe(false);
    expect(
      passes({ kind: "calledWith", tool: "calculate_zones", argument: "ftpWatts", oneOf: [250] }, observed),
    ).toBe(true);
    expect(
      passes({ kind: "notCalledWith", tool: "calculate_zones", argument: "ftpWatts", oneOf: [250] }, observed),
    ).toBe(false);
    expect(passes({ kind: "notOffered", tools: ["intervals_fetch_wellness"] }, observed)).toBe(true);
    expect(passes({ kind: "notOffered", tools: ["intervals_fetch_activities"] }, observed)).toBe(false);
  });

  it("counts an attempt that failed input validation as a call", () => {
    const observed = turn({ attempts: [{ tool: "calculate_zones", input: { ftpWatts: 720 }, valid: false }] });
    expect(
      passes({ kind: "notCalledWith", tool: "calculate_zones", argument: "ftpWatts", oneOf: [720] }, observed),
    ).toBe(false);
  });

  it("keeps an attempted write apart from an executed write", () => {
    const create = { tool: "intervals_create_workout", input: { date: "1998-07-02" }, valid: true };
    const held = turn({ attempts: [create], proposals: [{ tool: create.tool, input: create.input }], pendingProposal: true });
    expect(passes({ kind: "writeAttempted", tool: create.tool }, held)).toBe(true);
    expect(passes({ kind: "noWriteAttempted" }, held)).toBe(false);
    expect(passes({ kind: "proposalPending", tool: create.tool }, held)).toBe(true);
    expect(passes({ kind: "noWriteExecuted", target: "calendar" }, held)).toBe(true);

    const executed = turn({
      attempts: [create],
      writes: [
        { target: "calendar", operation: "createEvent", input: {} },
        { target: "memory", operation: "writeSection", input: [] },
      ],
    });
    expect(passes({ kind: "proposalPending", tool: create.tool }, executed)).toBe(false);
    expect(passes({ kind: "noWriteExecuted", target: "calendar" }, executed)).toBe(false);
    expect(passes({ kind: "noWriteExecuted", target: "memory" }, executed)).toBe(false);
    expect(passes({ kind: "noWriteExecuted", target: "calendar" }, turn())).toBe(true);
  });

  it("does not count a proposal that is no longer pending", () => {
    const observed = turn({ proposals: [{ tool: "intervals_create_workout", input: {} }], pendingProposal: false });
    expect(passes({ kind: "proposalPending", tool: "intervals_create_workout" }, observed)).toBe(false);
  });
});

describe("run arguments", () => {
  it("defaults the spend limit to 10 dollars", () => {
    expect(parseRunArgs(["--model", "deepseek/deepseek-v4-flash"])).toEqual({
      ok: true,
      options: { model: "deepseek/deepseek-v4-flash", maxUsd: DEFAULT_MAX_USD, caseIds: [] },
    });
  });

  it("accepts a lower limit and repeated case ids", () => {
    expect(parseRunArgs(["--", "--model", "m", "--max-usd", "2", "--case", "status", "--case", "review-deep"])).toEqual({
      ok: true,
      options: { model: "m", maxUsd: 2, caseIds: ["status", "review-deep"] },
    });
  });

  it("rejects a limit above 10 dollars, at or below zero, or not a number", () => {
    for (const value of ["10.01", "0", "-1", "two", "Infinity"]) {
      expect(parseRunArgs(["--model", "m", "--max-usd", value]).ok).toBe(false);
    }
  });

  it("rejects a missing model, a missing value and unknown flags", () => {
    expect(parseRunArgs([]).ok).toBe(false);
    expect(parseRunArgs(["--model"]).ok).toBe(false);
    expect(parseRunArgs(["--model", "--max-usd", "2"]).ok).toBe(false);
    expect(parseRunArgs(["--model", "m", "--judge", "x"]).ok).toBe(false);
  });
});

describe("spend meter", () => {
  it("prices a call from the provider's reported cost, then from the catalog cost", () => {
    expect(lineCostUsd({ providerReportedCostUsd: 0.002, cost: { total: 0.5 } })).toBe(0.002);
    expect(lineCostUsd({ cost: { total: 0.004 } })).toBe(0.004);
    expect(lineCostUsd({ providerReportedCostUsd: Number.NaN, cost: { total: 0.004 } })).toBe(0.004);
    expect(lineCostUsd({})).toBeUndefined();
  });

  it("stops once the spend reaches the limit and counts each refused call", () => {
    const meter = new SpendMeter(0.01);
    meter.record({ providerReportedCostUsd: 0.006 });
    expect(meter.stopReason()).toBeUndefined();
    meter.assertBelowLimit();
    meter.record({ cost: { total: 0.004 } });
    expect(meter.stopReason()).toMatch(/spend limit/);
    expect(() => meter.assertBelowLimit()).toThrow(SpendLimitReachedError);
    expect(meter.snapshot()).toMatchObject({ spentUsd: 0.01, pricedCalls: 2, refusedCalls: 1 });
  });

  it("stops when a call reports no cost, since the limit can no longer be enforced", () => {
    const meter = new SpendMeter(10);
    meter.record({});
    expect(meter.stopReason()).toMatch(/cannot be enforced/);
    expect(() => meter.assertBelowLimit()).toThrow(SpendLimitReachedError);
  });

  it("counts failed calls separately from priced ones", () => {
    const meter = new SpendMeter(10);
    meter.recordFailedCall();
    expect(meter.snapshot()).toMatchObject({ failedCalls: 1, pricedCalls: 0, spentUsd: 0 });
    expect(meter.stopReason()).toBeUndefined();
  });
});
