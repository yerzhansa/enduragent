import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const selectedTests = [
  "apps/desktop/tests/chat-regression-gate-contract.test.ts",
  "apps/desktop/tests/chat-attachment-ipc.test.ts",
  "apps/desktop-renderer/tests/chat-controller.test.ts",
  "apps/desktop-renderer/tests/chat-queue-recovery.test.ts",
  "apps/desktop-renderer/tests/chat-decision-controller.test.ts",
  "apps/desktop-renderer/tests/chat-hydration-controller.test.ts",
  "apps/desktop-renderer/tests/chat-hydration.test.ts",
  "apps/desktop-renderer/tests/turn-state.test.ts",
  "apps/desktop-renderer/tests/chat-adapter.test.tsx",
  "apps/desktop-renderer/tests/chat-surface.test.tsx",
  "apps/desktop-renderer/tests/plan-adapter.test.ts",
  "apps/desktop-renderer/tests/plan-controller.test.ts",
  "apps/desktop-renderer/tests/plan-chat-card.test.ts",
  "apps/desktop-renderer/tests/plan-reference-card.test.tsx",
  "packages/engine/tests/chat-queue.test.ts",
] as const;
const expectedCommand = `vitest run ${selectedTests.join(" ")} --maxWorkers=4`;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is not an object`);
  }
  return value as JsonRecord;
}

function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is not an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

describe("deterministic Chat regression gate contract", () => {
  let manifest: JsonRecord;
  let workflow: JsonRecord;
  let workflowText: string;

  beforeAll(async () => {
    const [manifestText, loadedWorkflow] = await Promise.all([
      readFile(join(repositoryRoot, "package.json"), "utf8"),
      readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    ]);
    manifest = record(JSON.parse(manifestText), "package.json");
    workflowText = loadedWorkflow;
    workflow = record(parse(loadedWorkflow), "CI workflow");
  });

  it("pins one explicit non-native test command", async () => {
    const scripts = record(manifest.scripts, "package scripts");
    expect(scripts["test:chat-regression"]).toBe(expectedCommand);
    expect(new Set(selectedTests).size).toBe(selectedTests.length);
    expect(selectedTests.every((path) => /\.test\.tsx?$/u.test(path))).toBe(true);
    expect(selectedTests.some((path) => /integration|e2e|voiceover/iu.test(path))).toBe(false);
    await Promise.all(selectedTests.map((path) => access(join(repositoryRoot, path))));
  });

  it("runs once in the prepared Linux job before the broad workspace tests", () => {
    const jobs = record(workflow.jobs, "workflow jobs");
    const check = record(jobs.check, "check job");
    const steps = records(check.steps, "check steps");
    const gateSteps = steps.filter((step) => step.run === "pnpm test:chat-regression");
    expect(gateSteps).toHaveLength(1);
    expect(gateSteps[0]?.name).toBe("Test deterministic Chat regressions");
    expect(gateSteps[0]?.if).toBeUndefined();
    expect(gateSteps[0]?.["continue-on-error"]).toBeUndefined();
    expect(workflowText.match(/pnpm test:chat-regression/gu)).toHaveLength(1);
    expect(jobs["chat-regression"]).toBeUndefined();
    expect(steps.filter((step) => step.run === "pnpm install --frozen-lockfile")).toHaveLength(1);
    const buildIndex = steps.findIndex((step) => step.run === "pnpm check");
    const gateIndex = steps.findIndex((step) => step.run === "pnpm test:chat-regression");
    const broadIndex = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.includes("--shard=1/2"),
    );
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(buildIndex);
    expect(broadIndex).toBeGreaterThan(gateIndex);
  });

  it("inherits pull-request cancellation and fails the required test status", () => {
    const triggers = record(workflow.on, "workflow triggers");
    const pullRequest = record(triggers.pull_request, "pull request trigger");
    expect(pullRequest.paths).toBeUndefined();
    expect(pullRequest["paths-ignore"]).toBeUndefined();
    const concurrency = record(workflow.concurrency, "workflow concurrency");
    expect(concurrency.group).toBe("ci-${{ github.event.pull_request.number || github.ref }}");
    expect(concurrency["cancel-in-progress"]).toBe(true);
    const jobs = record(workflow.jobs, "workflow jobs");
    const requiredTest = record(jobs.test, "required test job");
    expect(requiredTest.needs).toBe("check");
    expect(requiredTest.if).toBe("${{ always() }}");
    const requiredSteps = records(requiredTest.steps, "required test steps");
    expect(requiredSteps).toHaveLength(1);
    const sentinel = requiredSteps[0]!;
    expect(record(sentinel.env, "required test environment").CHECK_RESULT).toBe(
      "${{ needs.check.result }}",
    );
    expect(sentinel.run).toContain('test "$CHECK_RESULT" = success');
  });
});
