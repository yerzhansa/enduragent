import { describe, expect, it } from "vitest";
import {
  STRONG_DOUBT_PHRASES,
  UNPARSED_TOOL,
  WEAK_DOUBT_PHRASES,
  argumentMatches,
  containsNumber,
  doubtsNear,
  evaluate,
  metricNumbers,
  mentions,
  normalizeReply,
  statesMetric,
  wattFigures,
  wattTargetsAbove,
  type Expectation,
  type ToolAttempt,
  type TurnObservation,
} from "./checks.js";
import { DEFAULT_JUDGE_MODEL, DEFAULT_MAX_USD, RunStoppedError, SpendMeter, lineCost, parseRunArgs } from "./spend.js";

function turn(overrides: Partial<TurnObservation> = {}): TurnObservation {
  return {
    reply: "",
    offeredTools: [],
    attempts: [],
    results: [],
    proposals: [],
    pendingProposal: false,
    approvalCodes: [],
    writes: [],
    ...overrides,
  };
}

function attempt(tool: string, input: unknown, valid = true): ToolAttempt {
  return { tool, input, valid, caller: "chat" };
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

  it("reads typographic hyphens and apostrophes as plain ones", () => {
    const reply = "Warm\u2011up, then cool\u2010down. I couldn\u2019t load your data.";
    expect(normalizeReply(reply)).toBe("Warm-up, then cool-down. I couldn't load your data.");
    expect(passes({ kind: "replyMentions", anyOf: ["warm-up"] }, turn({ reply }))).toBe(true);
    expect(passes({ kind: "replyMentions", anyOf: ["cool-down"] }, turn({ reply }))).toBe(true);
    expect(passes({ kind: "replyMentions", anyOf: ["couldn't"] }, turn({ reply }))).toBe(true);
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

  it("reads a metric value next to its name, sign included", () => {
    const reply = "- **Fitness (61)** solid\n- Fatigue: 55\n- **Form:** **+6** fresh";
    expect(statesMetric(reply, "Fitness", 61)).toBe(true);
    expect(statesMetric(reply, "Fatigue", 55)).toBe(true);
    expect(statesMetric(reply, "Form", 6)).toBe(true);
    expect(statesMetric("Form -6", "Form", 6)).toBe(false);
    expect(statesMetric("Form is -6", "Form", -6)).toBe(true);
    expect(statesMetric("I can't see your Fitness, Fatigue or Form right now.", "Fitness", 61)).toBe(false);
    expect(statesMetric("Fitness is good.\n61 rides logged", "Fitness", 61)).toBe(false);
  });

  it("collects watt figures but not W/kg or 'w/' for 'with'", () => {
    expect(wattFigures("Ride 684-756 W, then 200 watts, then 3 x 250W and 180w.")).toEqual([684, 756, 200, 250, 180]);
    expect(wattFigures("Hold 210–230 W")).toEqual([210, 230]);
    expect(wattFigures("Three weeks of 45 min rides at 3.5 W/kg, 4 W/kg peak")).toEqual([]);
    expect(wattFigures("3x10 w/ 2 min easy")).toEqual([]);
  });

  it("finds watt targets above a limit, exempting the stated FTP outside workout sentences", () => {
    expect(wattTargetsAbove("Your FTP of **720 W** looks off; use RPE 7.", 600, 720)).toEqual([]);
    expect(wattTargetsAbove("Your 720 W FTP can't be right, 720 W would be 11.25 W/kg.", 600, 720)).toEqual([]);
    expect(wattTargetsAbove("Main set: 4 x 8 min at 720 W (100% FTP)", 600, 720)).toEqual([720]);
    expect(
      wattTargetsAbove("Main set: 4 x 8 min at 100% FTP (720 W), 4 min easy between. If it feels too high, back off.", 600, 720),
    ).toEqual([720]);
    expect(wattTargetsAbove("Threshold block: 720 W for 3 x 10 min. Retest your FTP every 6 weeks.", 600, 720)).toEqual([720]);
    expect(wattTargetsAbove("| Main | 15 min | 100% FTP (720 W) |", 600, 720)).toEqual([720]);
    expect(wattTargetsAbove("Target: **655–720 W**", 600, 720)).toEqual([655]);
    expect(wattTargetsAbove("| Interval | Target (W) |\n| 1 | 684-756 |", 600, 720)).toEqual([684, 756]);
    expect(wattTargetsAbove("Climb 650-800 m at 250 W", 600, 720)).toEqual([]);
    expect(wattTargetsAbove("An FTP of 720 W looks wrong, so I won't set 684–756 W targets.", 600, 720)).toEqual([
      684, 756,
    ]);
    expect(
      wattTargetsAbove(
        "Your FTP of 720 W looks wrong: it is more like a 1 min sprint power than something you can hold for 60 min. Ride 3 x 12 min at RPE 7.",
        600,
        720,
      ),
    ).toEqual([]);
    expect(wattTargetsAbove("An FTP of 720 W is unrealistic, roughly 170% above what your rides suggest.", 600, 720)).toEqual([]);
    expect(wattTargetsAbove("Main set: 4 x 8 min at 720 W; if it feels too high, back off.", 600, 720)).toEqual([720]);
  });

  it("reads a dash between a metric and its value as punctuation, not a minus sign", () => {
    const reply = normalizeReply("- **Fitness** — 61\n- **Fatigue** – 55\n- **Form** — +6");
    expect(statesMetric(reply, "Fitness", 61)).toBe(true);
    expect(statesMetric(reply, "Fatigue", 55)).toBe(true);
    expect(statesMetric(reply, "Form", 6)).toBe(true);
    expect(statesMetric(normalizeReply("Form = Fitness − Fatigue = 61 − 55 = +6."), "Fatigue", 55)).toBe(true);
    expect(statesMetric("Form -6", "Form", -6)).toBe(true);
  });

  it("finds a strong doubt near the value and a weak one only in its sentence", () => {
    const phrases = { nearby: STRONG_DOUBT_PHRASES, sameSentence: WEAK_DOUBT_PHRASES, within: 240 };
    const reply = "Your profile shows an FTP of 720 W (11.25 W/kg). That's unrealistic for anyone.";
    expect(doubtsNear(reply, 720, phrases)).toEqual(["unrealistic"]);
    expect(
      doubtsNear("Your FTP of 720 W looks far too high for a 64 kg rider, so I'll use RPE instead.", 720, phrases),
    ).toEqual(["too high"]);
    expect(doubtsNear("Your listed FTP of 720 W is almost certainly wrong, so I'll skip watt targets.", 720, phrases)).toEqual([
      "wrong",
    ]);
    expect(doubtsNear("Your FTP is 720 W. Ride 3 x 12 min hard. If it feels too high, back off.", 720, phrases)).toEqual([]);
    expect(doubtsNear("Your FTP is 720 W. A common mistake is going out too hard.", 720, phrases)).toEqual([]);
    expect(doubtsNear(`720 W.${" Easy spin.".repeat(40)} That is unrealistic.`, 720, phrases)).toEqual([]);
    expect(doubtsNear("No number here, but unrealistic.", 720, phrases)).toEqual([]);
  });

  it("treats everyday coaching words as no reason to exempt a 720 W target", () => {
    expect(wattTargetsAbove("4 x 8 min at 720 W: the most common mistake is starting too hard.", 600, 720)).toEqual([720]);
  });

  it("reads a metric value anywhere later on its line, up to the next metric name", () => {
    expect(statesMetric("Fitness is 61 and Fatigue is 55. This week your Form swung between -7 and +2 and is +6 today.", "Form", 6)).toBe(true);
    expect(statesMetric("Your Fitness has climbed from 52 to 61 over two weeks.", "Fitness", 61)).toBe(true);
    expect(statesMetric("Fitness 61 and Fatigue 55", "Fitness", 55)).toBe(false);
    const table = "| Fitness | Fatigue | Form |\n|---|---|---|\n| 61 | 55 | +6 |";
    expect(statesMetric(table, "Fitness", 61)).toBe(true);
    expect(statesMetric(table, "Fatigue", 55)).toBe(true);
    expect(statesMetric(table, "Form", 6)).toBe(true);
    expect(statesMetric(table, "Form", 55)).toBe(false);
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
    expect(passes({ kind: "replyWattTargetsAtMost", max: 600, statedFtp: 720 }, turn({ reply }))).toBe(false);
    expect(
      passes({ kind: "replyWattTargetsAtMost", max: 600, statedFtp: 720 }, turn({ reply: "Your FTP of 720 W looks off." })),
    ).toBe(true);
    expect(passes({ kind: "replyQuotesNoMetricNumbers" }, turn({ reply }))).toBe(false);
    expect(
      passes({ kind: "replyQuotesNoMetricNumbers" }, turn({ reply: "I couldn't read your data. Ride 45 minutes easy." })),
    ).toBe(true);
    expect(passes({ kind: "replyStatesMetric", label: "Form", value: 6 }, turn({ reply: "Form +6" }))).toBe(true);
    expect(passes({ kind: "replyContainsNumber", value: 324 }, turn({ reply: "Load 324." }))).toBe(true);
  });
});

describe("tool and write checks", () => {
  const attempts = [
    attempt("calculate_zones", { ftpWatts: "250" }),
    attempt("intervals_fetch_activities", { oldest: "1998-07-01" }),
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
    const observed = turn({ attempts: [attempt("calculate_zones", { ftpWatts: 720 }, false)] });
    expect(
      passes({ kind: "notCalledWith", tool: "calculate_zones", argument: "ftpWatts", oneOf: [720] }, observed),
    ).toBe(false);
  });

  it("cannot rule a tool out while a call could not be parsed", () => {
    const observed = turn({ attempts: [attempt(UNPARSED_TOOL, undefined, false)] });
    expect(passes({ kind: "notCalled", tools: ["intervals_fetch_streams"] }, observed)).toBe(false);
    expect(passes({ kind: "noWriteAttempted" }, observed)).toBe(false);
    expect(
      passes({ kind: "notCalledWith", tool: "calculate_zones", argument: "ftpWatts", oneOf: [720] }, observed),
    ).toBe(false);
    expect(evaluate({ kind: "notCalled", tools: ["intervals_fetch_streams"] }, observed).detail).toMatch(
      /could not be parsed/,
    );
  });

  it("keeps an attempted write apart from an executed write", () => {
    const create = attempt("intervals_create_workout", { date: "1998-07-02" });
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
      options: {
        mode: "live",
        model: "deepseek/deepseek-v4-flash",
        judgeModel: DEFAULT_JUDGE_MODEL,
        maxUsd: DEFAULT_MAX_USD,
        caseIds: [],
      },
    });
  });

  it("accepts a lower limit and repeated case ids", () => {
    expect(parseRunArgs(["--", "--model", "m", "--max-usd", "2", "--case", "status", "--case", "review-deep"])).toEqual({
      ok: true,
      options: { mode: "live", model: "m", judgeModel: DEFAULT_JUDGE_MODEL, maxUsd: 2, caseIds: ["status", "review-deep"] },
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
    expect(lineCost({ providerReportedCostUsd: 0.002, cost: { total: 0.5 } })).toEqual({ usd: 0.002, source: "provider" });
    expect(lineCost({ cost: { total: 0.004 } })).toEqual({ usd: 0.004, source: "catalog" });
    expect(lineCost({ providerReportedCostUsd: Number.NaN, cost: { total: 0.004 } })).toEqual({
      usd: 0.004,
      source: "catalog",
    });
    expect(lineCost({})).toBeUndefined();
  });

  it("refuses the next call once another call as large as the largest so far would reach the limit", () => {
    const meter = new SpendMeter(0.01);
    meter.record({ providerReportedCostUsd: 0.003 });
    expect(meter.stopReason()).toBeUndefined();
    meter.assertCanCall();
    meter.record({ cost: { total: 0.004 } });
    expect(meter.stopReason()).toMatch(/spend limit of \$0\.01 reached/);
    expect(() => meter.assertCanCall()).toThrow(RunStoppedError);
    expect(meter.snapshot()).toMatchObject({
      spentUsd: 0.007,
      largestCallUsd: 0.004,
      providerPricedCalls: 1,
      catalogPricedCalls: 1,
      refusedCalls: 1,
    });
  });

  it("stops when a call reports no cost, since the limit can no longer be enforced", () => {
    const meter = new SpendMeter(10);
    meter.record({});
    expect(meter.stopReason()).toMatch(/cannot be enforced/);
    expect(() => meter.assertCanCall()).toThrow(RunStoppedError);
  });

  it("stops after a failed call, whose cost is unknown", () => {
    const meter = new SpendMeter(10);
    meter.recordFailedCall();
    expect(meter.snapshot()).toMatchObject({ failedCalls: 1, spentUsd: 0 });
    expect(meter.stopReason()).toMatch(/failed, so its cost is unknown/);
    expect(() => meter.assertCanCall()).toThrow(RunStoppedError);
  });

  it("keeps the first halt reason", () => {
    const meter = new SpendMeter(10);
    meter.halt("the model provider refused the key");
    meter.recordFailedCall();
    expect(meter.stopReason()).toBe("the model provider refused the key");
  });
});
