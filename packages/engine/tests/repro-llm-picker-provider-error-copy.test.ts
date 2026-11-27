import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createCoachEngine } from "../src/index.js";
import type { EngineHostPorts, EngineLlmProvider } from "../src/host-ports.js";
import type { Sport } from "../src/sport.js";
import { normalizeClaudeCliError } from "../src/agent/claude-cli/errors.js";
import { notSignedInError as codexAgentNotSignedIn } from "../src/agent/codex-agent/errors.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { testModelProfiles } from "./helpers/model-profiles.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GENERIC = "Sorry, something went wrong. Please try again.";
const RATE_LIMIT = "Rate limited — please try again shortly.";

function engineFor(
  provider: EngineLlmProvider,
  model: string,
  fail: () => unknown,
): { engine: ReturnType<typeof createCoachEngine>; attempts: () => number } {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "repro-llm-picker-copy-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  const base = baseAgentConfig(dataDir);
  let attempts = 0;
  const ports: EngineHostPorts = {
    ...base,
    config: {
      ...base.config,
      llm: {
        provider,
        model,
        apiKey: provider === "claude-cli" || provider === "codex-agent" ? "" : "synthetic-key",
        ...(provider === "claude-cli"
          ? {
              claudeCli: {
                enabled: true,
                billing: "subscription" as const,
                cursorStorePath: join(dataDir, "claude-cli", "cursors.json"),
              },
            }
          : {}),
      } as EngineHostPorts["config"]["llm"],
      models: testModelProfiles({ provider, chat: model }),
    },
    randomId: () => "turn-repro-copy",
    modelTransportDecorator: () => ({
      generate: async (request) => {
        if (request.options.caller === "chat") attempts += 1;
        throw fail();
      },
    }),
  };
  return {
    engine: createCoachEngine({ sport: cyclingSport as unknown as Sport, ports }),
    attempts: () => attempts,
  };
}

async function errorEvent(engine: ReturnType<typeof createCoachEngine>) {
  const events: TurnEvent[] = [];
  await engine
    .chat({ chatId: "desktop", message: "How should I ride today?" }, (event) => {
      events.push(event);
    })
    .catch(() => undefined);
  const error = events.find((event) => event.type === "error") as
    | (TurnEvent & { kind: string; athleteMessage: string })
    | undefined;
  return error === undefined ? undefined : { kind: error.kind, athleteMessage: error.athleteMessage };
}

describe("llm-picker bug 8: subscription lanes signed out", () => {
  it("does not tell a Claude subscription athlete that their API key was rejected", async () => {
    const { engine } = engineFor("claude-cli", "sonnet", () =>
      normalizeClaudeCliError(new Error("Not logged in · Please run /login")),
    );
    const event = await errorEvent(engine);
    expect(event?.kind).toBe("provider-auth");
    expect(event?.athleteMessage, "the athlete has no API key, only a Claude sign-in").not.toMatch(
      /API key/iu,
    );
  });

  it("does not tell a Codex CLI athlete that their API key was rejected", async () => {
    const { engine } = engineFor("codex-agent", "gpt-5.6-sol", () => codexAgentNotSignedIn());
    const event = await errorEvent(engine);
    expect(event?.kind).toBe("provider-auth");
    expect(event?.athleteMessage, "the athlete has no API key, only a ChatGPT sign-in").not.toMatch(
      /API key/iu,
    );
  });

  it("control: an API-key provider's 401 does get the API-key copy", async () => {
    const { engine } = engineFor(
      "anthropic",
      "claude-sonnet-5",
      () =>
        new APICallError({
          message: "invalid x-api-key",
          url: "https://provider.invalid/v1/messages",
          requestBodyValues: {},
          statusCode: 401,
          responseBody: '{"type":"error","error":{"type":"authentication_error"}}',
          isRetryable: false,
        }),
    );
    const event = await errorEvent(engine);
    expect(event).toEqual({
      kind: "provider-auth",
      athleteMessage: "The model provider rejected the API key — check your provider credentials.",
    });
  });
});

describe("llm-picker bug 12 (lead): provider failures reported as something else", () => {
  it("tells the athlete to pick another model when the provider no longer serves the model (404)", async () => {
    const { engine } = engineFor(
      "openrouter",
      "synthetic/retired-model",
      () =>
        new APICallError({
          message: "No endpoints found for synthetic/retired-model.",
          url: "https://provider.invalid/api/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 404,
          responseBody: '{"error":{"message":"No endpoints found for synthetic/retired-model.","code":404}}',
          isRetryable: false,
        }),
    );
    const event = await errorEvent(engine);
    expect(event?.athleteMessage, "a retired model gets the generic copy with no hint").not.toBe(
      GENERIC,
    );
  });

  it("tells the athlete the account is out of credit when the provider answers 402", async () => {
    const { engine } = engineFor(
      "deepseek",
      "deepseek-v4-flash",
      () =>
        new APICallError({
          message: "Insufficient Balance",
          url: "https://provider.invalid/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 402,
          responseBody: '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
          isRetryable: false,
        }),
    );
    const event = await errorEvent(engine);
    expect(event?.athleteMessage, "an out-of-credit account gets the generic copy").not.toBe(
      GENERIC,
    );
  });

  it("does not retry and say 'try again shortly' when a 429 means the account has no quota", async () => {
    const { engine, attempts } = engineFor(
      "openai",
      "gpt-5.6-sol",
      () =>
        new APICallError({
          message: "You exceeded your current quota, please check your plan and billing details.",
          url: "https://provider.invalid/v1/responses",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after-ms": "1" },
          responseBody:
            '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}}',
          isRetryable: false,
        }),
    );
    const event = await errorEvent(engine);
    expect({ athleteMessage: event?.athleteMessage, chatAttempts: attempts() }).toEqual({
      athleteMessage: expect.not.stringMatching(/^Rate limited — please try again shortly\.$/u),
      chatAttempts: 1,
    });
    expect(RATE_LIMIT).toBeDefined();
  });
});
