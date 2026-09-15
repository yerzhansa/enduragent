import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngineHostAdapter } from "../../core/src/agent/engine-host-adapter.js";
import { bundledAcceptedCatalog } from "../../core/src/model-catalog.js";
import { legacyStateReader } from "../../core/src/agent/legacy-athlete-state-reader.js";
import type { Config } from "../../core/src/config.js";

describe("compact context window", () => {
  let dataDir: string;
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("uses the compact model window when it differs from the chat model", () => {
    dataDir = mkdtempSync(join(tmpdir(), "compact-window-"));
    const config: Config = {
      dataSource: "platform",
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        compactModel: "claude-haiku-4-5-20251001",
        apiKey: "test",
      },
      intervals: { apiKey: "", athleteId: "0" },
      telegram: { botToken: "" },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      contextWindowTokens: 1_000_000,
      dataDir,
    };
    const { ports } = createEngineHostAdapter({
      config,
      stateReader: legacyStateReader,
      catalog: bundledAcceptedCatalog(),
    });
    expect(ports.config.contextWindowTokens).toBe(1_000_000);
    expect(ports.config.compactContextWindowTokens).toBe(200_000);
  });
});
