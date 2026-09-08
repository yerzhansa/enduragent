import { describe, it, expect } from "vitest";

import type { UsageLedgerLine } from "../packages/core/src/usage-ledger.js";
import {
  parseCli,
  resolveDataDir,
  parseLedger,
  selectLines,
  percentile,
  mean,
  safeDiv,
  buildReport,
} from "./usage-baseline.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed anchor; the tool never reads wall-clock

function line(over: Partial<UsageLedgerLine>): UsageLedgerLine {
  return {
    ts: T0,
    kind: "turn",
    provider: "anthropic",
    model: "claude",
    durationMs: 1000,
    caller: "chat",
    ...over,
  };
}
function jsonl(lines: UsageLedgerLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("percentile — nearest-rank, deterministic", () => {
  it("returns null on an empty sample", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("p50 of [1,2,3,4] is 2 (rank ceil(0.5*4)=2)", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
  it("p95 of 1..100 is 95", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(vals, 95)).toBe(95);
  });
  it("p0 is the min, p100 is the max", () => {
    expect(percentile([5, 1, 9, 3], 0)).toBe(1);
    expect(percentile([5, 1, 9, 3], 100)).toBe(9);
  });
  it("single element returns that element at every percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("mean / safeDiv guards", () => {
  it("mean of empty is null", () => {
    expect(mean([])).toBeNull();
  });
  it("safeDiv guards zero / negative / NaN denominators", () => {
    expect(safeDiv(5, 0)).toBeNull();
    expect(safeDiv(5, -1)).toBeNull();
    expect(safeDiv(5, NaN)).toBeNull();
    expect(safeDiv(4, 2)).toBe(2);
  });
});

describe("parseLedger", () => {
  it("skips blank and malformed lines, keeps well-formed ones", () => {
    const raw = [JSON.stringify(line({})), "", "{ not json", "null", JSON.stringify({ foo: 1 })].join(
      "\n",
    );
    expect(parseLedger(raw)).toHaveLength(1);
  });
});

describe("selectLines — kind + caller filter", () => {
  const lines = [
    line({ kind: "turn", caller: "chat" }),
    line({ kind: "turn", caller: "flush" }),
    line({ kind: "generate", caller: "chat" }),
    line({ kind: "boot", caller: undefined }),
  ];
  it("defaults to kind=turn caller=chat", () => {
    expect(selectLines(lines, "turn", "chat")).toHaveLength(1);
  });
  it("--kind generate selects the generate line", () => {
    expect(selectLines(lines, "generate", "chat")).toHaveLength(1);
  });
  it("caller=all keeps every line of the kind", () => {
    expect(selectLines(lines, "turn", "all")).toHaveLength(2);
  });
  it("--kind boot ignores the caller filter (boot lines carry no caller)", () => {
    expect(selectLines(lines, "boot", "chat")).toHaveLength(1);
  });
});

describe("parseCli", () => {
  it("defaults to kind=turn caller=chat json=false", () => {
    expect(parseCli([])).toEqual({ kind: "turn", caller: "chat", json: false });
  });
  it("accepts --flag value and --flag=value spellings", () => {
    expect(parseCli(["--data-dir", "/tmp/x", "--kind", "generate"])).toMatchObject({
      dataDir: "/tmp/x",
      kind: "generate",
    });
    expect(parseCli(["--data-dir=/tmp/y", "--caller=all", "--json"])).toMatchObject({
      dataDir: "/tmp/y",
      caller: "all",
      json: true,
    });
  });
  it("rejects unknown flags and bad enum values", () => {
    expect(() => parseCli(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseCli(["--kind", "bogus"])).toThrow(/--kind/);
  });
  it("rejects an empty required value (avoids silent fallback to the real home)", () => {
    expect(() => parseCli(["--data-dir="])).toThrow(/non-empty value/);
    expect(() => parseCli(["--data-dir", ""])).toThrow(/non-empty value/);
  });
  it("rejects an inline value on the boolean --json flag", () => {
    expect(() => parseCli(["--json=false"])).toThrow(/--json takes no value/);
  });
});

describe("resolveDataDir precedence", () => {
  it("--data-dir wins over env", () => {
    const prev = process.env.CYCLING_COACH_HOME;
    process.env.CYCLING_COACH_HOME = "/env/path";
    try {
      expect(resolveDataDir("/flag/path")).toEqual({ dir: "/flag/path", source: "--data-dir" });
    } finally {
      if (prev === undefined) delete process.env.CYCLING_COACH_HOME;
      else process.env.CYCLING_COACH_HOME = prev;
    }
  });
  it("env is used when no flag is given", () => {
    const prev = process.env.CYCLING_COACH_HOME;
    process.env.CYCLING_COACH_HOME = "/env/path";
    try {
      expect(resolveDataDir(undefined)).toEqual({
        dir: "/env/path",
        source: "CYCLING_COACH_HOME",
      });
    } finally {
      if (prev === undefined) delete process.env.CYCLING_COACH_HOME;
      else process.env.CYCLING_COACH_HOME = prev;
    }
  });
});

describe("buildReport", () => {
  it("groups by templateHash; absent => 'unknown'", () => {
    const raw = jsonl([
      line({ ts: T0, templateHash: "aaa" }),
      line({ ts: T0 + DAY, templateHash: "aaa" }),
      line({ ts: T0 + 2 * DAY }), // no templateHash
    ]);
    const r = buildReport({ ledgerPath: "/p", dataDirSource: "--data-dir", raw, kind: "turn", caller: "chat" });
    const hashes = r.groups.map((g) => g.templateHash);
    expect(hashes).toEqual(["aaa", "unknown"]); // sorted
    expect(r.groups.find((g) => g.templateHash === "aaa")!.count).toBe(2);
  });

  it("computes a >=3-day span without a warning, <3 days warns", () => {
    const wide = buildReport({
      ledgerPath: "/p",
      dataDirSource: "x",
      raw: jsonl([line({ ts: T0 }), line({ ts: T0 + 4 * DAY })]),
      kind: "turn",
      caller: "chat",
    });
    expect(wide.window.spanDays).toBeCloseTo(4);
    expect(wide.window.spanWarning).toBeNull();

    const narrow = buildReport({
      ledgerPath: "/p",
      dataDirSource: "x",
      raw: jsonl([line({ ts: T0 }), line({ ts: T0 + DAY })]),
      kind: "turn",
      caller: "chat",
    });
    expect(narrow.window.spanWarning).toMatch(/below the 3-day minimum/);
  });

  it("cache-read: per-line mean/p50 + overall ratio, divide-by-zero safe", () => {
    const raw = jsonl([
      line({ inputTokens: 100, cacheReadTokens: 50 }), // ratio 0.5
      line({ inputTokens: 200, cacheReadTokens: 200 }), // ratio 1.0
      line({ inputTokens: 0, cacheReadTokens: 0 }), // excluded (no positive input)
      line({ inputTokens: undefined, cacheReadTokens: 10 }), // excluded
    ]);
    const g = buildReport({ ledgerPath: "/p", dataDirSource: "x", raw, kind: "turn", caller: "chat" }).groups[0];
    expect(g.cacheRead.ratioSampleSize).toBe(2);
    expect(g.cacheRead.perLineRatioMean).toBeCloseTo(0.75);
    expect(g.cacheRead.perLineRatioP50).toBe(0.5); // nearest-rank p50 of [0.5,1.0] -> rank ceil(0.5*2)=1 -> sorted[0]=0.5
    expect(g.cacheRead.overallRatio).toBeCloseTo(250 / 300); // sum-based
  });

  it("an all-zero-input group yields null ratios, never NaN", () => {
    const raw = jsonl([line({ inputTokens: 0, cacheReadTokens: 0 })]);
    const g = buildReport({ ledgerPath: "/p", dataDirSource: "x", raw, kind: "turn", caller: "chat" }).groups[0];
    expect(g.cacheRead.perLineRatioMean).toBeNull();
    expect(g.cacheRead.overallRatio).toBeNull();
  });

  it("cost: repriced from tokens on the uncached input share, never read from the ledger", () => {
    const priced = {
      model: "claude-sonnet-5",
      inputTokens: 10_000,
      outputTokens: 100,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_000,
    };
    const inflated = { input: 0.02, output: 0.001, cacheRead: 0.0016, cacheWrite: 0.0025, total: 0.0251 };
    const raw = jsonl([
      line({ ...priced, cost: inflated }),
      line({ ...priced }),
      line({ model: "not-in-catalog", inputTokens: 500, cost: inflated }),
    ]);
    const g = buildReport({ ledgerPath: "/p", dataDirSource: "x", raw, kind: "turn", caller: "chat" }).groups[0];
    const perLine = (1_000 * 2 + 8_000 * 0.2 + 1_000 * 2.5 + 100 * 10) / 1_000_000;
    expect(g.cost.costedLines).toBe(2);
    expect(g.cost.total).toBeCloseTo(2 * perLine, 9);
    expect(g.cost.meanPerTurn).toBeCloseTo(perLine, 9);
  });

  it("latency percentiles use durationMs", () => {
    const raw = jsonl([1, 2, 3, 4].map((d) => line({ durationMs: d * 1000 })));
    const g = buildReport({ ledgerPath: "/p", dataDirSource: "x", raw, kind: "turn", caller: "chat" }).groups[0];
    expect(g.latencyMs.p50).toBe(2000);
    expect(g.latencyMs.min).toBe(1000);
    expect(g.latencyMs.max).toBe(4000);
  });

  it("empty selection: no groups, span null, warning set", () => {
    const r = buildReport({ ledgerPath: "/p", dataDirSource: "x", raw: "", kind: "turn", caller: "chat" });
    expect(r.groups).toHaveLength(0);
    expect(r.window.spanDays).toBeNull();
    expect(r.window.spanWarning).toMatch(/no selected lines/);
  });
});
