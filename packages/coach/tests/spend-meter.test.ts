import { appendFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageLedger } from "@enduragent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeCliCacheReadSavingsUsd,
  codexAgentCacheReadSavingsUsd,
  priceClaudeCliInclusiveUsage,
  priceCodexAgentInclusiveUsage,
  priceInclusiveUsage,
  type UsageLedgerLine,
} from "@enduragent/engine";
import {
  DAILY_SPEND_CAP_FILE,
  DEFAULT_DAILY_SPEND_CAP_USD,
  createSpendMeterService,
} from "../src/spend-meter.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "spend-meter-"));
  configDir = join(root, "config");
  await mkdir(configDir, { mode: 0o700 });
});

afterEach(async () => {
  await chmod(configDir, 0o700).catch(() => {});
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

async function ledger(file: string, values: readonly (UsageLedgerLine | string)[]): Promise<void> {
  await writeFile(
    join(root, file),
    values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n") +
      "\n",
  );
}

describe("spend meter service", () => {
  it("aggregates rotated and live generations once with native precedence and honest gaps", async () => {
    await ledger("usage-ledger.jsonl.1", [
      line({
        providerReportedCostUsd: 0.02,
        cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 },
      }),
      line({ kind: "turn", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 } }),
      "not-json",
    ]);
    await ledger("usage-ledger.jsonl", [
      line(),
      line({
        provider: "openrouter",
        model: "openrouter/auto",
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.8 },
      }),
      line({ kind: "boot" }),
    ]);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    const summary = await service.getSpendSummary();
    expect(summary).toMatchObject({
      localDate: "1998-07-06",
      dailyCapUsd: DEFAULT_DAILY_SPEND_CAP_USD,
      generationCount: 3,
      pricedGenerationCount: 2,
      unpricedGenerationCount: 1,
      malformedLineCount: 1,
      spendComplete: false,
      capStatus: "unknown",
      cacheReadTokens: 800,
      knownCacheReadSavingsUsd: 0.00216,
      cacheSavingsComplete: false,
    });
    expect(summary.knownSpendUsd).toBeCloseTo(0.023495, 12);
    expect(summary.routes.map(({ provider, model }) => [provider, model])).toEqual([
      ["anthropic", "claude-sonnet-4-6"],
      ["openrouter", "openrouter/auto"],
    ]);
    expect(summary.routes[0]).toMatchObject({
      generationCount: 2,
      providerReportedGenerationCount: 1,
      caching: "explicit",
      disclosure: null,
    });
    expect(summary.routes[1]).toMatchObject({
      knownSpendUsd: 0,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 1,
      caching: "provider-dependent",
      cacheReadSavingsUsd: 0,
    });
  });

  it("reuses a ledger aggregate while both retained files and the local date are unchanged", async () => {
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.1 })]);
    const readLedger = vi.fn(readUsageLedger);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    const first = await service.getSpendSummary();
    const second = await service.getSpendSummary();

    expect(first).toEqual(second);
    expect(readLedger).toHaveBeenCalledOnce();
  });

  it("invalidates the aggregate when the live ledger is appended", async () => {
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.1 })]);
    const readLedger = vi.fn(readUsageLedger);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    expect(await service.getSpendSummary()).toMatchObject({
      generationCount: 1,
      knownSpendUsd: 0.1,
    });
    await appendFile(
      join(root, "usage-ledger.jsonl"),
      `${JSON.stringify(line({ providerReportedCostUsd: 0.2 }))}\n`,
    );
    const summary = await service.getSpendSummary();
    expect(summary.generationCount).toBe(2);
    expect(summary.knownSpendUsd).toBeCloseTo(0.3, 12);
    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("invalidates across ledger rotation without counting the moved file twice", async () => {
    const livePath = join(root, "usage-ledger.jsonl");
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.1 })]);
    const readLedger = vi.fn(readUsageLedger);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    expect((await service.getSpendSummary()).generationCount).toBe(1);
    await rename(livePath, `${livePath}.1`);
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.2 })]);

    const summary = await service.getSpendSummary();
    expect(summary.generationCount).toBe(2);
    expect(summary.knownSpendUsd).toBeCloseTo(0.3, 12);
    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("invalidates a same-size atomic ledger replacement", async () => {
    const livePath = join(root, "usage-ledger.jsonl");
    const initial = `${JSON.stringify(line({ providerReportedCostUsd: 0.1 }))}\n`;
    const replacement = `${JSON.stringify(line({ providerReportedCostUsd: 0.2 }))}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(initial));
    await writeFile(livePath, initial);
    const readLedger = vi.fn(readUsageLedger);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    expect((await service.getSpendSummary()).knownSpendUsd).toBe(0.1);
    const replacementPath = join(root, "replacement-ledger");
    await writeFile(replacementPath, replacement);
    await rename(replacementPath, livePath);

    expect((await service.getSpendSummary()).knownSpendUsd).toBe(0.2);
    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("recomputes an unchanged ledger after the athlete-local date rolls over", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ ts: Date.UTC(1998, 6, 6, 12), providerReportedCostUsd: 0.1 }),
      line({ ts: Date.UTC(1998, 6, 7, 12), providerReportedCostUsd: 0.2 }),
    ]);
    let currentNow = Date.UTC(1998, 6, 6, 18);
    const readLedger = vi.fn(readUsageLedger);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => currentNow,
      readUsageLedger: readLedger,
    });

    expect(await service.getSpendSummary()).toMatchObject({
      localDate: "1998-07-06",
      knownSpendUsd: 0.1,
    });
    expect((await service.getSpendSummary()).knownSpendUsd).toBe(0.1);
    currentNow = Date.UTC(1998, 6, 7, 18);
    expect(await service.getSpendSummary()).toMatchObject({
      localDate: "1998-07-07",
      knownSpendUsd: 0.2,
    });
    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("reuses the aggregate after a cap write while returning fresh cap status", async () => {
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.3 })]);
    const readLedger = vi.fn(readUsageLedger);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    expect(await service.getSpendSummary()).toMatchObject({
      dailyCapUsd: DEFAULT_DAILY_SPEND_CAP_USD,
      capStatus: "below",
    });
    expect(await service.setDailySpendCap(0.2)).toMatchObject({
      dailyCapUsd: 0.2,
      knownSpendUsd: 0.3,
      capStatus: "reached",
    });
    expect(readLedger).toHaveBeenCalledOnce();
  });

  it("does not cache aggregates for non-regular ledger paths", async () => {
    await mkdir(join(root, "usage-ledger.jsonl"));
    const readLedger = vi.fn(() => ({
      lines: [line({ providerReportedCostUsd: 0.1 })],
      malformedLineCount: 0,
    }));
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    await service.getSpendSummary();
    await service.getSpendSummary();

    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("does not retain an aggregate when a ledger revision changes during its scan", async () => {
    const livePath = join(root, "usage-ledger.jsonl");
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.1 })]);
    const readLedger = vi.fn((dataDir: string) => {
      const result = readUsageLedger(dataDir);
      appendFileSync(livePath, `${JSON.stringify(line({ kind: "turn" }))}\n`);
      return result;
    });
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    await service.getSpendSummary();
    await service.getSpendSummary();

    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("retries a stable ledger after a malformed read result", async () => {
    await ledger("usage-ledger.jsonl", [line({ providerReportedCostUsd: 0.1 })]);
    let readAttempts = 0;
    const readLedger = vi.fn((dataDir: string) => {
      readAttempts += 1;
      return readAttempts === 1 ? { lines: [], malformedLineCount: 1 } : readUsageLedger(dataDir);
    });
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
      readUsageLedger: readLedger,
    });

    expect(await service.getSpendSummary()).toMatchObject({
      generationCount: 0,
      malformedLineCount: 1,
    });
    expect(await service.getSpendSummary()).toMatchObject({
      generationCount: 1,
      malformedLineCount: 0,
      knownSpendUsd: 0.1,
    });
    expect(readLedger).toHaveBeenCalledTimes(2);
  });

  it("uses the athlete timezone boundary, including a daylight-saving zone, and captures now once", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ ts: Date.UTC(1998, 6, 6, 6, 30), providerReportedCostUsd: 0.1 }),
      line({ ts: Date.UTC(1998, 6, 6, 8, 30), providerReportedCostUsd: 0.2 }),
    ]);
    let calls = 0;
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "America/Los_Angeles",
      now: () => {
        calls += 1;
        return Date.UTC(1998, 6, 6, 8);
      },
    });
    const summary = await service.getSpendSummary();
    expect(summary.localDate).toBe("1998-07-06");
    expect(summary.generationCount).toBe(1);
    expect(summary.knownSpendUsd).toBe(0.2);
    expect(calls).toBe(1);
  });

  it("persists a strict mode-0600 cap and uses the known lower bound for reached status", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ providerReportedCostUsd: 0.03 }),
      line({
        provider: "synthetic",
        model: "unpriced",
        inputTokens: undefined,
        outputTokens: undefined,
      }),
    ]);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    const summary = await service.setDailySpendCap(0.02);
    expect(summary.capStatus).toBe("reached");
    expect(summary.spendComplete).toBe(false);
    const path = join(configDir, DAILY_SPEND_CAP_FILE);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, dailyCapUsd: 0.02 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(service.setDailySpendCap(0)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, dailyCapUsd: 0.02 });
  });

  it("preserves the prior cap when an atomic replacement cannot be staged", async () => {
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    await service.setDailySpendCap(0.4);
    const path = join(configDir, DAILY_SPEND_CAP_FILE);
    await chmod(configDir, 0o500);
    await expect(service.setDailySpendCap(0.8)).rejects.toThrow();
    await chmod(configDir, 0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, dailyCapUsd: 0.4 });
  });

  it("falls back on missing, malformed, wrong-version, and extra-field cap files", async () => {
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    expect((await service.getSpendSummary()).dailyCapUsd).toBe(0.5);
    for (const value of [
      "not-json",
      JSON.stringify({ version: 2, dailyCapUsd: 1 }),
      JSON.stringify({ version: 1, dailyCapUsd: -1 }),
      JSON.stringify({ version: 1, dailyCapUsd: 1, extra: true }),
    ]) {
      await writeFile(join(configDir, DAILY_SPEND_CAP_FILE), value);
      expect((await service.getSpendSummary()).dailyCapUsd).toBe(0.5);
    }
  });

  it("counts invalid selected numeric fields as malformed unpriced generations", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ providerReportedCostUsd: -1 }),
      line({ inputTokens: 1.5 }),
    ]);
    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();
    expect(summary).toMatchObject({
      generationCount: 2,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 2,
      malformedLineCount: 2,
      knownSpendUsd: 0,
      capStatus: "unknown",
    });
  });

  it("prices mixed legacy and current Codex rows once and reaches the cap with cached input included", async () => {
    const legacyLine = line({
      provider: "openai-codex",
      model: "gpt-5.2",
      inputTokens: 2_000,
      outputTokens: 0,
      totalTokens: 30_000,
      cacheReadTokens: 28_000,
      cacheWriteTokens: 0,
    });
    const currentLine = line({
      provider: "openai-codex",
      model: "gpt-5.2",
      inputTokens: 30_000,
      outputTokens: 0,
      totalTokens: 30_000,
      cacheReadTokens: 28_000,
      cacheWriteTokens: 0,
    });
    await ledger("usage-ledger.jsonl", [legacyLine]);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });

    const ledgerPath = join(root, "usage-ledger.jsonl");
    const persistedLegacyLine = await readFile(ledgerPath, "utf8");
    const legacySummary = await service.getSpendSummary();
    expect(legacySummary.knownSpendUsd).toBe(0.0084);
    expect(await readFile(ledgerPath, "utf8")).toBe(persistedLegacyLine);

    await ledger("usage-ledger.jsonl", [legacyLine, currentLine]);
    const summary = await service.setDailySpendCap(0.015);

    expect(summary).toMatchObject({
      generationCount: 2,
      pricedGenerationCount: 2,
      unpricedGenerationCount: 0,
      malformedLineCount: 0,
      knownSpendUsd: 0.0168,
      capStatus: "reached",
      cacheReadTokens: 56_000,
    });
    expect(summary.routes).toHaveLength(1);
    expect(summary.routes[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.2",
      generationCount: 2,
      pricedGenerationCount: 2,
      knownSpendUsd: 0.0168,
    });
  });

  it("does not normalize ambiguous Codex rows or any non-Codex provider", async () => {
    await ledger("usage-ledger.jsonl", [
      line({
        provider: "openai-codex",
        model: "gpt-5.2",
        inputTokens: 2_000,
        outputTokens: 0,
        totalTokens: 29_999,
        cacheReadTokens: 28_000,
        cacheWriteTokens: 0,
      }),
      line({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 600,
        outputTokens: 100,
        totalTokens: 1_100,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
      }),
    ]);
    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();

    expect(summary.routes.map((route) => route.provider)).toEqual(["anthropic", "openai-codex"]);
    expect(summary.routes[0].knownSpendUsd).toBeCloseTo(0.002295, 12);
    expect(summary.routes[1].knownSpendUsd).toBe(0.0049);
  });

  it("rejects a truly non-finite token parsed from a raw ledger number", async () => {
    const rawLine = JSON.stringify(
      line({
        provider: "openai-codex",
        model: "gpt-5.2",
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).replace('"inputTokens":1,', '"inputTokens":1e400,');
    await ledger("usage-ledger.jsonl", [rawLine]);

    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();

    expect(summary).toMatchObject({
      generationCount: 1,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 1,
      malformedLineCount: 1,
      knownSpendUsd: 0,
      capStatus: "unknown",
    });
  });

  it("normalizes an exact legacy identity at Number.MAX_SAFE_INTEGER once", async () => {
    const legacyLine = line({
      provider: "openai-codex",
      model: "gpt-5.2",
      inputTokens: Number.MAX_SAFE_INTEGER - 2,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    });
    await ledger("usage-ledger.jsonl", [legacyLine]);
    const ledgerPath = join(root, "usage-ledger.jsonl");
    const persistedLine = await readFile(ledgerPath, "utf8");
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    const expected = priceInclusiveUsage("openai-codex", "gpt-5.2", {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    });
    const unnormalized = priceInclusiveUsage("openai-codex", "gpt-5.2", {
      inputTokens: Number.MAX_SAFE_INTEGER - 2,
      outputTokens: 0,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    });

    const first = await service.getSpendSummary();
    const second = await service.getSpendSummary();

    expect(expected).toBeDefined();
    expect(expected?.total).not.toBe(unnormalized?.total);
    expect(first).toMatchObject({
      generationCount: 1,
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      malformedLineCount: 0,
      knownSpendUsd: expected?.total,
    });
    expect(second.knownSpendUsd).toBe(expected?.total);
    expect(await readFile(ledgerPath, "utf8")).toBe(persistedLine);
  });

  it("does not guess a legacy identity when individually safe components overflow", async () => {
    const ambiguousLine = line({
      provider: "openai-codex",
      model: "gpt-5.2",
      inputTokens: 100,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });
    await ledger("usage-ledger.jsonl", [ambiguousLine]);
    const expected = priceInclusiveUsage("openai-codex", "gpt-5.2", {
      inputTokens: 100,
      outputTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });
    const guessed = priceInclusiveUsage("openai-codex", "gpt-5.2", {
      inputTokens: 150,
      outputTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });

    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();

    expect(expected).toBeDefined();
    expect(expected?.total).not.toBe(guessed?.total);
    expect(summary).toMatchObject({
      generationCount: 1,
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      malformedLineCount: 0,
      knownSpendUsd: expected?.total,
    });
  });
});

describe("claude-cli notional usage", () => {
  function claudeCliLine(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
    return line({
      provider: "claude-cli",
      model: "sonnet",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costBasis: "notional",
      ...overrides,
    });
  }

  const notionalUsage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  async function summarize() {
    return createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();
  }

  it("prices a subscription generation without accruing it against the cap", async () => {
    await ledger("usage-ledger.jsonl", [claudeCliLine()]);
    const expected = priceClaudeCliInclusiveUsage("sonnet", notionalUsage);

    const summary = await summarize();

    expect(expected?.total).toBeGreaterThan(DEFAULT_DAILY_SPEND_CAP_USD);
    expect(summary).toMatchObject({
      generationCount: 1,
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      malformedLineCount: 0,
      spendComplete: true,
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
      capStatus: "below",
    });
    expect(summary.routes[0]).toMatchObject({
      provider: "claude-cli",
      model: "sonnet",
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
      providerReportedGenerationCount: 0,
    });
  });

  it("prices an uncatalogued model id at the family fallback instead of leaving the cap unknown", async () => {
    await ledger("usage-ledger.jsonl", [claudeCliLine({ model: "claude-sonnet-9-20990101" })]);
    const expected = priceClaudeCliInclusiveUsage("claude-sonnet-9-20990101", notionalUsage);

    const summary = await summarize();

    expect(summary).toMatchObject({
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      spendComplete: true,
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
      capStatus: "below",
    });
  });

  it("keeps a subscription row out of accrual when an older line carries no cost basis", async () => {
    await ledger("usage-ledger.jsonl", [claudeCliLine({ costBasis: undefined })]);

    const summary = await summarize();

    expect(summary).toMatchObject({
      pricedGenerationCount: 1,
      knownSpendUsd: 0,
      capStatus: "below",
    });
    expect(summary.notionalSpendUsd).toBeGreaterThan(0);
  });

  it("accrues api-key billing normally and can reach the cap", async () => {
    await ledger("usage-ledger.jsonl", [
      claudeCliLine({ costBasis: "actual", providerReportedCostUsd: 0.75 }),
    ]);

    const summary = await summarize();

    expect(summary).toMatchObject({
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      knownSpendUsd: 0.75,
      notionalSpendUsd: 0,
      capStatus: "reached",
    });
    expect(summary.routes[0]).toMatchObject({ providerReportedGenerationCount: 1 });
  });

  it("keeps notional and real spend on separate totals when both are present", async () => {
    await ledger("usage-ledger.jsonl", [
      claudeCliLine(),
      line({ providerReportedCostUsd: 0.2, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ]);
    const expected = priceClaudeCliInclusiveUsage("sonnet", notionalUsage);

    const summary = await summarize();

    expect(summary).toMatchObject({
      generationCount: 2,
      pricedGenerationCount: 2,
      knownSpendUsd: 0.2,
      notionalSpendUsd: expected?.total,
      capStatus: "below",
    });
  });

  it("prices cache-read savings on the resume fast path instead of degrading the aggregate", async () => {
    await ledger("usage-ledger.jsonl", [
      claudeCliLine({ inputTokens: 1_000_000, cacheReadTokens: 800_000 }),
    ]);
    const expected = claudeCliCacheReadSavingsUsd("sonnet", 800_000);

    const summary = await summarize();

    expect(expected).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      cacheReadTokens: 800_000,
      knownCacheReadSavingsUsd: expected,
      cacheSavingsComplete: true,
    });
    expect(summary.routes[0]).toMatchObject({
      provider: "claude-cli",
      cacheReadTokens: 800_000,
      cacheReadSavingsUsd: expected,
    });
  });

  it("prices cache-read savings for an uncatalogued model id at the family fallback", async () => {
    await ledger("usage-ledger.jsonl", [
      claudeCliLine({ model: "claude-opus-9-20990101", cacheReadTokens: 500_000 }),
    ]);
    const expected = claudeCliCacheReadSavingsUsd("claude-opus-9-20990101", 500_000);

    const summary = await summarize();

    expect(expected).toBe(claudeCliCacheReadSavingsUsd("opus", 500_000));
    expect(summary).toMatchObject({
      knownCacheReadSavingsUsd: expected,
      cacheSavingsComplete: true,
    });
  });

  it("keeps the aggregate complete when a claude-cli row sits beside a catalogued provider row", async () => {
    await ledger("usage-ledger.jsonl", [
      claudeCliLine({ cacheReadTokens: 100_000 }),
      line({ cacheReadTokens: 400, cacheWriteTokens: 100 }),
    ]);

    const summary = await summarize();

    expect(summary.cacheSavingsComplete).toBe(true);
    expect(summary.knownCacheReadSavingsUsd).toBeGreaterThan(
      claudeCliCacheReadSavingsUsd("sonnet", 100_000) ?? 0,
    );
    expect(summary.routes.every((route) => route.cacheReadSavingsUsd !== null)).toBe(true);
  });
});

describe("codex-agent notional usage", () => {
  function codexAgentLine(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
    return line({
      provider: "codex-agent",
      model: "gpt-5.6-sol",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costBasis: "notional",
      ...overrides,
    });
  }

  const notionalUsage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  async function summarize() {
    return createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();
  }

  it("prices a delegated generation without accruing it against the cap", async () => {
    await ledger("usage-ledger.jsonl", [codexAgentLine()]);
    const expected = priceCodexAgentInclusiveUsage("gpt-5.6-sol", notionalUsage);

    const summary = await summarize();

    expect(expected?.total).toBeGreaterThan(DEFAULT_DAILY_SPEND_CAP_USD);
    expect(summary).toMatchObject({
      generationCount: 1,
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      malformedLineCount: 0,
      spendComplete: true,
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
      capStatus: "below",
    });
    expect(summary.routes[0]).toMatchObject({
      provider: "codex-agent",
      model: "gpt-5.6-sol",
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
      providerReportedGenerationCount: 0,
    });
  });

  it("prices an uncatalogued model id at the family fallback instead of leaving the cap unknown", async () => {
    await ledger("usage-ledger.jsonl", [codexAgentLine({ model: "gpt-5.9-terra-preview" })]);
    const expected = priceCodexAgentInclusiveUsage("gpt-5.9-terra-preview", notionalUsage);

    const summary = await summarize();

    expect(expected?.total).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      pricedGenerationCount: 1,
      unpricedGenerationCount: 0,
      spendComplete: true,
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
      capStatus: "below",
    });
  });

  it("prices cache-read savings from the lane table", async () => {
    await ledger("usage-ledger.jsonl", [
      codexAgentLine({ inputTokens: 1_000_000, cacheReadTokens: 800_000 }),
    ]);
    const expected = codexAgentCacheReadSavingsUsd("gpt-5.6-sol", 800_000);

    const summary = await summarize();

    expect(expected).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      cacheReadTokens: 800_000,
      knownCacheReadSavingsUsd: expected,
      cacheSavingsComplete: true,
    });
    expect(summary.routes[0]).toMatchObject({
      provider: "codex-agent",
      cacheReadTokens: 800_000,
      cacheReadSavingsUsd: expected,
    });
  });

  it("keeps the delegated row out of accrual beside a catalogued provider row", async () => {
    await ledger("usage-ledger.jsonl", [
      codexAgentLine(),
      line({ providerReportedCostUsd: 0.2, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ]);
    const expected = priceCodexAgentInclusiveUsage("gpt-5.6-sol", notionalUsage);

    const summary = await summarize();

    expect(summary).toMatchObject({
      generationCount: 2,
      pricedGenerationCount: 2,
      knownSpendUsd: 0.2,
      notionalSpendUsd: expected?.total,
      capStatus: "below",
    });
    expect(summary.cacheSavingsComplete).toBe(true);
  });

  it("leaves the legacy openai-codex input-token reinterpretation untouched", async () => {
    await ledger("usage-ledger.jsonl", [
      codexAgentLine({
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
        totalTokens: 1_600,
      }),
    ]);
    const expected = priceCodexAgentInclusiveUsage("gpt-5.6-sol", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    });

    const summary = await summarize();

    expect(summary).toMatchObject({
      pricedGenerationCount: 1,
      knownSpendUsd: 0,
      notionalSpendUsd: expected?.total,
    });
  });
});
