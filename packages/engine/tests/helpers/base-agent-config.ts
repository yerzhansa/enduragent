import type { EngineHostPorts } from "../../src/host-ports.js";
import type { Config } from "../../../core/src/config.js";
import { createEngineHostAdapter } from "../../../core/src/agent/engine-host-adapter.js";
import { bundledAcceptedCatalog } from "../../../core/src/model-catalog.js";
import { legacyStateReader } from "../../../core/src/agent/legacy-athlete-state-reader.js";
import { classifyFailure } from "../../../core/src/agent/token-utils.js";

export function llmTestPorts(): Pick<
  EngineHostPorts,
  "usage" | "now" | "getAccessToken" | "classifyFailure" | "modelTransportDecorator"
> {
  return {
    usage: { append: () => undefined },
    now: () => 0,
    getAccessToken: async () => "token",
    classifyFailure,
  };
}

export function baseAgentConfig(dataDir: string): EngineHostPorts & Config {
  const config: Config = {
    dataSource: "platform",
    llm: {
      provider: "openai-codex",
      model: "gpt-5.4",
      apiKey: "",
      authProfile: "openai-codex",
    },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 272_000,
    dataDir,
  };
  const adapted = createEngineHostAdapter({
    config,
    stateReader: legacyStateReader,
    catalog: bundledAcceptedCatalog(),
  });
  return {
    ...adapted.ports,
    ...config,
    getAccessToken: async () => "token",
    transcriptWriter: {
      appendCompletedTurn: () => undefined,
    },
  };
}
