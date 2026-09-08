import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoachEngine } from "@enduragent/coach-contract";
import { createCoachLanguage } from "@enduragent/i18n";
import {
  createFileLanguagePreferenceStore,
  readEnvironmentSurfaceHint,
} from "@enduragent/i18n/node";
import type { ApiClientOptions, Bot } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../src/channels/telegram-access.js";
import type {
  TelegramHostCapabilities,
  TelegramOperationsCapabilities,
} from "../src/channels/telegram-host.js";
import { languageKeyboard } from "../src/channels/telegram-language-menu.js";
import { createTelegramBot } from "../src/channels/telegram.js";

const captured = vi.hoisted(
  (): { bot?: Bot; calls: { method: string; payload: unknown }[]; unchangedMarkup: boolean } => ({
    calls: [],
    unchangedMarkup: false,
  }),
);

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(...args: ConstructorParameters<typeof actual.Bot>) {
        super(args[0], {
          ...args[1],
          client: {
            ...args[1]?.client,
            fetch: async (url) => {
              const body = JSON.stringify(
                captured.unchangedMarkup && String(url).endsWith("/editMessageReplyMarkup")
                  ? {
                      ok: false,
                      error_code: 400,
                      description: "Bad Request: message is not modified",
                    }
                  : { ok: true, result: true },
              );
              const response = new Response(body);
              const result: Awaited<ReturnType<NonNullable<ApiClientOptions["fetch"]>>> = {
                headers: Object.assign(new Headers(), {
                  raw: () => ({}),
                  forEach: () => undefined,
                }),
                ok: response.ok,
                redirected: false,
                status: response.status,
                statusText: response.statusText,
                type: response.type,
                url: response.url,
                body: null,
                bodyUsed: false,
                size: 0,
                buffer: async () => Buffer.from(body),
                arrayBuffer: () => response.arrayBuffer(),
                formData: () => response.formData(),
                blob: () => response.blob(),
                json: () => response.json(),
                text: () => response.text(),
                clone: () => result,
              };
              return result;
            },
          },
        });
        captured.bot = this;
        this.api.config.use(async (previous, method, payload, signal) => {
          captured.calls.push({ method, payload });
          return previous(method, payload, signal);
        });
      }
    },
  };
});

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "enduragent-telegram-language-"));
  captured.bot = undefined;
  captured.calls = [];
  captured.unchangedMarkup = false;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function buildBot(env: NodeJS.ProcessEnv = {}, operations?: TelegramOperationsCapabilities) {
  const language = createCoachLanguage({
    store: createFileLanguagePreferenceStore({ dir: dataDir, env }),
    surface: readEnvironmentSurfaceHint(env),
  });
  const chat = vi.fn<CoachEngine["chat"]>(async () => ({ text: "Training response" }));
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected engine method");
  };
  const engine: CoachEngine = {
    chat,
    hasSession: async () => ({ hasSession: true }),
    resetSession: async () => ({ memoryFlushed: true }),
    getAthleteState: unused,
    getCoachDecision: unused,
    answerCoachDecision: unused,
    skipCoachDecision: unused,
    resumeCoachDecision: unused,
  };
  const confirmations: TelegramHostCapabilities["confirmations"] = {
    peek: vi.fn(async () => undefined),
    confirm: vi.fn<TelegramHostCapabilities["confirmations"]["confirm"]>(async () => ({
      status: "none",
    })),
    cancel: vi.fn<TelegramHostCapabilities["confirmations"]["cancel"]>(async () => "canceled"),
  };
  const host: TelegramHostCapabilities = {
    language,
    access: {
      middleware: createAuthMiddleware({
        dataDir,
        binaryName: "cycling-coach",
        challengeRateLimit: new Map(),
        challengeMinIntervalMs: 0,
        loadAllowedSenders: () => ({
          version: 1,
          dmPolicy: "allowlist",
          allowFrom: ["77"],
          primaryOperator: "77",
          capturedAt: null,
          addedAt: {},
        }),
      }),
    },
    confirmations,
    authorization: { isPrimaryOperator: async () => true },
    ...(operations === undefined ? {} : { operations }),
    release: {
      updatePolicy: "desktop-owned",
      updateDescription: "Check for updates",
      whatsNewUnavailableText: "Unavailable",
      version: async () => "0.0.0",
      whatsNew: async () => ({ kind: "unavailable" }),
      updateNotice: async () => "Update from Desktop.",
    },
  };
  const runtime = createTelegramBot({
    token: "123:TEST",
    webhookPolicy: "preserve",
    engine,
    host,
    dataDir,
  });
  const bot = captured.bot;
  if (bot === undefined) throw new Error("Bot was not constructed");
  bot.botInfo = {
    id: 123,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  await Promise.resolve();
  const registrationCalls = captured.calls.splice(0);
  const calls = captured.calls;
  return { bot, runtime, language, chat, confirmations, calls, registrationCalls };
}

function message(text: string, id = 1): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      from: { id: 77, is_bot: false, first_name: "Test" },
      chat: { id: 77, type: "private", first_name: "Test" },
      text,
      ...(text.startsWith("/")
        ? {
            entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
          }
        : {}),
    },
  };
}

function callback(data: string, senderId = 77, id = 1): Update {
  return {
    update_id: id,
    callback_query: {
      id: `callback-${id}`,
      chat_instance: "test-chat",
      from: { id: senderId, is_bot: false, first_name: "Test" },
      data,
      message: { message_id: 50, date: 0, chat: { id: 77, type: "private", first_name: "Test" } },
    },
  };
}

describe("Telegram language preference", () => {
  it("registers the language command in the Telegram menu", async () => {
    const { registrationCalls } = await buildBot();
    expect(registrationCalls).toContainEqual({
      method: "setMyCommands",
      payload: expect.objectContaining({
        commands: expect.arrayContaining([
          { command: "language", description: "Choose your language" },
        ]),
      }),
    });
  });

  it("replies to /language with the current grid", async () => {
    const { bot, calls, language } = await buildBot();
    await bot.handleUpdate(message("/language"));
    expect(calls).toContainEqual({
      method: "sendMessage",
      payload: expect.objectContaining({
        text: "Choose your language",
        reply_markup: languageKeyboard(await language.current()),
      }),
    });
  });

  it("discloses the active environment override before the language grid", async () => {
    const { bot, calls, language } = await buildBot({ ENDURAGENT_LANGUAGE: "it" });
    await language.set("fr");
    await bot.handleUpdate(message("/language"));
    expect(calls).toContainEqual({
      method: "sendMessage",
      payload: expect.objectContaining({
        text: "Language is set by ENDURAGENT_LANGUAGE to Italiano. Choices below are saved but stay inactive until the variable is removed.",
        reply_markup: languageKeyboard(await language.current()),
      }),
    });
  });

  it("saves a callback choice and edits the grid, then clears it with Automatic", async () => {
    const { bot, calls, language } = await buildBot();
    await bot.handleUpdate(callback("lang:it"));
    expect(await language.current()).toMatchObject({ value: "it", origin: "stored" });
    expect(calls).toContainEqual({
      method: "editMessageReplyMarkup",
      payload: expect.objectContaining({
        reply_markup: languageKeyboard(await language.current()),
      }),
    });
    expect(calls).toContainEqual({
      method: "answerCallbackQuery",
      payload: expect.objectContaining({ callback_query_id: "callback-1" }),
    });
    await bot.handleUpdate(callback("lang:auto", 77, 2));
    expect(await language.current()).toMatchObject({ value: null, origin: "stored" });
    expect(calls.at(-2)).toMatchObject({
      method: "editMessageReplyMarkup",
      payload: { reply_markup: languageKeyboard(await language.current()) },
    });
  });

  it("answers a repeated choice when Telegram reports unchanged markup", async () => {
    const { bot, language, calls } = await buildBot();
    await language.set("it");
    captured.unchangedMarkup = true;
    await expect(bot.handleUpdate(callback("lang:it"))).resolves.toBeUndefined();
    expect(await language.current()).toMatchObject({ value: "it", origin: "stored" });
    expect(calls).toContainEqual({
      method: "answerCallbackQuery",
      payload: expect.objectContaining({ callback_query_id: "callback-1" }),
    });
  });

  it("keeps the environment choice marked while persisting another preference", async () => {
    const { bot, calls, language } = await buildBot({ ENDURAGENT_LANGUAGE: "fr" });
    await bot.handleUpdate(callback("lang:it"));
    expect(await language.current()).toMatchObject({ value: "fr", origin: "environment" });
    expect(await createFileLanguagePreferenceStore({ dir: dataDir, env: {} }).read()).toMatchObject(
      { value: "it" },
    );
    expect(calls).toContainEqual({
      method: "editMessageReplyMarkup",
      payload: expect.objectContaining({
        reply_markup: languageKeyboard(await language.current()),
      }),
    });
    expect(calls).toContainEqual({
      method: "answerCallbackQuery",
      payload: expect.objectContaining({
        text: expect.stringMatching(/ENDURAGENT_LANGUAGE.*wins/),
      }),
    });
  });

  it("rejects an unauthorized language callback before preference or markup changes", async () => {
    const { bot, calls, language } = await buildBot();
    const set = vi.spyOn(language, "set");
    await bot.handleUpdate(callback("lang:it", 88));
    expect(set).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("answers invalid language data without changing preferences", async () => {
    const { bot, calls, language } = await buildBot();
    const set = vi.spyOn(language, "set");
    await bot.handleUpdate(callback("lang:invalid"));
    expect(set).not.toHaveBeenCalled();
    expect(calls.map(({ method }) => method)).toEqual(["answerCallbackQuery"]);
  });

  it.each(["y", "n"])("preserves cg:%s confirmation callbacks", async (choice) => {
    const { bot, runtime, calls, confirmations, language } = await buildBot();
    const set = vi.spyOn(language, "set");
    await bot.handleUpdate(callback(`cg:${choice}:test-nonce`));
    await runtime.drainPending();
    expect(choice === "y" ? confirmations.confirm : confirmations.cancel).toHaveBeenCalledWith({
      chatId: "telegram:77",
      nonce: "test-nonce",
    });
    expect(set).not.toHaveBeenCalled();
    expect(calls.map(({ method }) => method)).toEqual([
      "answerCallbackQuery",
      "editMessageReplyMarkup",
      "sendMessage",
    ]);
  });

  it("carries the saved language alongside the host turn context", async () => {
    const { bot, runtime, chat, language } = await buildBot(
      {},
      {
        resolveTurnContext: async () => ({
          resolvedCs: "test-anchor",
          referenceProvenance: "test-source",
        }),
        sync: async () => ({ text: "Synced" }),
      },
    );
    await language.set("it");
    await bot.handleUpdate(message("Tell me about training"));
    await runtime.drainPending();
    expect(chat).toHaveBeenCalledWith({
      chatId: "telegram:77",
      message: "Tell me about training",
      turn: {
        language: "it",
        languageSource: "preference",
        resolvedCs: "test-anchor",
        referenceProvenance: "test-source",
      },
    });
  });

  it("detects only the latest original fragment in a coalesced turn", async () => {
    const { bot, runtime, chat, language } = await buildBot({ LANG: "en_GB.UTF-8" });
    const resolve = vi.spyOn(language, "resolveFor");
    const first = "Please explain how I should prepare for my next training session. ".repeat(20);
    const last = "明日のトレーニングについて詳しく教えてください。";
    await bot.handleUpdate(message(first));
    await bot.handleUpdate(message(last, 2));
    await runtime.drainPending();
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ athleteText: last });
    expect(chat).toHaveBeenCalledWith({
      chatId: "telegram:77",
      message: `${first}\n${last}`,
      turn: { language: "ja", languageSource: "message" },
    });
  });

  it("applies the environment preference to chat turns", async () => {
    const { bot, runtime, chat, language } = await buildBot({
      ENDURAGENT_LANGUAGE: "fr",
      LANG: "en_GB.UTF-8",
    });
    await language.set("it");
    await bot.handleUpdate(message("明日のトレーニングについて詳しく教えてください。"));
    await runtime.drainPending();
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ turn: { language: "fr", languageSource: "preference" } }),
    );
  });
});
