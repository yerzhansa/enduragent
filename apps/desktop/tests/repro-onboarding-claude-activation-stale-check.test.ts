import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAccountProbeResult, ClaudeWorkingAreaPort } from "@enduragent/core";
import {
  createClaudeCliStatus,
  type ClaudeCliStatusDependencies,
} from "../src/main/claude-cli-status.js";
import { BUNDLED_MODEL_CATALOG } from "../../../packages/core/src/model-catalog-seed.js";

const workingArea: ClaudeWorkingAreaPort = {
  cacheKey: "/private/tmp/enduragent-claude-status-repro",
  async prepareForLaunch() {
    return { cwd: "/private/tmp/enduragent-claude-status-repro", assertCurrent() {} };
  },
};

afterEach(() => vi.useRealTimers());

describe("repro onboarding G12a: Claude Code activation and an old check", () => {
  it("checks the CLI again before activating it an hour after the last check", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    let signedIn = true;
    const probeAccount = vi.fn(async (): Promise<ClaudeAccountProbeResult> =>
      signedIn
        ? {
            verified: true,
            accountClass: "subscription",
            email: "athlete@synthetic.test",
            plan: "Max",
          }
        : ({
            verified: false,
            accountClass: "not-signed-in",
            reason: "no-account",
          } as ClaudeAccountProbeResult),
    );
    const dependencies: ClaudeCliStatusDependencies = {
      resolveBinary: vi.fn(async () => "/opt/homebrew/bin/claude"),
      probeVersion: vi.fn(async () => "2.9.0"),
      probeAccount,
      preflightMcpConfigTransform: vi.fn(),
      invalidateProbeCache: vi.fn(),
    };
    const applyRuntimeConfig = vi.fn(async () => {});
    const claude = createClaudeCliStatus({
      settings: async () => ({ enabled: true, billing: "subscription" }),
      environment: () => ({}),
      applyRuntimeConfig,
      workingArea,
      dependencies,
    });

    await expect(claude.status()).resolves.toMatchObject({ state: "ready" });

    vi.advanceTimersByTime(60 * 60 * 1_000);
    signedIn = false;
    const result = await claude.activate(
      {
        catalogRevision: BUNDLED_MODEL_CATALOG.revision,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      },
      BUNDLED_MODEL_CATALOG,
    );

    expect({ result, runtimeChanged: applyRuntimeConfig.mock.calls.length }).toEqual({
      result: { status: "refused", reason: "credential-required" },
      runtimeChanged: 0,
    });
  });
});
