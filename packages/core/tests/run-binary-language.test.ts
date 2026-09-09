import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CoachLanguage } from "@enduragent/i18n";
import type { CoachEngine } from "@enduragent/coach-contract";
import type { Config } from "../src/config.js";
import type { Sport } from "../src/sport.js";
import type { LegacyEngineOverrides } from "../src/agent/coach-engine.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

const sport: Sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: () => [],
  intervalsActivityTypes: ["Ride"],
  athleteProfileSchema: z.object({}),
  tools: () => [],
};

describe("runBinary CLI language", { timeout: 15_000 }, () => {
  let dataDir: string;
  let originalArgv: string[];
  let sendLine: ((line: string) => Promise<void>) | undefined;
  let engineLanguage: CoachLanguage | undefined;
  const chat = vi.fn(async (_input: Parameters<CoachEngine["chat"]>[0]) => ({ text: "Ready." }));

  beforeEach(async () => {
    vi.resetModules();
    chat.mockClear();
    sendLine = undefined;
    engineLanguage = undefined;
    dataDir = mkdtempSync(join(tmpdir(), "enduragent-cli-language-"));
    originalArgv = process.argv;
    process.argv = ["node", "cycling-coach"];
    vi.stubEnv("ENDURAGENT_LANGUAGE", undefined);
    vi.stubEnv("LANGUAGE", undefined);
    vi.stubEnv("LC_ALL", undefined);
    vi.stubEnv("LC_MESSAGES", undefined);
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.spyOn(console, "log").mockImplementation(() => {});
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
    vi.doMock("../src/config.js", () => ({
      CONFIG_DIR: dataDir,
      envInt: () => undefined,
      loadConfig: () => config,
      resolveConfigSecrets: async (value: Config) => value,
    }));
    vi.doMock("../src/process-guard.js", () => ({
      installCrashHandlers: vi.fn(),
      logBootLine: vi.fn(),
    }));
    vi.doMock("../src/sport.js", () => ({ getEffectiveSections: () => [] }));
    vi.doMock("../src/agent/error-classify.js", () => ({
      classifyAgentError: () => ({ athleteMessage: "Chat failed." }),
    }));
    vi.doMock("../src/agent/confirmation-gate.js", () => ({ formatConfirmOutcome: vi.fn() }));
    vi.doMock("../src/memory/orphan-sections.js", () => ({ warnOrphanSections: vi.fn() }));
    vi.doMock("../src/usage-ledger.js", () => ({ appendUsageLine: vi.fn() }));
    vi.doMock("../src/reference/runtime.js", () => ({
      bootstrapReference: async () => ({ scheduler: { stop: vi.fn() } }),
    }));
    vi.doMock("../src/agent/coach-engine.js", () => ({
      createCoachEngine: (_sport: Sport, _config: Config, deps?: LegacyEngineOverrides) => {
        engineLanguage = deps?.language;
        return { chat, getMemory: () => undefined, confirmations: { peek: () => undefined } };
      },
    }));
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        on: (event: string, handler: (line: string) => Promise<void>) => {
          if (event === "line") sendLine = handler;
        },
        prompt: vi.fn(),
        close: vi.fn(),
      }),
    }));
    await import("../src/run-binary.js");
  }, 60_000);

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function start() {
    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(sport, cyclingBinary);
    if (sendLine === undefined || engineLanguage === undefined) {
      throw new Error("CLI startup did not install its chat handler and engine language");
    }
    return { sendLine, language: engineLanguage };
  }

  it("sends saved language on the turn and observes changes through the engine's same preference", async () => {
    writeFileSync(join(dataDir, "language.json"), JSON.stringify({ version: 1, language: "it" }));
    const cli = await start();
    await cli.sendLine("  How should I train today?  ");
    expect(chat).toHaveBeenLastCalledWith({
      chatId: "cli",
      message: "How should I train today?",
      turn: { language: "it", languageSource: "preference" },
    });
    await cli.language.set("de");
    await cli.sendLine("How should I train tomorrow?");
    expect(chat).toHaveBeenLastCalledWith({
      chatId: "cli",
      message: "How should I train tomorrow?",
      turn: { language: "de", languageSource: "preference" },
    });
  });

  it("keeps ENDURAGENT_LANGUAGE ahead of saved choices while persisting the next choice", async () => {
    vi.stubEnv("ENDURAGENT_LANGUAGE", "fr_FR.UTF-8");
    writeFileSync(join(dataDir, "language.json"), JSON.stringify({ version: 1, language: "it" }));
    const cli = await start();
    expect(await cli.language.set("de")).toEqual({
      value: "fr",
      origin: "environment",
      variable: "ENDURAGENT_LANGUAGE",
    });
    await cli.sendLine("How should I train today?");
    expect(chat).toHaveBeenLastCalledWith({
      chatId: "cli",
      message: "How should I train today?",
      turn: { language: "fr", languageSource: "preference" },
    });
    expect(JSON.parse(readFileSync(join(dataDir, "language.json"), "utf8"))).toEqual({
      version: 1,
      language: "de",
    });
  });

  it("uses the terminal hint for Automatic without a message signal", async () => {
    vi.stubEnv("LANG", "de_DE.UTF-8");
    const cli = await start();
    await cli.sendLine("👍");
    expect(chat).toHaveBeenLastCalledWith({
      chatId: "cli",
      message: "👍",
      turn: { language: "de", languageSource: "surface" },
    });
  });

  it("logs an invalid environment override once and uses saved language", async () => {
    vi.stubEnv("ENDURAGENT_LANGUAGE", "klingon");
    vi.stubEnv("CYCLING_COACH_LOG_LEVEL", "info");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dataDir, "language.json"), JSON.stringify({ version: 1, language: "it" }));
    const cli = await start();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[language] Invalid ENDURAGENT_LANGUAGE override; ignoring it.",
    );
    await cli.language.current();
    await cli.language.set("de");
    await cli.sendLine("How should I train today?");
    expect(chat).toHaveBeenLastCalledWith({
      chatId: "cli",
      message: "How should I train today?",
      turn: { language: "de", languageSource: "preference" },
    });
    expect(warning).toHaveBeenCalledTimes(1);
    const lines = readFileSync(join(dataDir, "logs", "log.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "warn",
      component: "language",
      event: "Invalid ENDURAGENT_LANGUAGE override; ignoring it.",
      value: "klingon",
    });
  });

  it("detects the original athlete message in Automatic ahead of the terminal hint", async () => {
    const cli = await start();
    const message = "今日はどのようなトレーニングをすればよいですか？";
    await cli.sendLine(message);
    expect(chat).toHaveBeenLastCalledWith({
      chatId: "cli",
      message,
      turn: { language: "ja", languageSource: "message" },
    });
  });
});
