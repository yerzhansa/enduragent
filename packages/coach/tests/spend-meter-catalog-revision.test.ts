import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageLedgerLine } from "@enduragent/engine";
import { createSpendMeterService } from "../src/spend-meter.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "spend-meter-catalog-"));
  configDir = join(root, "config");
  await mkdir(configDir, { mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function line(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
  return {
    ts: Date.UTC(1998, 6, 6, 12),
    kind: "generate",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 10,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    ...overrides,
  };
}

async function ledger(file: string, values: readonly UsageLedgerLine[]): Promise<void> {
  await writeFile(join(root, file), values.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

describe("spend meter catalog revision", () => {
  it("uses generation-bound cost metadata without repricing historical rows", async () => {
    await ledger("usage-ledger.jsonl", [
      line({
        catalogRevision: 7,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
        cacheReadSavingsUsd: 0.123,
      }),
    ]);

    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();

    expect(summary).toMatchObject({
      knownSpendUsd: 0.037,
      knownCacheReadSavingsUsd: 0.123,
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      spendComplete: true,
      cacheSavingsComplete: true,
    });
  });

  it("keeps unknown generation-bound pricing unknown", async () => {
    await ledger("usage-ledger.jsonl", [line({ catalogRevision: 8 })]);

    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();

    expect(summary).toMatchObject({
      knownSpendUsd: 0,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 1,
      spendComplete: false,
      cacheSavingsComplete: false,
    });
  });
});
