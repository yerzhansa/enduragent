import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KEYLESS_LLM_PROVIDERS } from "@enduragent/coach-contract";
import type { Config, LlmProvider } from "@enduragent/core";

const home = mkdtempSync(join(tmpdir(), "season-review-keyless-"));
process.env.CYCLING_COACH_HOME = home;
writeFileSync(join(home, "config.yaml"), "llm:\n  provider: anthropic\n", { mode: 0o600 });

const { resolveSeasonReviewLlmApiKey } = await import("../src/season-review-command.js");

afterAll(() => {
  delete process.env.CYCLING_COACH_HOME;
  rmSync(home, { recursive: true, force: true });
});

function configured(provider: LlmProvider, apiKey: string): Config {
  return {
    dataSource: "store",
    telegram: { botToken: "" },
    dataDir: join(home, "data"),
    llm: { provider, model: "synthetic-model", apiKey },
    intervals: { apiKey: "", athleteId: "0" },
    session: {
      historyTokenBudgetRatio: 0.5,
      idleMinutes: 0,
      dailyResetHour: 0,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 100_000,
  };
}

describe("season review model credentials", () => {
  it("accepts every keyless provider with an empty api key", async () => {
    for (const provider of KEYLESS_LLM_PROVIDERS) {
      await expect(resolveSeasonReviewLlmApiKey(configured(provider, ""))).resolves.toBe("");
    }
  });

  it("still refuses a key-bearing provider with no resolvable api key", async () => {
    await expect(resolveSeasonReviewLlmApiKey(configured("anthropic", ""))).rejects.toThrow(
      "Configured model credentials are unavailable.",
    );
  });

  it("passes a configured api key through untouched", async () => {
    await expect(
      resolveSeasonReviewLlmApiKey(configured("anthropic", "sk-synthetic")),
    ).resolves.toBe("sk-synthetic");
  });
});
