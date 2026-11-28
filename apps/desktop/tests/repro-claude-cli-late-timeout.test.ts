import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCliReadiness, ClaudeWorkingAreaPort } from "@enduragent/core";
import {
  CLAUDE_CLI_STATUS_DEADLINE_MS,
  createClaudeCliStatus,
  type ClaudeCliStatusDependencies,
} from "../src/main/claude-cli-status.js";
import { BUNDLED_MODEL_CATALOG } from "../../../packages/core/src/model-catalog-seed.js";

type EnsureReady = NonNullable<ClaudeCliStatusDependencies["ensureReady"]>;

const SELECTION = {
  catalogRevision: BUNDLED_MODEL_CATALOG.revision,
  provider: "claude-cli" as const,
  model: "sonnet",
  endpoint: { mode: "automatic" as const },
};

function readiness(): ClaudeCliReadiness {
  return {
    binaryPath: "/opt/homebrew/bin/claude",
    version: "2.9.0",
    identityLine: "Signed in as athlete@synthetic.test - Claude Max subscription",
    accountClass: "subscription",
    email: "athlete@synthetic.test",
    plan: "Max",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(ensureReady: EnsureReady) {
  const workingArea: ClaudeWorkingAreaPort = {
    cacheKey: "/private/tmp/enduragent-claude-late-timeout-test",
    async prepareForLaunch() {
      return { cwd: "/private/tmp/enduragent-claude-late-timeout-test", assertCurrent() {} };
    },
  };
  const invalidateProbeCache = vi.fn();
  const applyRuntimeConfig = vi.fn(async () => {});
  const controller = createClaudeCliStatus({
    settings: async () => ({ enabled: true, billing: "subscription" }),
    environment: () => ({}),
    applyRuntimeConfig,
    workingArea,
    dependencies: { ensureReady, invalidateProbeCache },
  });
  return { controller, invalidateProbeCache, applyRuntimeConfig };
}

async function timeOutThenRetry(
  subject: ReturnType<typeof harness>,
  lateA: { resolve: (value: ClaudeCliReadiness) => void },
  expectedB: string,
) {
  const first = subject.controller.status();
  const firstRejection = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(CLAUDE_CLI_STATUS_DEADLINE_MS);
  await firstRejection;
  await expect(subject.controller.recheck()).resolves.toMatchObject({ state: expectedB });
  expect(subject.invalidateProbeCache).toHaveBeenCalledTimes(1);
  lateA.resolve(readiness());
  await vi.waitFor(() => expect(subject.invalidateProbeCache).toHaveBeenCalledTimes(2));
}

describe("lead: a late timed-out Claude Code check and a newer good result", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets activation reuse Retry's fresh ready result after the old check settles late", async () => {
    vi.useFakeTimers();
    const lateA = deferred<ClaudeCliReadiness>();
    const ensureReady = vi
      .fn<EnsureReady>()
      .mockImplementationOnce(() => lateA.promise)
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue(readiness());
    const subject = harness(ensureReady);

    await timeOutThenRetry(subject, lateA, "ready");
    await expect(subject.controller.activate(SELECTION, BUNDLED_MODEL_CATALOG)).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });

    expect(
      ensureReady,
      "activation re-runs the Claude Code check that Retry finished seconds ago",
    ).toHaveBeenCalledTimes(2);
  });

  it("does not make activation wait on, and fail with, a check Retry already made unnecessary", async () => {
    vi.useFakeTimers();
    const lateA = deferred<ClaudeCliReadiness>();
    const hangingC = deferred<ClaudeCliReadiness>();
    const ensureReady = vi
      .fn<EnsureReady>()
      .mockImplementationOnce(() => lateA.promise)
      .mockResolvedValueOnce(readiness())
      .mockImplementationOnce(() => hangingC.promise);
    const subject = harness(ensureReady);

    await timeOutThenRetry(subject, lateA, "ready");
    const activation = subject.controller.activate(SELECTION, BUNDLED_MODEL_CATALOG);
    const outcome = activation.then(
      (value) => ({ settled: "resolved" as const, value }),
      (error: unknown) => ({
        settled: "rejected" as const,
        value: error instanceof Error ? error.name : String(error),
      }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_STATUS_DEADLINE_MS);

    await expect(
      outcome,
      "Continue fails after 72 s although Retry showed Claude Code ready",
    ).resolves.toEqual({
      settled: "resolved",
      value: { status: "configured", runtimeReady: true },
    });
  });

  it("never lets the old check's late ready answer stand in for Retry's not-signed-in answer", async () => {
    vi.useFakeTimers();
    const lateA = deferred<ClaudeCliReadiness>();
    const ensureReady = vi
      .fn<EnsureReady>()
      .mockImplementationOnce(() => lateA.promise)
      .mockRejectedValue(new Error("synthetic: not signed in"));
    const subject = harness(ensureReady);

    await timeOutThenRetry(subject, lateA, "not-logged-in");

    await expect(subject.controller.activate(SELECTION, BUNDLED_MODEL_CATALOG)).resolves.toEqual({
      status: "refused",
      reason: "credential-required",
    });
    await expect(subject.controller.status()).resolves.toEqual({ state: "not-logged-in" });
    expect(subject.applyRuntimeConfig).not.toHaveBeenCalled();
  });
});
