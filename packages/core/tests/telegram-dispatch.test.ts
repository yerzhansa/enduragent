import { createNpmCoachLanguage } from "../src/language-preference.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import { startTypingHeartbeat, TYPING_HEARTBEAT_MS } from "../src/channels/telegram.js";

import {
  ConfirmationGate,
  createProposalSummarizers,
  createToolConfirmationPort,
} from "../src/agent/confirmation-gate.js";
import { createPureCoreIntervalsTools } from "../src/sport.js";
import { createPlatformCalendarMutations } from "../src/athlete-data.js";
import { gateMutatingTool } from "../../engine/src/agent/coach-agent.js";
import { createTurnContext } from "../../engine/src/agent/turn-context.js";
import { COACH_EVENT_TAG } from "../src/agent/event-provenance.js";
import type { IntervalsClient } from "intervals-icu-api";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-dispatch-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("grammy");
  vi.doUnmock("@grammyjs/auto-retry");
  vi.doUnmock("../src/updater.js");
  vi.doUnmock("../src/channels/telegram-update-offsets.js");
});

interface FakeBot {
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    setMyCommands: ReturnType<typeof vi.fn>;
    config: { use: ReturnType<typeof vi.fn> };
  };
  use: ReturnType<typeof vi.fn>;
  callbackQuery: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
}

interface StubAgent {
  chat: ReturnType<typeof vi.fn>;
  hasSession: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
  getAthleteState: ReturnType<typeof vi.fn>;
  confirmations: {
    peek: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

interface StubReference {
  runSync: ReturnType<typeof vi.fn>;
  loadLatest: ReturnType<typeof vi.fn>;
}

interface BuildBotResult {
  bot: FakeBot;
  agent: StubAgent;
  reference: StubReference | undefined;
  drainPending: () => Promise<void>;
  autoRetry: ReturnType<typeof vi.fn>;
}

async function buildBot(opts?: {
  reference?: StubReference;
  stop?: () => Promise<void>;
  setMyCommands?: () => Promise<unknown>;
}): Promise<BuildBotResult> {
  const bot: FakeBot = {
    api: {
      sendMessage: vi.fn(async () => undefined),
      setMyCommands: vi.fn(opts?.setMyCommands ?? (async () => true)),
      config: { use: vi.fn() },
    },
    use: vi.fn(),
    callbackQuery: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    stop: vi.fn(opts?.stop ?? (async () => undefined)),
    catch: vi.fn(),
  };
  vi.doMock("grammy", () => ({
    Bot: function FakeBot() {
      return bot;
    },
    InputFile: class {},
  }));
  const autoRetry = vi.fn((options: unknown) => ({ options }));
  vi.doMock("@grammyjs/auto-retry", () => ({ autoRetry }));

  const agent: StubAgent = {
    chat: vi.fn(),
    hasSession: vi.fn(),
    resetSession: vi.fn(),
    getAthleteState: vi.fn(),
    confirmations: {
      peek: vi.fn(() => undefined),
      confirm: vi.fn(),
      cancel: vi.fn(),
    },
  };

  const { createTelegramBot } = await import("../src/channels/telegram.js");
  const { createNpmTelegramHost } = await import("../src/channels/npm-telegram-host.js");
  const host = createNpmTelegramHost({
    language: createNpmCoachLanguage(dataDir),
    binary: cyclingBinary,
    confirmations: agent.confirmations as never,
    dataDir,
    ...(opts?.reference === undefined ? {} : { reference: opts.reference as never }),
  });
  const { drainPending } = createTelegramBot({
    webhookPolicy: "delete-before-polling",
    token: "FAKE_TOKEN",
    engine: agent as never,
    host,
    dataDir,
  });

  return { bot, agent, reference: opts?.reference, drainPending, autoRetry };
}

function getCommand(bot: FakeBot, name: string) {
  const call = bot.command.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`command ${name} not registered`);
  return call[1] as (ctx: unknown) => Promise<void>;
}

function getMessageText(bot: FakeBot) {
  const call = bot.on.mock.calls.find((c: unknown[]) => c[0] === "message:text");
  if (!call) throw new Error("message:text handler not registered");
  return call[1] as (ctx: unknown) => Promise<void>;
}

function getCallbackQueryData(bot: FakeBot) {
  const handlers = bot.on.mock.calls
    .filter((c: unknown[]) => c[0] === "callback_query:data")
    .map((c: unknown[]) => c[1] as (ctx: unknown, next: () => Promise<void>) => Promise<void>);
  if (handlers.length === 0) throw new Error("callback_query:data handler not registered");
  return async (ctx: unknown): Promise<void> => {
    const run = async (index: number): Promise<void> => {
      const handler = handlers[index];
      if (handler === undefined) return;
      await handler(ctx, () => run(index + 1));
    };
    await run(0);
  };
}

function getBotCatch(bot: FakeBot) {
  const call = bot.catch.mock.calls[0];
  if (!call) throw new Error("bot.catch handler not registered");
  return call[0] as (botError: { error: unknown; ctx?: unknown }) => Promise<void>;
}

interface FakeCtx {
  chat: { id: number };
  from?: { id: number };
  match: string;
  message: { text: string; message_id?: number };
  reply: ReturnType<typeof vi.fn>;
  replyWithDocument: ReturnType<typeof vi.fn>;
  replyWithChatAction: ReturnType<typeof vi.fn>;
}

function configureAllowedSenders(primaryOperator: number, allowFrom: number[]): void {
  writeFileSync(
    join(dataDir, "allowed-senders.json"),
    JSON.stringify({
      version: 1,
      dmPolicy: "allowlist",
      allowFrom: allowFrom.map(String),
      primaryOperator: String(primaryOperator),
      capturedAt: "1998-06-01T00:00:00.000Z",
      addedAt: Object.fromEntries(
        allowFrom.map((senderId) => [String(senderId), "1998-06-01T00:00:00.000Z"]),
      ),
    }),
    { mode: 0o600 },
  );
}

function makeCtx(overrides?: Partial<FakeCtx>): FakeCtx {
  return {
    chat: { id: 777 },
    match: "",
    message: { text: "hi" },
    reply: vi.fn(async () => undefined),
    replyWithDocument: vi.fn(async () => undefined),
    replyWithChatAction: vi.fn(async () => true),
    ...overrides,
  };
}

function rateLimitError(retryAfterSec?: number): unknown {
  if (retryAfterSec !== undefined) {
    return new APICallError({
      message: "rate limited",
      url: "https://example.invalid/api",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": String(retryAfterSec) },
    });
  }
  return new Error("rate limit");
}

function apiError(statusCode: number): unknown {
  return new APICallError({
    message: "api error",
    url: "https://example.invalid/api",
    requestBodyValues: {},
    statusCode,
  });
}

function replyTexts(ctx: FakeCtx): string[] {
  return ctx.reply.mock.calls.map((c: unknown[]) => String(c[0]));
}

function someReply(ctx: FakeCtx, needle: string): boolean {
  return replyTexts(ctx).some((t) => t.includes(needle));
}

describe("command registration", () => {
  it("keeps outbound retry to one bounded unambiguous 429 attempt", async () => {
    const { bot, autoRetry } = await buildBot();

    expect(autoRetry).toHaveBeenCalledWith({
      maxRetryAttempts: 1,
      maxDelaySeconds: 5,
      rethrowInternalServerErrors: true,
      rethrowHttpErrors: true,
    });
    expect(bot.api.config.use).toHaveBeenCalledWith({
      options: {
        maxRetryAttempts: 1,
        maxDelaySeconds: 5,
        rethrowInternalServerErrors: true,
        rethrowHttpErrors: true,
      },
    });
  });

  it("registers all 10 commands when reference is provided", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const names = bot.command.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        "start",
        "plan",
        "workout",
        "status",
        "sync",
        "snapshot",
        "review",
        "version",
        "whatsnew",
        "update",
      ]),
    );
    expect(bot.on).toHaveBeenCalledWith("message:text", expect.any(Function));
  });

  it("omits /sync and /snapshot when reference is undefined", async () => {
    const { bot } = await buildBot();
    const names = bot.command.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).not.toContain("sync");
    expect(names).not.toContain("snapshot");
    for (const c of [
      "start",
      "plan",
      "workout",
      "status",
      "review",
      "version",
      "whatsnew",
      "update",
    ]) {
      expect(names).toContain(c);
    }
  });
});

describe("agent-backed commands", () => {
  const messageFor: Record<string, string> = {
    plan: "/plan",
    workout: "/workout",
    status: "/status",
    review: "/review",
  };

  it.each(["plan", "workout", "status", "review"])(
    "%s: agent.chat success → response routed through sendLongMessage",
    async (name) => {
      const { bot, agent, drainPending } = await buildBot();
      agent.chat.mockResolvedValue({ text: "ok" });
      const ctx = makeCtx();
      await getCommand(bot, name)(ctx);
      await drainPending();
      // No reference wired in this buildBot() → no per-turn anchor passed.
      expect(agent.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "telegram:777",
          message: messageFor[name],
        }),
      );
      const htmlReply = ctx.reply.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]).includes("ok") &&
          (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
      );
      expect(htmlReply).toBeDefined();
    },
  );

  it.each(["plan", "workout", "status", "review"])(
    "%s: agent.chat throws non-rate-limit → apology, never silent",
    async (name) => {
      const { bot, agent, drainPending } = await buildBot();
      agent.chat.mockRejectedValue(new Error("boom"));
      const ctx = makeCtx();
      await getCommand(bot, name)(ctx);
      await drainPending();
      expect(someReply(ctx, "Sorry, something went wrong")).toBe(true);
      expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(["plan", "workout", "status", "review"])(
    "%s: agent.chat rate-limited → wait-time message",
    async (name) => {
      const { bot, agent, drainPending } = await buildBot();
      agent.chat.mockRejectedValue(rateLimitError(30));
      const ctx = makeCtx();
      await getCommand(bot, name)(ctx);
      await drainPending();
      expect(someReply(ctx, "Rate limited — please try again in ~30 seconds.")).toBe(true);
    },
  );

  it("review with args forwards the args in the chat message", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockResolvedValue({ text: "ok" });
    const ctx = makeCtx({ match: "2026-05-01" });
    await getCommand(bot, "review")(ctx);
    await drainPending();
    expect(agent.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "/review 2026-05-01",
      }),
    );
    expect(someReply(ctx, "Reviewing your last session (2026-05-01)...")).toBe(true);
  });

  it("resolves the running CS anchor from a synced profile and passes it into chat", async () => {
    const reference: StubReference = {
      runSync: vi.fn(),
      loadLatest: vi.fn(() => ({
        athlete_profile: {
          sportSettings: [{ types: ["Run"], threshold_pace: 4.0, cs_confidence: "high" }],
        },
      })),
    };
    const { bot, agent, drainPending } = await buildBot({ reference });
    agent.chat.mockResolvedValue({ text: "ok" });
    const ctx = makeCtx();
    await getCommand(bot, "plan")(ctx);
    await drainPending();
    expect(agent.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "/plan",
        turn: expect.objectContaining({
          resolvedCs: { criticalSpeedMps: 4.0, source: "platform", confidence: "high" },
          referenceProvenance: { garmin: false, nonGarmin: false, unknown: true },
        }),
      }),
    );
  });
});

describe("confirmation callbacks", () => {
  function callbackCtx(data: string) {
    return {
      chat: { id: 777 },
      callbackQuery: { data },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    };
  }

  it("renders a proposal keyboard after the turn reply", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockResolvedValue({ text: "I proposed it." });
    agent.confirmations.peek.mockReturnValue({ nonce: "server-nonce", summary: "Save plan" });
    const ctx = makeCtx();
    await getCommand(bot, "plan")(ctx);
    await drainPending();
    expect(ctx.reply).toHaveBeenCalledWith("Save plan", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm", callback_data: "cg:y:server-nonce" },
            { text: "Cancel", callback_data: "cg:n:server-nonce" },
          ],
        ],
      },
    });
  });

  it.each<"intervals_delete_workout" | "intervals_update_workout">([
    "intervals_delete_workout",
    "intervals_update_workout",
  ])("shows the execution-time refusal for %s through the host callback", async (toolName) => {
    const { bot, agent, drainPending } = await buildBot();
    let category = "WORKOUT";
    const write = vi.fn();
    const client = {
      events: {
        get: vi.fn(async () => ({
          ok: true,
          value: {
            id: 42,
            name: "Synthetic workout",
            category,
            startDateLocal: "2999-01-02T00:00:00",
            tags: [COACH_EVENT_TAG],
          },
        })),
        update: write,
        delete: write,
      },
    } as unknown as IntervalsClient;
    const gate = new ConfirmationGate();
    const raw = createPureCoreIntervalsTools(
      client,
      "UTC",
      undefined,
      createPlatformCalendarMutations(client),
    )[toolName]!;
    const wrapped = gateMutatingTool(
      toolName,
      raw,
      createToolConfirmationPort({
        gate,
        summarizers: createProposalSummarizers({ intervals: client, tz: "UTC" }),
      }),
    );
    await wrapped.execute!({ eventId: 42, changes: { name: "Revised workout" } }, {
      experimental_context: createTurnContext({
        resolvedCs: null,
        chatId: "telegram:777",
        language: { language: "en", source: "default", locale: "en-GB" },
      }),
    } as never);
    const proposal = gate.peek("telegram:777")!;
    agent.confirmations.confirm.mockImplementation((chatId: string, nonce: string) =>
      gate.confirm(chatId, nonce),
    );
    category = "NOTE";
    const ctx = callbackCtx(`cg:y:${proposal.nonce}`);
    await getCallbackQueryData(bot)(ctx);
    await drainPending();
    expect(write).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Nothing was changed"));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("category NOTE"));
    expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining("Done"));
    await getCallbackQueryData(bot)(ctx);
    await drainPending();
    expect(write).not.toHaveBeenCalled();
    expect(client.events.get).toHaveBeenCalledTimes(2);
  });

  it("acks then executes a matching confirmation", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.confirmations.confirm.mockResolvedValue({
      status: "executed",
      summary: "Delete workout",
      result: { deleted: true },
    });
    const ctx = callbackCtx("cg:y:server-nonce");
    await getCallbackQueryData(bot)(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    await drainPending();
    expect(agent.confirmations.confirm).toHaveBeenCalledWith("telegram:777", "server-nonce");
    expect(ctx.reply).toHaveBeenCalledWith("Done — Delete workout.");
  });

  it("cancels and maps unknown or expired proposals to safe copy", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getCallbackQueryData(bot);
    agent.confirmations.cancel.mockReturnValue("canceled");
    const cancel = callbackCtx("cg:n:server-nonce");
    await handler(cancel);
    await drainPending();
    expect(cancel.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(cancel.reply).toHaveBeenCalledWith("Canceled — nothing was changed.");

    agent.confirmations.confirm.mockResolvedValue({ status: "expired" });
    const expired = callbackCtx("cg:y:old");
    await handler(expired);
    await drainPending();
    expect(expired.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(expired.reply).toHaveBeenCalledWith(
      "That proposal expired — ask me again and I'll re-propose.",
    );

    const unknown = callbackCtx("other:data");
    await handler(unknown);
    expect(unknown.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(agent.confirmations.confirm).toHaveBeenCalledTimes(1);
  });

  it("surfaces failed confirmations without exposing nonce mechanics", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.confirmations.confirm.mockResolvedValue({
      status: "failed",
      summary: "Save plan",
      message: "service unavailable",
    });
    const ctx = callbackCtx("cg:y:server-nonce");
    await getCallbackQueryData(bot)(ctx);
    await drainPending();
    expect(ctx.reply).toHaveBeenCalledWith("That didn't go through — service unavailable");
  });

  it("inherits update-offset dedupe so a duplicate callback resolves once", async () => {
    const { bot } = await buildBot();
    const dedupe = bot.use.mock.calls.at(-1)?.[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(dedupe).toBeDefined();
    const next = vi.fn(async () => undefined);
    const ctx = { update: { update_id: 9001 } };
    await dedupe!(ctx, next);
    await dedupe!(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("message:text — apology vs rate-limit fork", () => {
  it("agent.chat throw → apology (NOT silence)", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockRejectedValue(new Error("boom"));
    const ctx = makeCtx({ message: { text: "how's my form?" } });
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(someReply(ctx, "Sorry, something went wrong. Please try again.")).toBe(true);
    expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("rate-limit with retry-after header → classified wait copy, no stale 'not processed' line", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockRejectedValue(rateLimitError(45));
    const ctx = makeCtx({ message: { text: "plan my week" } });
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(someReply(ctx, "Rate limited — please try again in ~45 seconds.")).toBe(true);
    expect(someReply(ctx, "was not processed")).toBe(false);
  });

  it("rate-limit without header → default 'about a minute' wait", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockRejectedValue(new Error("rate limit"));
    const ctx = makeCtx({ message: { text: "ride plan" } });
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(someReply(ctx, "about a minute")).toBe(true);
  });
});

describe("retry transformer / classified errors / delivery split", () => {
  it("createSecuredBot installs the auto-retry transformer exactly once", async () => {
    const { bot, autoRetry } = await buildBot();
    expect(autoRetry).toHaveBeenCalledTimes(1);
    expect(bot.api.config.use).toHaveBeenCalledTimes(2);
  });

  it("generation provider-auth error → provider-auth copy (NOT delivery copy, NOT genericReply)", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockRejectedValue(apiError(401));
    const ctx = makeCtx();
    await getCommand(bot, "plan")(ctx);
    await drainPending();
    expect(
      someReply(ctx, "The model provider rejected the API key — check your provider credentials."),
    ).toBe(true);
    expect(someReply(ctx, "Telegram had trouble delivering")).toBe(false);
    expect(someReply(ctx, "Sorry, something went wrong generating your plan")).toBe(false);
  });

  it("generation refresh rejection gives the ChatGPT sign-in recovery path", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockRejectedValue({ refreshFailureReason: "reauth" });
    const ctx = makeCtx();
    await getCommand(bot, "plan")(ctx);
    await drainPending();
    expect(
      someReply(ctx, "Your ChatGPT sign-in is no longer valid. Sign in again to continue."),
    ).toBe(true);
    expect(someReply(ctx, "Sorry, something went wrong generating your plan")).toBe(false);
  });

  it("generation refresh rate limit retains the rate-limit copy", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockRejectedValue({
      refreshFailureReason: "rate_limit",
      retryAfterMs: 4_000,
    });
    const ctx = makeCtx();
    await getCommand(bot, "plan")(ctx);
    await drainPending();
    expect(someReply(ctx, "Rate limited — please try again in ~4 seconds.")).toBe(true);
  });

  it("generation unknown-kind error → caller genericReply (fallback only on unknown)", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockRejectedValue(new Error("???"));
    const ctx = makeCtx();
    await getCommand(bot, "plan")(ctx);
    await drainPending();
    expect(
      someReply(ctx, "Sorry, something went wrong generating your plan. Please try again."),
    ).toBe(true);
  });

  it("generation succeeds but delivery rejects (non-parse) → delivery copy AND the answer is resendable", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockResolvedValue({ text: "the generated answer" });
    const ctx = makeCtx({ message: { text: "how's my form?" } });
    ctx.reply.mockImplementation(async (_text: string, options?: Record<string, unknown>) => {
      if (options?.parse_mode === "HTML") {
        throw new Error(
          "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
        );
      }
      return undefined;
    });
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(someReply(ctx, "I generated the answer, but Telegram had trouble delivering it.")).toBe(
      true,
    );

    // The resend cache was written before delivery, so a follow-up resend re-emits it.
    const ctx2 = makeCtx({ message: { text: "resend" } });
    await getMessageText(bot)(ctx2);
    await drainPending();
    expect(someReply(ctx2, "the generated answer")).toBe(true);
  });

  it("after a successful turn, 'resend' (and '  RESEND  ') re-emit the same answer without re-running agent.chat", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockResolvedValue({ text: "cached answer body" });
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "how's my form?" } }));
    await drainPending();

    const ctx2 = makeCtx({ message: { text: "resend" } });
    await handler(ctx2);
    await drainPending();
    expect(someReply(ctx2, "cached answer body")).toBe(true);

    const ctx3 = makeCtx({ message: { text: "  RESEND  " } });
    await handler(ctx3);
    await drainPending();
    expect(someReply(ctx3, "cached answer body")).toBe(true);

    expect(agent.chat).toHaveBeenCalledTimes(1);
  });

  it("'resend' with no cached answer → guidance reply and NO agent.chat", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    const ctx = makeCtx({ message: { text: "resend" } });
    await getMessageText(bot)(ctx);
    expect(someReply(ctx, "I don't have a recent answer to resend.")).toBe(true);
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it("threads the first delivered chunk to ctx.message.message_id; later chunks are unthreaded", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockResolvedValue({ text: "x".repeat(9000) });
    const ctx = makeCtx({ message: { text: "long please", message_id: 4242 } });
    await getMessageText(bot)(ctx);
    await drainPending();
    const htmlCalls = ctx.reply.mock.calls.filter(
      (c: unknown[]) => (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
    );
    expect(htmlCalls.length).toBeGreaterThan(1);
    expect((htmlCalls[0][1] as { reply_parameters?: unknown }).reply_parameters).toEqual({
      message_id: 4242,
      allow_sending_without_reply: true,
    });
    for (const c of htmlCalls.slice(1)) {
      expect((c[1] as { reply_parameters?: unknown }).reply_parameters).toBeUndefined();
    }
  });

  it("the stale 'was not processed (rate limited)… resend:' copy never appears", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockRejectedValue(rateLimitError(30));
    const ctx = makeCtx({ message: { text: "plan my week" } });
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(replyTexts(ctx).some((t) => t.includes("was not processed"))).toBe(false);
    expect(replyTexts(ctx).some((t) => t.includes("and resend:"))).toBe(false);
  });

  it("the captured bot.catch handler replies a neutral apology; a reply throw does not escape", async () => {
    const { bot } = await buildBot();
    const handler = getBotCatch(bot);

    const reply = vi.fn(async () => undefined);
    await expect(
      handler({ error: apiError(401), ctx: { chat: { id: 1 }, reply } }),
    ).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledWith("Sorry, something went wrong. Please try again.");

    const throwingReply = vi.fn(async () => {
      throw new Error("cannot reply");
    });
    await expect(
      handler({ error: new Error("boom"), ctx: { chat: { id: 1 }, reply: throwingReply } }),
    ).resolves.toBeUndefined();
  });
});

describe("typing-indicator heartbeat", () => {
  describe("in-flight pulses (integration)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("pulses 'typing' immediately and again each interval while agent.chat is in flight", async () => {
      const { bot, agent, drainPending } = await buildBot();
      agent.hasSession.mockResolvedValue({ hasSession: true });
      let resolveChat!: (v: { text: string }) => void;
      agent.chat.mockReturnValue(
        new Promise<{ text: string }>((r) => {
          resolveChat = r;
        }),
      );
      const ctx = makeCtx({ message: { text: "how's my form?" } });

      await getMessageText(bot)(ctx);

      // Flush the immediate pulse microtask (fires before any interval elapses).
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.replyWithChatAction).toHaveBeenCalledWith("typing");
      const afterImmediate = ctx.replyWithChatAction.mock.calls.length;
      expect(afterImmediate).toBeGreaterThanOrEqual(1);

      // One interval → at least one more pulse; and a second interval → another.
      await vi.advanceTimersByTimeAsync(TYPING_HEARTBEAT_MS);
      await vi.advanceTimersByTimeAsync(TYPING_HEARTBEAT_MS);
      expect(ctx.replyWithChatAction.mock.calls.length).toBeGreaterThanOrEqual(afterImmediate + 2);
      expect(TYPING_HEARTBEAT_MS).toBeLessThanOrEqual(5_000);

      // Let the turn finish so no fake interval leaks past the test.
      resolveChat({ text: "done" });
      await drainPending();
    });

    it("stops the interval on normal completion — no further pulses", async () => {
      const { bot, agent, drainPending } = await buildBot();
      agent.hasSession.mockResolvedValue({ hasSession: true });
      let resolveChat!: (v: { text: string }) => void;
      agent.chat.mockReturnValue(
        new Promise<{ text: string }>((r) => {
          resolveChat = r;
        }),
      );
      const ctx = makeCtx({ message: { text: "how's my form?" } });

      await getMessageText(bot)(ctx);
      await vi.advanceTimersByTimeAsync(TYPING_HEARTBEAT_MS);

      resolveChat({ text: "the answer body" });
      await drainPending();
      expect(someReply(ctx, "the answer body")).toBe(true);

      const frozen = ctx.replyWithChatAction.mock.calls.length;
      await vi.advanceTimersByTimeAsync(TYPING_HEARTBEAT_MS * 5);
      expect(ctx.replyWithChatAction.mock.calls.length).toBe(frozen);
    });

    it("stops the interval on a generation error, and still fires the classified reply", async () => {
      const { bot, agent, drainPending } = await buildBot();
      agent.hasSession.mockResolvedValue({ hasSession: true });
      agent.chat.mockRejectedValue(rateLimitError(30));
      const ctx = makeCtx({ message: { text: "plan my week" } });

      await getMessageText(bot)(ctx);
      await drainPending();
      expect(someReply(ctx, "Rate limited — please try again in ~30 seconds.")).toBe(true);

      const frozen = ctx.replyWithChatAction.mock.calls.length;
      await vi.advanceTimersByTimeAsync(TYPING_HEARTBEAT_MS * 5);
      expect(ctx.replyWithChatAction.mock.calls.length).toBe(frozen);
    });

    it("a pulse that rejects on every call never affects the turn's reply path", async () => {
      const { bot, agent, drainPending } = await buildBot();
      agent.hasSession.mockResolvedValue({ hasSession: true });
      agent.chat.mockResolvedValue({ text: "the delivered answer" });
      const ctx = makeCtx({ message: { text: "how's my form?" } });
      ctx.replyWithChatAction.mockRejectedValue(new Error("chat action failed"));

      await getMessageText(bot)(ctx);
      await drainPending();

      // The reply still lands unchanged despite every pulse rejecting.
      expect(someReply(ctx, "the delivered answer")).toBe(true);
      const htmlReply = ctx.reply.mock.calls.find(
        (c: unknown[]) => (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
      );
      expect(htmlReply).toBeDefined();
    });
  });

  describe("startTypingHeartbeat (unit)", () => {
    it("a rejecting pulse routes to onError and never throws to the caller", async () => {
      const onError = vi.fn();
      const stop = startTypingHeartbeat(
        () => Promise.reject(new Error("pulse boom")),
        10_000,
        onError,
      );
      // Drain all pending microtasks (a rejected thenable adoption spans several
      // ticks) so the immediate best-effort pulse settles into .catch(onError).
      await new Promise((r) => setTimeout(r, 0));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(() => stop()).not.toThrow();
    });

    it("unrefs the interval on start and clears exactly that timer on stop", () => {
      const unref = vi.fn();
      const fakeTimer = { unref };
      const setIntervalSpy = vi.fn(() => fakeTimer);
      const clearIntervalSpy = vi.fn();
      vi.stubGlobal("setInterval", setIntervalSpy);
      vi.stubGlobal("clearInterval", clearIntervalSpy);
      try {
        const stop = startTypingHeartbeat(
          async () => undefined,
          TYPING_HEARTBEAT_MS,
          () => {},
        );
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(unref).toHaveBeenCalledTimes(1);
        expect(clearIntervalSpy).not.toHaveBeenCalled();

        stop();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("skips beats while the previous pulse is still unsettled, then resumes once it settles", async () => {
      vi.useFakeTimers();
      try {
        let settle!: () => void;
        const pulse = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              settle = resolve;
            }),
        );
        const stop = startTypingHeartbeat(pulse, 10_000, () => {});

        // The immediate beat fires exactly one pulse, which stays pending.
        await vi.advanceTimersByTimeAsync(0);
        expect(pulse).toHaveBeenCalledTimes(1);

        // Several intervals elapse while that pulse is parked — every tick is
        // skipped by the in-flight guard, so still only the one pulse.
        await vi.advanceTimersByTimeAsync(10_000 * 3);
        expect(pulse).toHaveBeenCalledTimes(1);

        // Settle the parked pulse; the guard releases and the next tick beats.
        settle();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pulse).toHaveBeenCalledTimes(2);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop returns the in-flight pulse settlement for generation drain", async () => {
      let settle!: () => void;
      const pulse = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const stop = startTypingHeartbeat(
        () => pulse,
        10_000,
        () => {},
      );
      await Promise.resolve();

      let stopped = false;
      const stopping = stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      settle();
      await stopping;
      expect(stopped).toBe(true);
    });
  });
});

describe("message:text — greet / re-greet logic", () => {
  it("first message from a newcomer (no session) → WELCOME then chat", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: false });
    agent.chat.mockResolvedValue({ text: "reply text" });
    const ctx = makeCtx();
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(String(ctx.reply.mock.calls[0][0]).startsWith("Welcome to Cycling Coach!")).toBe(true);
    expect(someReply(ctx, "reply text")).toBe(true);
  });

  it("returning user after restart (hasSession true) is NOT re-greeted", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: true });
    agent.chat.mockResolvedValue({ text: "reply text" });
    const ctx = makeCtx();
    await getMessageText(bot)(ctx);
    await drainPending();
    expect(someReply(ctx, "Welcome to Cycling Coach!")).toBe(false);
  });

  it("second message in the same process is NOT re-greeted", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.hasSession.mockResolvedValue({ hasSession: false });
    agent.chat.mockResolvedValue({ text: "reply text" });
    const handler = getMessageText(bot);
    const ctx = makeCtx({ chat: { id: 775 } });
    await handler(ctx);
    await handler(ctx);
    await drainPending();
    const welcomeCount = replyTexts(ctx).filter((t) =>
      t.includes("Welcome to Cycling Coach!"),
    ).length;
    expect(welcomeCount).toBeLessThanOrEqual(1);
  });
});

describe("/snapshot — arg fallback", () => {
  it("no args → SNAPSHOT_HELP", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ match: "" });
    await getCommand(bot, "snapshot")(ctx);
    expect(someReply(ctx, "/snapshot raw")).toBe(true);
  });

  it("unknown subcommand → SNAPSHOT_HELP", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ match: "frobnicate" });
    await getCommand(bot, "snapshot")(ctx);
    expect(someReply(ctx, "/snapshot raw")).toBe(true);
  });

  it("'raw' with no synced data → 'hasn't synced yet' guidance", async () => {
    configureAllowedSenders(777, [777]);
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn(() => null) };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ from: { id: 777 }, match: "raw" });
    await getCommand(bot, "snapshot")(ctx);
    expect(someReply(ctx, "hasn't synced yet")).toBe(true);
  });

  it("denies raw data to an allowed sender who is not the primary operator", async () => {
    configureAllowedSenders(777, [777, 888]);
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn(() => null) };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ chat: { id: 888 }, from: { id: 888 }, match: "raw wellness" });

    await getCommand(bot, "snapshot")(ctx);

    expect(reference.loadLatest).not.toHaveBeenCalled();
    expect(someReply(ctx, "primary operator")).toBe(true);
    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
  });
});

describe("/update — ordering invariant", () => {
  it("managed deploys reply with image-update guidance and skip npm self-update", async () => {
    vi.stubEnv("CYCLING_COACH_MANAGED_DEPLOY", "1");
    const checkForUpdate = vi.fn(async () => ({
      current: "2026.5.5",
      latest: "2026.5.10",
      updateAvailable: true,
    }));
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate,
        selfUpdate,
      };
    });

    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "update")(ctx);

    expect(someReply(ctx, "container image")).toBe(true);
    expect(someReply(ctx, "GHCR image")).toBe(true);
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(bot.stop).not.toHaveBeenCalled();
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  it("REGRESSION: /update calls bot.stop() BEFORE selfUpdate (no infinite re-send loop)", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        selfUpdate,
      };
    });

    let releaseStop!: () => void;
    const stopP = new Promise<void>((r) => {
      releaseStop = r;
    });
    const { bot } = await buildBot({ stop: () => stopP });
    const ctx = makeCtx();

    await getCommand(bot, "update")(ctx);

    expect(bot.stop).toHaveBeenCalled();
    expect(selfUpdate).not.toHaveBeenCalled();

    releaseStop();
    // /update chains stop → generation drain → selfUpdate; drain the
    // microtask queue until selfUpdate is reached.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(selfUpdate).toHaveBeenCalledWith("cycling-coach", "2026.5.10");
    expect(bot.stop.mock.invocationCallOrder[0]).toBeLessThan(
      selfUpdate.mock.invocationCallOrder[0],
    );
  });

  it("no update available → 'latest version' reply, no stop/selfUpdate", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.5",
          updateAvailable: false,
        })),
        selfUpdate,
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "update")(ctx);
    expect(someReply(ctx, "latest version")).toBe(true);
    expect(someReply(ctx, "2026.5.5")).toBe(true);
    expect(bot.stop).not.toHaveBeenCalled();
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  it("checkForUpdate returns null → 'Could not check' reply", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => null),
        selfUpdate,
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "update")(ctx);
    expect(someReply(ctx, "Could not check for updates. Try again later.")).toBe(true);
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  it("self-update marker write failure → safe retry copy, does NOT stop or self-update", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        selfUpdate,
      };
    });
    vi.doMock("../src/channels/telegram-update-offsets.js", () => ({
      TelegramUpdateOffsetStore: class {
        shouldDispatch() {
          return true;
        }
        recordSelfUpdate() {
          throw new Error("marker write failed");
        }
      },
    }));

    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "update")(ctx);

    expect(someReply(ctx, "Couldn't safely prepare the update just now")).toBe(true);
    expect(bot.stop).not.toHaveBeenCalled();
    expect(selfUpdate).not.toHaveBeenCalled();
  });
});

describe("version / whatsnew / sync", () => {
  it("/version → displayName + version", async () => {
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        getCurrentVersion: vi.fn(() => "2026.5.5"),
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "version")(ctx);
    expect(someReply(ctx, "Cycling Coach")).toBe(true);
    expect(someReply(ctx, "2026.5.5")).toBe(true);
  });

  it("/whatsnew: checkForUpdate null → npm-unreachable reply", async () => {
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => null),
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "whatsnew")(ctx);
    expect(someReply(ctx, "Couldn't reach npm")).toBe(true);
  });

  it("/sync success → runSync called and reply sent", async () => {
    const reference: StubReference = {
      runSync: vi.fn(async () => ({
        kind: "ran",
        lastSyncAt: "1998-05-09T14:23:00.000Z",
        refreshed: ["latest", "history"],
      })),
      loadLatest: vi.fn(),
    };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx();
    await getCommand(bot, "sync")(ctx);
    expect(reference.runSync).toHaveBeenCalledWith({ chatId: "telegram:777" });
    expect(someReply(ctx, "Syncing training data from intervals.icu...")).toBe(true);
    expect(someReply(ctx, "Sync")).toBe(true);
  });

  it("/sync throw → 'something went wrong syncing' apology", async () => {
    const reference: StubReference = {
      runSync: vi.fn(async () => {
        throw new Error("boom");
      }),
      loadLatest: vi.fn(),
    };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx();
    await getCommand(bot, "sync")(ctx);
    expect(someReply(ctx, "something went wrong syncing")).toBe(true);
  });
});

describe("long replies chunk via sendLongMessage", () => {
  it("a >4096-char agent reply arrives as multiple HTML chunks", async () => {
    const { bot, agent, drainPending } = await buildBot();
    agent.chat.mockResolvedValue({ text: "x".repeat(9000) });
    const ctx = makeCtx();
    await getCommand(bot, "status")(ctx);
    await drainPending();
    const htmlChunks = ctx.reply.mock.calls.filter(
      (c: unknown[]) => (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
    );
    expect(htmlChunks.length).toBeGreaterThan(1);
  });
});

function menuCommands(bot: FakeBot): { command: string; description: string }[] {
  const call = bot.api.setMyCommands.mock.calls[0];
  if (!call) throw new Error("setMyCommands not called");
  return call[0] as { command: string; description: string }[];
}

describe("command menu (setMyCommands)", () => {
  it("is called once at construction, with descriptions matching the WELCOME one-liners", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    expect(bot.api.setMyCommands).toHaveBeenCalledTimes(1);
    expect(menuCommands(bot)).toEqual(
      expect.arrayContaining([
        { command: "start", description: "Start a fresh session" },
        { command: "plan", description: "Generate a training plan" },
        { command: "workout", description: "Get today's workout" },
        { command: "status", description: "Check current fitness, fatigue, and form" },
        { command: "review", description: "Review your last session" },
        { command: "version", description: "Show current version" },
        { command: "whatsnew", description: "See what changed in the latest version" },
        { command: "update", description: "Check for and install updates" },
      ]),
    );
  });

  it("includes /sync and /start when reference is provided; never /snapshot", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const names = menuCommands(bot).map((c) => c.command);
    expect(names).toContain("sync");
    expect(names).toContain("start");
    expect(names).not.toContain("snapshot");
  });

  it("omits /sync when reference is undefined", async () => {
    const { bot } = await buildBot();
    const names = menuCommands(bot).map((c) => c.command);
    expect(names).not.toContain("sync");
    expect(names).not.toContain("snapshot");
    for (const c of [
      "start",
      "plan",
      "workout",
      "status",
      "review",
      "version",
      "whatsnew",
      "update",
    ]) {
      expect(names).toContain(c);
    }
  });

  it("a setMyCommands rejection at startup is swallowed (construction does not throw)", async () => {
    await expect(
      buildBot({
        setMyCommands: async () => {
          throw new Error("telegram down");
        },
      }),
    ).resolves.toBeDefined();
  });
});
