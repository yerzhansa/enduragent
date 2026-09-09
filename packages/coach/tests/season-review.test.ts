import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSeasonReviewCommand,
  type SeasonReviewCommandDependencies,
  type SeasonReviewComposition,
} from "../src/season-review-command.js";
import {
  SEASON_REVIEW_REQUEST,
  SEASON_REVIEW_RUBRIC_BYTES,
  SEASON_REVIEW_SCORE_SCHEMA_BYTES,
  combineCosts,
  roundUsd,
  seasonReviewBlindKey,
  sha256Bytes,
  summarizeGenerateUsage,
  validateCost,
  validateSeasonReviewConclusion,
  validateSeasonReviewRunRecord,
  validateSeasonReviewScore,
  type SeasonReviewConclusion,
  type SeasonReviewCost,
  type SeasonReviewUsageRow,
} from "../src/season-review.js";

const HEAD = "a".repeat(40),
  OTHER_HEAD = "b".repeat(40),
  HASH = "c".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  delete process.env.ENDURAGENT_HOME;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface RunFixture {
  readonly root: string;
  readonly evidence: string;
  readonly athleteHome: string;
  readonly executionHead: string;
  readonly agentData: string;
  readonly report: string;
  readonly runRecord: string;
  readonly marker: string;
  readonly args: readonly string[];
}

async function fixture(): Promise<RunFixture> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "season-review-"));
  roots.push(root);
  const evidence = join(root, "evidence"),
    athleteHome = join(root, "athlete");
  await mkdir(evidence, { mode: 0o700 });
  await mkdir(join(athleteHome, "store"), { recursive: true, mode: 0o700 });
  await chmod(athleteHome, 0o700);
  await writeFile(join(athleteHome, "store", "store.db"), "synthetic-store\n", { mode: 0o600 });
  const executionHead = join(evidence, "execution-head.txt"),
    agentData = join(evidence, "agent-data");
  const report = join(evidence, "report.txt"),
    runRecord = join(evidence, "run-record.json");
  const marker = join(evidence, "chat-start");
  await writeFile(executionHead, `${HEAD}\n`, { mode: 0o444 });
  await chmod(executionHead, 0o444);
  process.env.ENDURAGENT_HOME = athleteHome;
  return {
    root,
    evidence,
    athleteHome,
    executionHead,
    agentData,
    report,
    runRecord,
    marker,
    args: [
      "run",
      "--head",
      HEAD,
      "--execution-head",
      executionHead,
      "--sample",
      "model-calibration-01",
      "--athlete-home",
      athleteHome,
      "--agent-data",
      agentData,
      "--report",
      report,
      "--run-record",
      runRecord,
      "--chat-start-marker",
      marker,
    ],
  };
}

function usage(overrides: Partial<SeasonReviewUsageRow> = {}): SeasonReviewUsageRow {
  return {
    kind: "generate",
    provider: "synthetic-provider",
    model: "synthetic-model",
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    ...overrides,
  };
}

function dependencies(
  composed: (input: RunFixture) => SeasonReviewComposition,
  input: RunFixture,
  overrides: Partial<SeasonReviewCommandDependencies> = {},
): SeasonReviewCommandDependencies {
  return {
    currentHead: () => HEAD,
    resolveHome: () => ({
      root: input.athleteHome,
      storeDir: join(input.athleteHome, "store"),
      archiveDir: join(input.athleteHome, "archive"),
      configDir: join(input.athleteHome, "config"),
    }),
    compose: async () => composed(input),
    readUsage: () => [usage()],
    storeInventory: () => HASH,
    chatId: () => "season-review-prototype-synthetic-run",
    ...overrides,
  };
}

const unpricedCost = (calls = 1): SeasonReviewCost => ({
  input_tokens: 10 * calls,
  output_tokens: 4 * calls,
  total_tokens: 14 * calls,
  cache_read_tokens: 2 * calls,
  cache_write_tokens: calls,
  priced_calls: 0,
  unpriced_calls: calls,
  usd_input: null,
  usd_output: null,
  usd_cache_read: null,
  usd_cache_write: null,
  usd_total: null,
});

const pricedCost = (calls = 1): SeasonReviewCost => ({
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
  cache_read_tokens: 2,
  cache_write_tokens: 1,
  priced_calls: calls,
  unpriced_calls: 0,
  usd_input: 0.1,
  usd_output: 0.2,
  usd_cache_read: 0.01,
  usd_cache_write: 0.02,
  usd_total: 0.33,
});

function score(all = true) {
  return {
    schema_version: 1,
    report_sha256: HASH,
    grounding: { G1: all, G2: true, G3: true, G4: true, verdict: all ? "KEEP" : "REWORK" },
    specificity: { S1: true, S2: true, S3: true, S4: true, verdict: "KEEP" },
    question_quality: { Q1: true, Q2: true, Q3: true, Q4: true, verdict: "KEEP" },
  };
}

function scored(reportSha256: string, values: readonly [boolean, boolean, boolean]) {
  const criterion = (prefix: "G" | "S" | "Q", keep: boolean) => ({
    [`${prefix}1`]: keep,
    [`${prefix}2`]: true,
    [`${prefix}3`]: true,
    [`${prefix}4`]: true,
    verdict: keep ? "KEEP" : "REWORK",
  });
  return {
    schema_version: 1,
    report_sha256: reportSha256,
    grounding: criterion("G", values[0]),
    specificity: criterion("S", values[1]),
    question_quality: criterion("Q", values[2]),
  };
}

async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode });
  await chmod(path, mode);
}

function conclusion(overrides: Partial<SeasonReviewConclusion> = {}): SeasonReviewConclusion {
  return {
    schema_version: 1,
    head_sha: HEAD,
    provider: "synthetic-provider",
    model: "synthetic-model",
    rubric_sha256: HASH,
    model_calibration: [1, 2, 3].map((index) => ({
      sample: `model-calibration-0${index}` as "model-calibration-01",
      report_sha256: String(index).repeat(64),
      grounding: "KEEP",
      specificity: "KEEP",
      question_quality: "KEEP",
    })),
    grounding: "KEEP",
    specificity: "KEEP",
    question_quality: "KEEP",
    cost_totals: { calibration: unpricedCost(3), real: unpricedCost(), combined: unpricedCost(4) },
    overall: "KEEP",
    evidence_sha256: "e".repeat(64),
    ...overrides,
  };
}

describe("season review request and schemas", () => {
  it("exports the fixed request with exact bytes and no trailing newline", () => {
    expect(SEASON_REVIEW_REQUEST).toBe(
      "Prepare a cycling season review from the training history you can retrieve through the local store-backed tools.\n\nStructure the response as: Season arc; What changed; What to keep or change; Questions.\n\nUse only tool results returned during this review, and do not imply that returned ranges or fields represent the complete store. Every athlete-specific numeric, temporal, comparative, causal, observational, action, or conclusion premise must immediately carry `[Evidence: <tool-name>(<exact arguments>) — <exact returned date/field/value>]`. Cite only results returned during this review. Do not make claims beyond their returned date ranges or fields. Omit unsupported specificity. Label any unsupported causal interpretation `Hypothesis` and name the missing context needed to test it. Do not use an uncited assumption as an evidence anchor.\n\nTreat Load, Intensity, Fitness, Fatigue, and Form as platform-supplied Reference layer values, not locally computed values. State when evidence is absent, stale, or ambiguous. Give at least three distinct evidence-backed observations across at least two parts of the season, identify an evidence-backed trend and an exception or recovery block, and give at least two actions with a time, quantity, or decision condition. Every action must cite the evidence-backed observation it responds to.\n\nAsk 2–4 question blocks only about context absent from the returned results. Each block must use these exact labels in this exact order:\nEvidence anchor: <observation> [Evidence: <tool-name>(<exact arguments>) — <exact returned date/field/value>]\nMissing context: <what the returned results do not establish>\nQuestion: <one question about that missing context>\nDecision changed: <the coaching decision its answer would change>\n\nDo not use an uncited assumption as an Evidence anchor. Do not ask for a fact already returned by a tool. Do not call mutating tools or create, delete, modify, write, or schedule calendar items, training data, or store state.",
    );
    expect(SEASON_REVIEW_REQUEST.endsWith("\n")).toBe(false);
  });

  it("pins evidence receipts, ordered question labels, causality, and bounded retrieval claims", () => {
    expect(SEASON_REVIEW_REQUEST).toContain(
      "[Evidence: <tool-name>(<exact arguments>) — <exact returned date/field/value>]",
    );
    expect(SEASON_REVIEW_REQUEST).toContain(
      "Evidence anchor: <observation> [Evidence: <tool-name>(<exact arguments>) — <exact returned date/field/value>]\n" +
        "Missing context: <what the returned results do not establish>\n" +
        "Question: <one question about that missing context>\n" +
        "Decision changed: <the coaching decision its answer would change>",
    );
    expect(SEASON_REVIEW_REQUEST).toContain(
      "Label any unsupported causal interpretation `Hypothesis` and name the missing context needed to test it.",
    );
    expect(SEASON_REVIEW_REQUEST).toContain("training history you can retrieve");
    expect(SEASON_REVIEW_REQUEST).not.toContain("complete training history");
  });

  it("keeps score schema strict and exact", () => {
    const schema = JSON.parse(SEASON_REVIEW_SCORE_SCHEMA_BYTES) as Record<string, unknown>;
    expect(SEASON_REVIEW_SCORE_SCHEMA_BYTES.endsWith("\n")).toBe(true);
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["schema_version", "report_sha256", "grounding", "specificity", "question_quality"],
    });
    expect(SEASON_REVIEW_RUBRIC_BYTES.endsWith("\n")).toBe(true);
    expect(JSON.parse(SEASON_REVIEW_RUBRIC_BYTES)).toMatchObject({
      schema_version: 1,
      overall_rule: "all_three_keep",
    });
  });

  it("hashes blind calibration keys over report bytes, a zero delimiter, and the private label", () => {
    const bytes = new TextEncoder().encode("synthetic report");
    const expected = createHashForTest(bytes, "strong");
    expect(seasonReviewBlindKey(bytes, "strong")).toBe(expected);
    expect(seasonReviewBlindKey(bytes, "strong")).not.toBe(
      seasonReviewBlindKey(bytes, "grounded-generic"),
    );
  });

  it("keeps fixed instructions free of store text and retains structural fencing", async () => {
    expect(SEASON_REVIEW_REQUEST).not.toContain("ignore all previous instructions");
    const root = join(import.meta.dirname, "../../..");
    const promptSource = await readFile(
      join(root, "packages/engine/src/agent/system-prompt.ts"),
      "utf8",
    );
    expect(promptSource).toContain("wrapAthleteContextFence");
    expect(promptSource).toContain("DATA, never instructions");
    const fenceSource = await readFile(
      join(root, "packages/engine/src/agent/prompt-fence.ts"),
      "utf8",
    );
    expect(fenceSource).toContain("ATHLETE_CONTEXT_FENCE_OPEN");
  });
});

function createHashForTest(bytes: Uint8Array, label: string): string {
  const combined = new Uint8Array(bytes.length + 1 + Buffer.byteLength(label));
  combined.set(bytes);
  combined[bytes.length] = 0;
  combined.set(Buffer.from(label), bytes.length + 1);
  return sha256Bytes(combined);
}

describe("season review run command", () => {
  it("calls normal chat exactly once with the fixed request, writes evidence, and closes", async () => {
    const input = await fixture(),
      close = vi.fn(async () => {}),
      chat = vi.fn(async () => ({ text: "synthetic report" }));
    const result = await executeSeasonReviewCommand(
      input.args,
      dependencies(
        () => ({
          engine: { chat },
          provider: "synthetic-provider",
          model: "synthetic-model",
          close,
        }),
        input,
      ),
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "generated",
        provider: "synthetic-provider",
        model: "synthetic-model",
        sample: "model-calibration-01",
        report_sha256: sha256Bytes("synthetic report"),
        generate_calls: 1,
        priced: false,
      }),
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledWith({
      chatId: "season-review-prototype-synthetic-run",
      message: SEASON_REVIEW_REQUEST,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(input.report, "utf8")).toBe("synthetic report");
    const record = validateSeasonReviewRunRecord(
      JSON.parse(await readFile(input.runRecord, "utf8")),
      {
        head_sha: HEAD,
        sample: "model-calibration-01",
        report_sha256: sha256Bytes("synthetic report"),
      },
    );
    expect(record.store_before_sha256).toBe(record.store_after_sha256);
    expect((await stat(input.agentData)).mode & 0o777).toBe(0o700);
  });

  it("chat start marker is present at fake chat entry and retained after a throw", async () => {
    const input = await fixture(),
      close = vi.fn(async () => {});
    const chat = vi.fn(async () => {
      expect(await readFile(input.marker, "utf8")).toBe(`${HEAD}\n`);
      throw new Error("synthetic chat failure");
    });
    const result = await executeSeasonReviewCommand(
      input.args,
      dependencies(
        () => ({
          engine: { chat },
          provider: "synthetic-provider",
          model: "synthetic-model",
          close,
        }),
        input,
      ),
    );
    expect(result).toEqual({ exitCode: 1, stdout: '{"status":"run_failed"}' });
    expect(chat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(input.marker, "utf8")).toBe(`${HEAD}\n`);
    await expect(readFile(input.report)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("execution head mismatch fails before composition and leaves the marker absent", async () => {
    const input = await fixture(),
      compose = vi.fn();
    const result = await executeSeasonReviewCommand(
      input.args,
      dependencies(
        () => {
          throw new Error("unreachable");
        },
        input,
        { currentHead: () => OTHER_HEAD, compose },
      ),
    );
    expect(result).toEqual({ exitCode: 2, stdout: '{"status":"environment"}' });
    expect(compose).not.toHaveBeenCalled();
    await expect(readFile(input.marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(input.agentData)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the explicit ENDURAGENT_HOME binding", async () => {
    const input = await fixture();
    delete process.env.ENDURAGENT_HOME;
    const result = await executeSeasonReviewCommand(
      input.args,
      dependencies(() => {
        throw new Error("unreachable");
      }, input),
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(input.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the marker and fails if the store inventory changes", async () => {
    const input = await fixture();
    let calls = 0;
    const result = await executeSeasonReviewCommand(
      input.args,
      dependencies(
        () => ({
          engine: { chat: async () => ({ text: "synthetic report" }) },
          provider: "synthetic-provider",
          model: "synthetic-model",
          close: async () => {},
        }),
        input,
        { storeInventory: () => (++calls === 1 ? HASH : "d".repeat(64)) },
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(await readFile(input.marker, "utf8")).toBe(`${HEAD}\n`);
    await expect(readFile(input.report)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects nested output paths before composition", async () => {
    const input = await fixture(),
      nested = join(input.evidence, "nested", "report.txt");
    await mkdir(join(input.evidence, "nested"), { mode: 0o700 });
    const args = input.args.map((value) => (value === input.report ? nested : value));
    const compose = vi.fn();
    const result = await executeSeasonReviewCommand(
      args,
      dependencies(
        () => {
          throw new Error("unreachable");
        },
        input,
        { compose },
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(compose).not.toHaveBeenCalled();
  });

  it("rejects a symlink athlete home", async () => {
    const input = await fixture(),
      linked = join(input.root, "linked-athlete");
    await symlink(input.athleteHome, linked);
    process.env.ENDURAGENT_HOME = linked;
    const args = input.args.map((value) => (value === input.athleteHome ? linked : value));
    const result = await executeSeasonReviewCommand(
      args,
      dependencies(
        () => {
          throw new Error("unreachable");
        },
        { ...input, athleteHome: linked },
      ),
    );
    expect(result.exitCode).toBe(2);
  });

  it("reports priced only when every generate row is priced and ignores turn rows", async () => {
    const input = await fixture(),
      rows = [
        usage({
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        }),
        usage({ kind: "turn", cost: undefined }),
      ];
    const result = await executeSeasonReviewCommand(
      input.args,
      dependencies(
        () => ({
          engine: { chat: async () => ({ text: "synthetic report" }) },
          provider: "synthetic-provider",
          model: "synthetic-model",
          close: async () => {},
        }),
        input,
        { readUsage: () => rows },
      ),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ generate_calls: 1, priced: true });
    expect(
      validateSeasonReviewRunRecord(JSON.parse(await readFile(input.runRecord, "utf8"))).cost
        .usd_total,
    ).toBe(0.33);
  });
});

describe("cost null asymmetry and usage accounting", () => {
  it("accepts unpriced all-null and rejects one USD value", () => {
    expect(validateCost(unpricedCost(), 1)).toEqual(unpricedCost());
    expect(() => validateCost({ ...unpricedCost(), usd_total: 0 }, 1)).toThrow();
  });

  it("accepts priced all-present and rejects only total null", () => {
    expect(validateCost(pricedCost(), 1)).toEqual(pricedCost());
    expect(() => validateCost({ ...pricedCost(), usd_total: null }, 1)).toThrow();
  });

  it("sums generate rows only and applies twelve-place rounding", () => {
    const rows = [
      usage({
        inputTokens: undefined,
        cost: {
          input: 0.0000000000006,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0000000000006,
        },
      }),
      usage({ kind: "turn", inputTokens: 999 }),
      usage({
        cost: {
          input: 0.0000000000006,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0000000000006,
        },
      }),
    ];
    const result = summarizeGenerateUsage(rows, "synthetic-provider", "synthetic-model");
    expect(result.generateCalls).toBe(2);
    expect(result.cost.input_tokens).toBe(10);
    expect(result.cost.usd_input).toBe(roundUsd(0.0000000000012));
    expect(() =>
      summarizeGenerateUsage(
        [usage({ provider: "other" })],
        "synthetic-provider",
        "synthetic-model",
      ),
    ).toThrow();
  });

  it("combines token and call totals without treating rounded subtotals as turn rows", () => {
    const combined = combineCosts([
      { cost: unpricedCost(3), generateCalls: 3 },
      { cost: unpricedCost(), generateCalls: 1 },
    ]);
    expect(combined.generateCalls).toBe(4);
    expect(combined.cost.unpriced_calls).toBe(4);
    expect(combined.cost.input_tokens).toBe(40);
  });
});

describe("shared persisted predicates", () => {
  it("uses anchor booleans as the sole criterion verdict predicate", () => {
    expect(validateSeasonReviewScore(score(false))).toMatchObject({
      grounding: { verdict: "REWORK" },
    });
    const inconsistent = score(false);
    inconsistent.grounding.verdict = "KEEP";
    expect(() => validateSeasonReviewScore(inconsistent)).toThrow();
  });

  it("rejects real grounding REWORK with overall KEEP and accepts overall REWORK", () => {
    const realCost = unpricedCost(),
      costs = { calibration: unpricedCost(3), real: realCost, combined: unpricedCost(4) };
    expect(() =>
      validateSeasonReviewConclusion(
        conclusion({ grounding: "REWORK", overall: "KEEP", cost_totals: costs }),
      ),
    ).toThrow();
    expect(
      validateSeasonReviewConclusion(
        conclusion({ grounding: "REWORK", overall: "REWORK", cost_totals: costs }),
      ),
    ).toMatchObject({ grounding: "REWORK", overall: "REWORK" });
  });

  it("rejects real question-quality REWORK with overall KEEP and accepts overall REWORK", () => {
    const realCost = unpricedCost(),
      costs = { calibration: unpricedCost(3), real: realCost, combined: unpricedCost(4) };
    expect(() =>
      validateSeasonReviewConclusion(
        conclusion({
          question_quality: "REWORK",
          overall: "KEEP",
          cost_totals: costs,
        }),
      ),
    ).toThrow();
    expect(
      validateSeasonReviewConclusion(
        conclusion({
          question_quality: "REWORK",
          overall: "REWORK",
          cost_totals: costs,
        }),
      ),
    ).toMatchObject({ question_quality: "REWORK", overall: "REWORK" });
  });

  it("calibration order inversion is rejected", () => {
    const value = conclusion(),
      [first, second] = value.model_calibration;
    expect(() =>
      validateSeasonReviewConclusion({
        ...value,
        model_calibration: [second, first, value.model_calibration[2]],
      }),
    ).toThrow();
  });

  it("rejects a different valid expected HEAD", () => {
    expect(validateSeasonReviewConclusion(conclusion(), HEAD).head_sha).toBe(HEAD);
    expect(() => validateSeasonReviewConclusion(conclusion(), OTHER_HEAD)).toThrow();
  });

  it("binds scores and run records to report and execution hashes", () => {
    expect(() => validateSeasonReviewScore(score(), "d".repeat(64))).toThrow();
    const record = {
      schema_version: 1,
      head_sha: HEAD,
      sample: "real",
      provider: "synthetic-provider",
      model: "synthetic-model",
      report_sha256: HASH,
      store_before_sha256: HASH,
      store_after_sha256: HASH,
      store_unchanged: true,
      generate_calls: 1,
      cost: unpricedCost(),
    };
    expect(validateSeasonReviewRunRecord(record, { head_sha: HEAD })).toMatchObject({
      sample: "real",
    });
    expect(() => validateSeasonReviewRunRecord(record, { head_sha: OTHER_HEAD })).toThrow();
  });
});

describe("evidence stage and sealing commands", () => {
  it("validates ordered stages and seals through the shared persisted predicates", async () => {
    const input = await fixture(),
      path = (name: string) => join(input.evidence, name);
    const rubric = path("rubric.json"),
      scoreSchema = path("season-review-score.schema.json");
    const callGraph = path("call-graph.json"),
      indexPath = path("evidence-index.json"),
      conclusionPath = path("conclusion.json");
    await writeFile(rubric, SEASON_REVIEW_RUBRIC_BYTES, { mode: 0o600 });
    await writeFile(scoreSchema, SEASON_REVIEW_SCORE_SCHEMA_BYTES, { mode: 0o400 });
    await chmod(scoreSchema, 0o400);
    await writeJson(callGraph, {
      schema_version: 1,
      base_sha: OTHER_HEAD,
      config: { qualified: true },
      store_binding: { qualified: true },
      composition: { qualified: true },
      store_open: { read_only: true, writer_called: false },
      engine: { normal_chat: true },
      reads: { all_athlete_reads_store_backed: true },
      mutations: { platform_credentials_absent: true, unavailable_without_request: true },
      fencing: { structural: true },
      projection: { qualified: true },
      shutdown: { store_closed: true, schedulers_stopped: true },
      verdict: "USE_PRODUCT_SEAM",
    });

    const rubricMaps = [
      [false, true, true],
      [true, false, false],
      [true, true, true],
    ] as const;
    const rubricLabels = ["unsupported-specific", "grounded-generic", "strong"] as const;
    const rubricCalibration = [] as Array<Record<string, unknown>>;
    for (let index = 0; index < 3; index += 1) {
      const report = path(`rubric-report-${index + 1}.txt`),
        scorePath = path(`rubric-score-${index + 1}.json`);
      const label = path(`rubric-label-${index + 1}.txt`);
      await writeFile(report, `rubric report ${index + 1}`, { mode: 0o600 });
      await writeJson(scorePath, scored(sha256Bytes(await readFile(report)), rubricMaps[index]!));
      await writeFile(label, `${rubricLabels[index]}\n`, { mode: 0o600 });
      rubricCalibration.push({
        sample: `rubric-calibration-0${index + 1}`,
        report_path: report,
        run_record_path: null,
        score_path: scorePath,
        source_label_path: label,
      });
    }

    const modelCalibration = [] as Array<Record<string, unknown>>;
    for (let index = 0; index < 3; index += 1) {
      const report = path(`model-report-${index + 1}.txt`),
        scorePath = path(`model-score-${index + 1}.json`);
      const runRecord = path(`model-run-${index + 1}.json`),
        sample = `model-calibration-0${index + 1}`;
      await writeFile(report, `model report ${index + 1}`, { mode: 0o600 });
      const reportHash = sha256Bytes(await readFile(report));
      await writeJson(scorePath, scored(reportHash, [true, true, true]));
      await writeJson(runRecord, {
        schema_version: 1,
        head_sha: HEAD,
        sample,
        provider: "synthetic-provider",
        model: "synthetic-model",
        report_sha256: reportHash,
        store_before_sha256: HASH,
        store_after_sha256: HASH,
        store_unchanged: true,
        generate_calls: 1,
        cost: unpricedCost(),
      });
      modelCalibration.push({
        sample,
        report_path: report,
        run_record_path: runRecord,
        score_path: scorePath,
        source_label_path: null,
      });
    }

    const realReport = path("real-report.txt"),
      realScore = path("real-score.json"),
      realRun = path("real-run.json");
    await writeFile(realReport, "real report", { mode: 0o600 });
    const realHash = sha256Bytes(await readFile(realReport));
    await writeJson(realScore, scored(realHash, [false, true, true]));
    await writeJson(realRun, {
      schema_version: 1,
      head_sha: HEAD,
      sample: "real",
      provider: "synthetic-provider",
      model: "synthetic-model",
      report_sha256: realHash,
      store_before_sha256: "d".repeat(64),
      store_after_sha256: "d".repeat(64),
      store_unchanged: true,
      generate_calls: 1,
      cost: unpricedCost(),
    });
    await writeJson(indexPath, {
      schema_version: 1,
      base_sha: OTHER_HEAD,
      execution_head_path: input.executionHead,
      call_graph_path: callGraph,
      rubric_path: rubric,
      score_schema_path: scoreSchema,
      rubric_calibration: rubricCalibration,
      model_calibration: modelCalibration,
      real: { report_path: realReport, run_record_path: realRun, score_path: realScore },
    });

    await expect(
      executeSeasonReviewCommand(["validate-stage", "--stage", "rubric", "--index", indexPath]),
    ).resolves.toEqual({ exitCode: 0, stdout: "" });
    expect((await stat(rubric)).mode & 0o777).toBe(0o444);
    await expect(
      executeSeasonReviewCommand(["validate-stage", "--stage", "model", "--index", indexPath]),
    ).resolves.toEqual({ exitCode: 0, stdout: "" });
    await expect(
      executeSeasonReviewCommand(["seal", "--index", indexPath, "--conclusion", conclusionPath], {
        currentHead: () => HEAD,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "" });
    const sealed = validateSeasonReviewConclusion(
      JSON.parse(await readFile(conclusionPath, "utf8")),
      HEAD,
    );
    expect(sealed).toMatchObject({
      provider: "synthetic-provider",
      model: "synthetic-model",
      grounding: "REWORK",
      overall: "REWORK",
      cost_totals: { combined: { unpriced_calls: 4 } },
    });
    await chmod(conclusionPath, 0o444);
    await expect(
      executeSeasonReviewCommand(["validate-conclusion", "--conclusion", conclusionPath]),
    ).resolves.toEqual({ exitCode: 0, stdout: "" });
  });
});

describe("key-free command surface", () => {
  it("prints help without consulting config, Git, store, or composition", async () => {
    const current = vi.fn(),
      compose = vi.fn();
    await expect(
      executeSeasonReviewCommand(["--help"], { currentHead: current, compose }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout:
        "usage: season-review-command (run|validate-score|validate-stage|seal|validate-conclusion)",
    });
    expect(current).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });
});
