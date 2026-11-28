import { describe, expect, it } from "vitest";
import { TurnUsageLedger, sumTurnUsage } from "../src/agent/turn-usage.js";
import type { UsageCost, UsageLedgerLine } from "../src/host-ports.js";

function cost(total: number): UsageCost {
  return { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total };
}

function call(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
  return {
    ts: 1,
    kind: "generate",
    caller: "chat",
    provider: "openrouter",
    model: "synthetic-model",
    durationMs: 5,
    turnId: "turn-a",
    outcome: "ok",
    steps: 1,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    catalogRevision: 3,
    costBasis: "actual",
    cost: cost(0.02),
    providerReportedCostUsd: 0.03,
    ...overrides,
  };
}

const failedWithoutUsage = call({
  outcome: "error",
  errorClass: "server_error",
  steps: 0,
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
  cost: undefined,
  providerReportedCostUsd: undefined,
  costBasis: undefined,
});

describe("sumTurnUsage", () => {
  it("counts a failed call with no usage as a known zero", () => {
    const total = sumTurnUsage([call(), failedWithoutUsage, call({ inputTokens: 6 })]);

    expect(total).toMatchObject({
      steps: 2,
      inputTokens: 16,
      outputTokens: 8,
      totalTokens: 28,
      costBasis: "actual",
      catalogRevision: 3,
    });
    expect(total.cost?.total).toBeCloseTo(0.04, 12);
    expect(total.providerReportedCostUsd).toBeCloseTo(0.06, 12);
  });

  it("adds a failed call's known usage to the total", () => {
    const failedWithUsage = call({
      outcome: "error",
      errorClass: "timeout",
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      cost: cost(0.01),
      providerReportedCostUsd: 0.015,
    });

    const total = sumTurnUsage([failedWithUsage, call()]);

    expect(total.inputTokens).toBe(17);
    expect(total.cost?.total).toBeCloseTo(0.03, 12);
    expect(total.providerReportedCostUsd).toBeCloseTo(0.045, 12);
  });

  it("leaves cost unknown when a call that reported usage has no price", () => {
    const total = sumTurnUsage([
      call(),
      call({ cost: undefined, providerReportedCostUsd: undefined }),
    ]);

    expect(total.inputTokens).toBe(20);
    expect(total.cost).toBeUndefined();
    expect(total.providerReportedCostUsd).toBeUndefined();
  });

  it("drops a cost basis the calls do not share", () => {
    expect(sumTurnUsage([call(), call({ costBasis: "notional" })]).costBasis).toBeUndefined();
  });

  it("reports no usage for a turn whose only call failed before reporting any", () => {
    expect(sumTurnUsage([failedWithoutUsage])).toMatchObject({
      steps: 0,
      inputTokens: undefined,
      cost: undefined,
      providerReportedCostUsd: undefined,
    });
  });
});

describe("TurnUsageLedger", () => {
  function ledger(fail = false) {
    const rows: UsageLedgerLine[] = [];
    const warnings: string[] = [];
    const turns = new TurnUsageLedger(
      {
        append: (line) => {
          if (fail && line.kind === "turn") throw new Error("disk full");
          rows.push(line);
        },
      },
      { provider: "openrouter", model: "synthetic-model" },
      {
        debug: () => undefined,
        info: () => undefined,
        warn: (event) => warnings.push(event),
        error: () => undefined,
      },
    );
    return { rows, warnings, turns };
  }

  const timing = { ts: 9, durationMs: 40, templateHash: "0123456789abcdef" };

  it("sums only this turn's chat calls and forwards every row", () => {
    const { rows, turns } = ledger();
    turns.begin("turn-a");
    turns.port.append(call());
    turns.port.append(call({ caller: "compact", inputTokens: 500 }));
    turns.port.append(call({ turnId: "turn-b", inputTokens: 900 }));
    turns.port.append(call({ kind: "boot", inputTokens: 700 }));
    turns.end("turn-a", { ok: true }, timing);

    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({
      ts: 9,
      kind: "turn",
      caller: "chat",
      provider: "openrouter",
      model: "synthetic-model",
      durationMs: 40,
      turnId: "turn-a",
      templateHash: "0123456789abcdef",
      outcome: "ok",
      inputTokens: 10,
    });
  });

  it("writes one row per turn and maps an interrupted turn to aborted", () => {
    const { rows, turns } = ledger();
    turns.begin("turn-a");
    turns.end("turn-a", { ok: false, error_class: "interrupted" }, timing);
    turns.end("turn-a", { ok: true }, timing);

    expect(rows).toEqual([expect.objectContaining({ outcome: "error", errorClass: "aborted" })]);
  });

  it("writes nothing for a discarded turn", () => {
    const { rows, turns } = ledger();
    turns.begin("turn-a");
    turns.discard("turn-a");
    turns.end("turn-a", { ok: false, error_class: "budget" }, timing);

    expect(rows).toEqual([]);
  });

  it("keeps the turn going when the turn row cannot be written", () => {
    const { rows, warnings, turns } = ledger(true);
    turns.begin("turn-a");
    turns.port.append(call());

    expect(() => turns.end("turn-a", { ok: true }, timing)).not.toThrow();
    expect(rows).toHaveLength(1);
    expect(warnings).toEqual(["turn_usage_row_failed"]);
  });
});
