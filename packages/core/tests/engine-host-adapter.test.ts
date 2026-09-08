import { createNpmCoachLanguage } from "../src/language-preference.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { createCoachEngine, markProviderAuthFailure } from "@enduragent/engine";
import type { Sport } from "@enduragent/engine/sport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../src/config.js";
import { createEngineHostAdapter } from "../src/agent/engine-host-adapter.js";
import { ConversationStore } from "../src/agent/conversation-store.js";
import type { RefreshFailureReason } from "../src/auth/refresh-failure.js";
import {
  LegacyAthleteStateUnavailableError,
  legacyStateReader,
} from "../src/agent/legacy-athlete-state-reader.js";
import { classifyFailure, extractRetryAfterMs } from "../src/agent/token-utils.js";

function config(dataDir: string): Config {
  return {
    dataSource: "platform",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
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
}

function apiError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({
    message: `status ${statusCode}`,
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
    responseHeaders,
  });
}

const sport: Sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: z.object({}),
  tools: () => [],
};

function codexConfig(dataDir: string): Config {
  return {
    ...config(dataDir),
    llm: {
      provider: "openai-codex",
      model: "gpt-5.4",
      apiKey: "",
      authProfile: "openai-codex",
    },
  };
}

const persistentRefreshCases: ReadonlyArray<readonly [RefreshFailureReason, number]> = [
  ["rate_limit", 4],
  ["server_error", 3],
  ["network", 3],
  ["reauth", 2],
];

function codexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("engine host adapter", () => {
  let dataDir: string;
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("resolves through the shared language service after preference changes", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-language-"));
    vi.stubEnv("ENDURAGENT_LANGUAGE", "");
    vi.stubEnv("LANGUAGE", "de_DE.UTF-8");
    const language = createNpmCoachLanguage(dataDir);
    const resolve = vi.spyOn(language, "resolveFor");
    const { ports } = createEngineHostAdapter({
      config: config(dataDir),
      stateReader: legacyStateReader,
      overrides: { language },
    });
    await language.set("it");
    await expect(
      ports.language.resolveFor({ chatId: "synthetic", athleteText: "hello" }),
    ).resolves.toMatchObject({ language: "it", source: "preference" });
    expect(resolve).toHaveBeenLastCalledWith({ athleteText: "hello" });
    await language.set(null);
    await expect(
      ports.language.resolveFor({ chatId: "synthetic", athleteText: "42" }),
    ).resolves.toMatchObject({ language: "de", source: "surface" });
  });

  it("uses the environment override while persisting the next preference", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-language-env-"));
    vi.stubEnv("ENDURAGENT_LANGUAGE", "fr");
    const language = createNpmCoachLanguage(dataDir);
    const { ports } = createEngineHostAdapter({
      config: config(dataDir),
      stateReader: legacyStateReader,
      overrides: { language },
    });
    await expect(language.set("ja")).resolves.toMatchObject({
      value: "fr",
      origin: "environment",
    });
    await expect(
      ports.language.resolveFor({ chatId: "synthetic", athleteText: "hello" }),
    ).resolves.toMatchObject({ language: "fr", source: "preference" });
    vi.stubEnv("ENDURAGENT_LANGUAGE", "");
    await expect(createNpmCoachLanguage(dataDir).current()).resolves.toMatchObject({
      value: "ja",
      origin: "stored",
    });
  });

  it("projects immutable engine config with independent chat and compact windows", () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-"));
    const { ports } = createEngineHostAdapter({
      config: config(dataDir),
      stateReader: legacyStateReader,
    });
    expect(ports.config).toEqual({
      dataSource: "platform",
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        compactModel: "claude-haiku-4-5-20251001",
        apiKey: "test",
      },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      contextWindowTokens: 1_000_000,
      compactContextWindowTokens: 200_000,
    });
    expect(Object.isFrozen(ports.config)).toBe(true);
    expect(Object.isFrozen(ports.config.llm)).toBe(true);
    expect(Object.isFrozen(ports.config.session)).toBe(true);
  });

  it("exposes one stable Core-owned conversation coordinator for both ports", () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-transcript-"));
    const { ports, conversationStore } = createEngineHostAdapter({
      config: config(dataDir),
      stateReader: legacyStateReader,
    });

    expect(conversationStore).toBeInstanceOf(ConversationStore);
    expect(ports.chatStore).toBe(conversationStore);
    expect(ports.transcriptWriter).toBe(conversationStore);
  });

  it("wires the exact rejecting legacy athlete-state reader", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-"));
    const { ports } = createEngineHostAdapter({
      config: config(dataDir),
      stateReader: legacyStateReader,
    });
    await expect(ports.stateReader.getAthleteState()).rejects.toEqual(
      new LegacyAthleteStateUnavailableError(
        "The legacy positional facade exposes no persisted athlete-state reader.",
      ),
    );
  });

  it("uses one classifier for every failure discriminant", () => {
    const timeout = Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" });
    const network = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const server = Object.assign(new Error("server"), { name: "ServerError" });
    expect([
      classifyFailure(new Error("maximum context length exceeded")),
      classifyFailure(timeout),
      classifyFailure(apiError(429)),
      classifyFailure(server),
      classifyFailure(network),
      classifyFailure(apiError(401)),
      classifyFailure({ refreshFailureReason: "reauth" }),
      classifyFailure(apiError(400)),
      classifyFailure(new Error("unclassified")),
    ]).toEqual([
      "overflow",
      "timeout",
      "rate_limit",
      "server_error",
      "network",
      "auth",
      "reauth",
      "invalid_request",
      "unknown",
    ]);
  });

  it("classifies a marked provider auth failure as auth without touching other errors", () => {
    const signedOut = markProviderAuthFailure(
      Object.assign(new Error("Claude Code CLI is not signed in."), {
        name: "ClaudeCliConfigError",
      }),
    );
    expect(classifyFailure(signedOut)).toBe("auth");
    expect(
      classifyFailure(
        Object.assign(new Error("Claude Code CLI is not signed in."), {
          name: "ClaudeCliConfigError",
        }),
      ),
    ).toBe("unknown");
    expect(classifyFailure({ providerAuthFailure: false })).toBe("unknown");
  });

  it("classifies copied refresh failures only from the structural discriminant", () => {
    expect(
      classifyFailure({
        name: "ForeignPackageError",
        message: "Opaque synthetic failure",
        refreshFailureReason: "reauth",
      }),
    ).toBe("reauth");
    expect(
      classifyFailure({
        name: "ForeignPackageError",
        message: "Opaque synthetic failure",
        refreshFailureReason: "rate_limit",
      }),
    ).toBe("rate_limit");
    expect(
      classifyFailure(
        Object.assign(new Error("Failed to refresh OAuth token"), {
          name: "RefreshTokenReusedError",
        }),
      ),
    ).toBe("unknown");
    expect(classifyFailure({ refreshFailureReason: "credential_denied" })).toBe("unknown");
  });

  it("parses retry-after milliseconds and seconds through the injected helper", () => {
    expect(extractRetryAfterMs(apiError(429, { "retry-after-ms": "1250" }))).toBe(1250);
    expect(extractRetryAfterMs(apiError(429, { "retry-after": "3" }))).toBe(3000);
    expect(extractRetryAfterMs(new Error("none"))).toBeNull();
  });

  it.each(persistentRefreshCases)(
    "bounds persistent %s refresh failures at the owning retry layer (%i endpoint calls)",
    async (reason, expectedCalls) => {
      dataDir = mkdtempSync(join(tmpdir(), "engine-host-composed-"));
      mkdirSync(join(dataDir, "memory"), { recursive: true });
      writeFileSync(
        join(dataDir, "auth-profiles.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: codexAccessToken("synthetic-account"),
            refresh: "synthetic-refresh",
            expires: 0,
            accountId: "synthetic-account",
          },
        }),
        { mode: 0o600 },
      );
      vi.stubEnv("CYCLING_COACH_HOME", dataDir);
      vi.resetModules();
      const responsesEndpoint = "https://chatgpt.com/backend-api/codex/responses";
      const tokenEndpoint = "https://auth.openai.com/oauth/token";
      const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input) === responsesEndpoint) {
          return new Response("", { status: 401 });
        }
        if (reason === "network") {
          throw Object.assign(new TypeError("Synthetic network failure"), {
            cause: { code: "ECONNRESET" },
          });
        }
        if (reason === "rate_limit") return new Response("", { status: 429 });
        if (reason === "server_error") return new Response("", { status: 503 });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { createEngineHostAdapter: createFreshAdapter } =
        await import("../src/agent/engine-host-adapter.js");
      const { ports } = createFreshAdapter({
        config: codexConfig(dataDir),
        stateReader: legacyStateReader,
      });
      const engine = createCoachEngine({ sport, ports });

      vi.useFakeTimers();
      const settled = engine.chat({ chatId: `persistent-${reason}`, message: "hello" }).then(
        () => null,
        (failure: unknown) => failure,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      const failure = await settled;

      const requestUrls = fetchStub.mock.calls.map(([input]) => String(input));
      expect(ports.classifyFailure(failure)).toBe(reason);
      expect(requestUrls[0]).toBe(responsesEndpoint);
      expect(requestUrls.filter((url) => url === tokenEndpoint)).toEqual(
        Array.from({ length: expectedCalls }, () => tokenEndpoint),
      );
    },
  );
});
