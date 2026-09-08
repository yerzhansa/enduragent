import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLanguage, type LanguageResolution } from "@enduragent/i18n";
import { cyclingSport } from "@enduragent/sport-cycling";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { computeAssembledHash } from "../src/agent/prompt-lineage.js";
import { getTurnContext } from "../src/agent/turn-context.js";
import { createCoachEngine } from "../src/index.js";
import type { ModelTransportRequest, TranscriptCompletedTurnInput } from "../src/host-ports.js";
import type { GenerateResult } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

function config() {
  const root = mkdtempSync(join(tmpdir(), "engine-language-"));
  roots.push(root);
  return baseAgentConfig(root);
}

function result(
  text: string,
  finishReason: GenerateResult["finishReason"] = "stop",
): GenerateResult {
  return {
    text,
    finishReason,
    toolCalls: [],
    steps: 1,
    usage: {
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reply language resolution", () => {
  it.each(["preference", "message"] as const)(
    "uses the direct turn language and %s source with the registry locale",
    async (source) => {
      const requests: ModelTransportRequest[] = [];
      const resolveFor = vi.fn(async (): Promise<LanguageResolution> => ({
        language: "en",
        source: "default",
        locale: "en-GB",
      }));
      const engine = createCoachEngine({
        sport: cyclingSport,
        ports: {
          ...config(),
          language: { resolveFor },
          modelTransportDecorator: () => ({
            generate: async (request) => {
              requests.push(request);
              return result("Réponse");
            },
          }),
        },
      });

      await engine.chat({
        chatId: `direct-${source}`,
        message: "How should I train today?",
        turn: { language: "fr", languageSource: source },
      });

      expect(resolveFor).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(getTurnContext({ experimental_context: request?.options.context })?.language).toEqual({
        language: "fr",
        source,
        locale: describeLanguage("fr").defaultLocale,
      });
      expect(request?.options.system).toContain("French (Français)");
      expect(request?.options.system).toContain(
        source === "preference" ? "The athlete chose French" : "No language is saved.",
      );
    },
  );

  it("resolves an absent direct turn language from the exact athlete message", async () => {
    const language: LanguageResolution = { language: "es", source: "message", locale: "es-MX" };
    const resolveFor = vi.fn(async () => language);
    const requests: ModelTransportRequest[] = [];
    const engine = createCoachEngine({
      sport: cyclingSport,
      ports: {
        ...config(),
        language: { resolveFor },
        modelTransportDecorator: () => ({
          generate: async (request) => {
            requests.push(request);
            return result("Respuesta");
          },
        }),
      },
    });
    const message = "  ¿Cómo entreno hoy?\n";

    await engine.chat({ chatId: "direct-automatic", message });

    expect(resolveFor).toHaveBeenCalledExactlyOnceWith({
      chatId: "direct-automatic",
      athleteText: message,
    });
    expect(
      getTurnContext({ experimental_context: requests[0]?.options.context })?.language,
    ).toEqual(language);
    expect(requests[0]?.options.system).toContain("Spanish (Español)");
  });

  it("keeps concurrent languages isolated through recovery, lineage, and transcript capture", async () => {
    const base = config();
    const appendTurn = vi.spyOn(base.chatStore, "appendTurn");
    const completed: TranscriptCompletedTurnInput[] = [];
    const requests: ModelTransportRequest[] = [];
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const french: LanguageResolution = { language: "fr", source: "preference", locale: "fr-FR" };
    const spanish: LanguageResolution = { language: "es", source: "preference", locale: "es-ES" };
    const agent = new CoachAgent(cyclingSport, {
      ...base,
      transcriptWriter: {
        appendCompletedTurn: (turn) => {
          completed.push(turn);
        },
      },
      modelTransportDecorator: () => ({
        generate: async (request) => {
          requests.push(request);
          const context = getTurnContext({ experimental_context: request.options.context });
          if (context?.chatId === "concurrent-french") {
            markStarted();
            await gate;
            return result("", "tool-calls");
          }
          if (context?.chatId === "concurrent-spanish") return result("Respuesta española");
          return result("Réponse française");
        },
      }),
    });

    const first = agent.chat("concurrent-french", "Bonjour", { language: french });
    await started;
    try {
      await expect(agent.chat("concurrent-spanish", "Hola", { language: spanish })).resolves.toBe(
        "Respuesta española",
      );
    } finally {
      release();
    }
    await expect(first).resolves.toBe("Réponse française");

    expect(requests).toHaveLength(3);
    const [initialFrench, initialSpanish, recoveredFrench] = requests;
    expect(initialFrench?.options.system).toContain("The athlete chose French (Français)");
    expect(initialSpanish?.options.system).toContain("The athlete chose Spanish (Español)");
    expect(recoveredFrench?.options.system).toBe(initialFrench?.options.system);
    expect(recoveredFrench?.options.tools).toBeUndefined();
    expect(recoveredFrench?.options.messages).toHaveLength(
      (initialFrench?.options.messages?.length ?? 0) + 1,
    );
    for (const [chatId, request] of [
      ["concurrent-french", initialFrench],
      ["concurrent-spanish", initialSpanish],
    ] as const) {
      if (request?.options.system === undefined || request.options.messages === undefined) {
        throw new Error("Missing assembled chat prompt");
      }
      const saved = appendTurn.mock.calls.find(([id]) => id === chatId);
      expect(saved?.[3].assembledHash).toBe(
        computeAssembledHash(request.options.system, request.options.messages),
      );
    }
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: "concurrent-french",
          athleteText: "Bonjour",
          coachText: "Réponse française",
        }),
        expect.objectContaining({
          chatId: "concurrent-spanish",
          athleteText: "Hola",
          coachText: "Respuesta española",
        }),
      ]),
    );
    expect(completed).toHaveLength(2);
  });
});
