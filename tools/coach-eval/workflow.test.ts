import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { summarize, type EvalReport } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "../..");
const workflowPath = join(repositoryRoot, ".github/workflows/coach-eval.yml");

const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
type Step = z.infer<typeof stepSchema>;

const workflowSchema = z.object({
  on: z.record(z.string(), z.object({
    inputs: z.record(z.string(), z.object({
      required: z.boolean(),
      default: z.string(),
      type: z.string(),
    })),
  })),
  permissions: z.record(z.string(), z.string()),
  concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }),
  jobs: z.record(z.string(), z.object({
    "runs-on": z.string(),
    "timeout-minutes": z.number(),
    environment: z.string(),
    steps: z.array(stepSchema),
  })),
});

const text = readFileSync(workflowPath, "utf8");
const workflow = workflowSchema.parse(parse(text));
const job = workflow.jobs["coach-eval"];
const steps = job?.steps ?? [];

function step(name: string): Step {
  const found = steps.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`step ${name} is missing`);
  return found;
}

function script(name: string): string {
  const run = step(name).run;
  if (run === undefined) throw new TypeError(`step ${name} has no script`);
  return run;
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "coach-eval-workflow-"));
  directories.push(directory);
  return directory;
}

interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly pnpmArgs: readonly string[];
}

function runScript(
  name: string,
  env: Readonly<Record<string, string>>,
  options: { readonly cwd?: string; readonly pnpmExit?: number; readonly pnpmPrints?: string } = {},
): ScriptRun {
  const directory = scratch();
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const argsFile = join(directory, "pnpm-args");
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nprintf '%s' "${options.pnpmPrints ?? ""}"\nexit ${options.pnpmExit ?? 0}\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const scriptFile = join(directory, "step.sh");
  writeFileSync(scriptFile, script(name));
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptFile], {
    cwd: options.cwd ?? directory,
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: directory, ...env },
    encoding: "utf8",
  });
  const pnpmArgs = existsSync(argsFile)
    ? readFileSync(argsFile, "utf8").split("\n").filter((line) => line !== "")
    : [];
  return { status: result.status, stdout: result.stdout, pnpmArgs };
}

const validInputs = {
  MODEL: "deepseek/deepseek-v4-flash",
  JUDGE_MODEL: "anthropic/claude-sonnet-5",
  MAX_USD: "4",
  CASES: "",
};

describe("coach eval workflow", () => {
  it("starts only by hand, reads nothing it does not need and never overlaps a paid run", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "coach-eval", "cancel-in-progress": false });
    expect(Object.keys(workflow.jobs)).toEqual(["coach-eval"]);
    expect(job?.environment).toBe("coach-eval");
    expect(job?.["timeout-minutes"]).toBeLessThanOrEqual(45);
    const checkout = steps.find((candidate) => candidate.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("requires a spend limit no higher than the per-model limit by default", () => {
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(inputs.max_usd?.required).toBe(true);
    expect(Number(inputs.max_usd?.default)).toBeGreaterThan(0);
    expect(Number(inputs.max_usd?.default)).toBeLessThanOrEqual(4);
    expect(inputs.model?.default).toBe("deepseek/deepseek-v4-flash");
    expect(inputs.cases?.required).toBe(false);
  });

  it("pins every action to a commit and passes inputs and the key only through env", () => {
    for (const candidate of steps) {
      if (candidate.uses !== undefined) expect(candidate.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u);
      expect(candidate.run ?? "").not.toContain("${{");
    }
    const withSecret = steps.filter((candidate) => JSON.stringify(candidate).includes("secrets."));
    expect(withSecret.map((candidate) => candidate.name)).toEqual(["Run the coach eval"]);
    expect(step("Run the coach eval").env?.OPENROUTER_API_KEY).toBe("${{ secrets.OPENROUTER_API_KEY }}");
    expect(text.match(/secrets\./gu)).toHaveLength(1);
  });

  it("builds the packages the runner imports before it checks inputs and runs", () => {
    const names = steps.map((candidate) => candidate.name);
    const build = names.indexOf("Build the packages the eval imports");
    expect(build).toBeGreaterThan(names.indexOf("Install workspace"));
    expect(build).toBeLessThan(names.indexOf("Check run inputs"));
    expect(names.indexOf("Check run inputs")).toBeLessThan(names.indexOf("Run the coach eval"));
    expect(script("Build the packages the eval imports")).toContain('--filter "@enduragent/core..."');
    expect(script("Build the packages the eval imports")).toContain('--filter "@enduragent/sport-cycling..."');
    expect(script("Install workspace")).toContain("pnpm install --frozen-lockfile");
  });

  it("attaches the report even when cases fail, and fails when no report was written", () => {
    const attach = step("Attach the report");
    expect(attach.uses).toMatch(/^actions\/upload-artifact@/u);
    expect(attach.if).toBe("always() && steps.eval.outcome != 'skipped'");
    expect(step("Write the results summary").if).toBe(attach.if);
    expect(attach.with).toMatchObject({
      path: ".tests/runs/",
      "include-hidden-files": true,
      "if-no-files-found": "error",
    });
    expect(step("Run the coach eval").id).toBe("eval");
  });
});

describe("coach eval workflow scripts", () => {
  it("accepts the default inputs and a list of case ids", () => {
    expect(runScript("Check run inputs", validInputs).status).toBe(0);
    expect(runScript("Check run inputs", { ...validInputs, CASES: " goal-change  stale-data " }).status).toBe(0);
    expect(runScript("Check run inputs", { ...validInputs, MAX_USD: "0.5", MODEL: "openai/gpt-5.6-sol" }).status).toBe(0);
  });

  it.each([
    ["MODEL", "deepseek/deepseek-v4-flash; id"],
    ["MODEL", "$(id)/model"],
    ["MODEL", "no-provider"],
    ["JUDGE_MODEL", "anthropic/claude sonnet"],
    ["MAX_USD", "4; id"],
    ["MAX_USD", "-1"],
    ["MAX_USD", ""],
    ["CASES", "goal-change;id"],
    ["CASES", "--model x/y"],
    ["CASES", "goal-change --max-usd 9"],
    ["CASES", "*"],
  ])("rejects %s = %j", (key, value) => {
    expect(runScript("Check run inputs", { ...validInputs, [key]: value }).status).toBe(1);
  });

  it("passes the model, the judge and the spend limit, and one flag per case id", () => {
    const run = runScript("Run the coach eval", { ...validInputs, CASES: " goal-change  stale-data " });
    expect(run.status).toBe(0);
    expect(run.pnpmArgs).toEqual([
      "eval:coach",
      "--model", "deepseek/deepseek-v4-flash",
      "--judge-model", "anthropic/claude-sonnet-5",
      "--max-usd", "4",
      "--case", "goal-change",
      "--case", "stale-data",
    ]);
    expect(runScript("Run the coach eval", validInputs).pnpmArgs).not.toContain("--case");
  });

  it("fails the step when the eval does not pass", () => {
    expect(runScript("Run the coach eval", validInputs, { pnpmExit: 1 }).status).toBe(1);
  });

  it("writes the results table to the job summary, or says no report was written", () => {
    const empty = scratch();
    const emptySummary = join(empty, "summary.md");
    const none = runScript("Write the results summary", { GITHUB_STEP_SUMMARY: emptySummary }, { cwd: empty });
    expect(none.status).toBe(0);
    expect(none.pnpmArgs).toEqual([]);
    expect(readFileSync(emptySummary, "utf8")).toBe("The eval wrote no report.\n");

    const withReport = scratch();
    const runDir = join(withReport, ".tests/runs/2026-01-02T10-00-00.000Z-coach-eval");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), "{}");
    const summary = join(withReport, "summary.md");
    const table = runScript(
      "Write the results summary",
      { GITHUB_STEP_SUMMARY: summary },
      { cwd: withReport, pnpmPrints: "TABLE" },
    );
    expect(table.status).toBe(0);
    expect(table.pnpmArgs).toEqual([
      "eval:coach:table", "--stdout", ".tests/runs/2026-01-02T10-00-00.000Z-coach-eval/report.json",
    ]);
    expect(readFileSync(summary, "utf8")).toBe("TABLE");
  });
});

describe("results table on stdout", () => {
  it("prints the table and leaves RESULTS.md alone", () => {
    const resultsPath = join(here, "RESULTS.md");
    const before = readFileSync(resultsPath, "utf8");
    const report: EvalReport = {
      model: "deepseek/deepseek-v4-flash",
      judgeModel: "anthropic/claude-sonnet-5",
      startedAt: "2026-01-02T10:00:00.000Z",
      finishedAt: "2026-01-02T10:20:00.000Z",
      spend: {
        limitUsd: 1, spentUsd: 0.05, largestCallUsd: 0, providerPricedCalls: 0, catalogPricedCalls: 0,
        unpricedCalls: 0, failedCalls: 0, refusedCalls: 0,
      },
      costIsLowerBound: false,
      summary: summarize([]),
      cases: [],
    };
    const reportPath = join(scratch(), "report.json");
    writeFileSync(reportPath, JSON.stringify(report));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(here, "table.ts"), "--stdout", reportPath],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# Coach eval results");
    expect(result.stdout).toContain("| `deepseek/deepseek-v4-flash` |");
    expect(readFileSync(resultsPath, "utf8")).toBe(before);
  });
});
