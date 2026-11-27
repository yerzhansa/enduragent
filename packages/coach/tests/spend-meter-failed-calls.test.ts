import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageLedgerLine } from "@enduragent/engine";
import { createSpendMeterService } from "../src/spend-meter.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "spend-meter-failed-"));
  configDir = join(root, "config");
  await mkdir(configDir, { mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pricedCost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 };

function succeeded(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
  return {
    ts: Date.UTC(1998, 6, 6, 12),
    kind: "generate",
    caller: "chat",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 10,
    turnId: "turn-1",
    outcome: "ok",
    steps: 1,
    inputTokens: 1_000,
    outputTokens: 100,
    catalogRevision: 7,
    cost: pricedCost,
    ...overrides,
  };
}

function failedWithoutUsage(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
  return {
    ts: Date.UTC(1998, 6, 6, 13),
    kind: "generate",
    caller: "chat",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 10,
    turnId: "turn-2",
    outcome: "error",
    errorClass: "server_error",
    steps: 0,
    catalogRevision: 7,
    ...overrides,
  };
}

async function summarize(values: readonly UsageLedgerLine[]) {
  await writeFile(
    join(root, "usage-ledger.jsonl"),
    values.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  return createSpendMeterService({
    dataDir: root,
    configDir,
    timezone: "UTC",
    now: () => Date.UTC(1998, 6, 6, 18),
  }).getSpendSummary();
}

describe("spend meter and failed model calls", () => {
  it("counts a failed call with no usage figure as a known zero and stays complete", async () => {
    const summary = await summarize([succeeded(), failedWithoutUsage()]);

    expect(summary).toMatchObject({
      knownSpendUsd: 0.03,
      generationCount: 2,
      pricedGenerationCount: 2,
      unpricedGenerationCount: 0,
      spendComplete: true,
      capStatus: "below",
    });
  });

  it("counts an aborted call and a timed-out call with no usage figure as known zeros", async () => {
    const summary = await summarize([
      failedWithoutUsage({ errorClass: "aborted" }),
      failedWithoutUsage({ errorClass: "timeout", catalogRevision: undefined }),
    ]);

    expect(summary).toMatchObject({
      knownSpendUsd: 0,
      generationCount: 2,
      pricedGenerationCount: 2,
      spendComplete: true,
    });
  });

  it("prices the known usage a failed call reported like any other row", async () => {
    const summary = await summarize([
      failedWithoutUsage({ steps: 1, inputTokens: 1_000, outputTokens: 100, cost: pricedCost }),
    ]);

    expect(summary).toMatchObject({
      knownSpendUsd: 0.03,
      pricedGenerationCount: 1,
      spendComplete: true,
    });
  });

  it("still reports incomplete for a successful call with no usage figure", async () => {
    const summary = await summarize([
      succeeded({ inputTokens: undefined, outputTokens: undefined, cost: undefined }),
    ]);

    expect(summary).toMatchObject({
      generationCount: 1,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 1,
      spendComplete: false,
      capStatus: "unknown",
    });
  });

  it("still reports incomplete for a legacy row with no outcome and no usage figure", async () => {
    const summary = await summarize([
      succeeded({
        outcome: undefined,
        turnId: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        cost: undefined,
      }),
    ]);

    expect(summary).toMatchObject({ unpricedGenerationCount: 1, spendComplete: false });
  });
});
