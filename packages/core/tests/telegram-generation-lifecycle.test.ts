import { createNpmCoachLanguage } from "../src/language-preference.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthMiddleware } from "../src/channels/telegram-access.js";
import { defaultPairingState, saveAllowedSenders } from "../src/channels/allowed-senders.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import type { CreateTelegramChannelInput } from "../src/channels/telegram.js";

type Middleware = (ctx: unknown, next: () => Promise<void>) => Promise<void>;
type ApiCall = (
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;
type Transformer = (
  previous: ApiCall,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected asynchronous condition was not reached");
}

function createComposingBot(
  options: {
    rawApi?: ApiCall;
    start?: (callApi: ApiCall) => Promise<void>;
    stop?: (callApi: ApiCall) => Promise<void>;
    isRunning?: () => boolean;
  } = {},
) {
  const middleware: Middleware[] = [];
  const transformers: Transformer[] = [];
  const commands = new Map<string, (ctx: any) => Promise<void>>();
  const events = new Map<string, (ctx: any) => Promise<void>>();
  let errorHandler: ((error: { error: unknown; ctx: any }) => Promise<void>) | undefined;
  const rawApi = vi.fn<ApiCall>(options.rawApi ?? (async () => ({ ok: true, result: true })));
  const callApi: ApiCall = (method, payload, signal) => {
    const composed = transformers.reduce<ApiCall>(
      (previous, transformer) => (nextMethod, nextPayload, nextSignal) =>
        transformer(previous, nextMethod, nextPayload, nextSignal),
      rawApi,
    );
    return composed(method, payload, signal);
  };
  const bot = {
    api: {
      sendMessage: (chatId: string | number, text: string) =>
        callApi("sendMessage", { chat_id: chatId, text }),
      sendChatAction: (chatId: string | number, action: string) =>
        callApi("sendChatAction", { chat_id: chatId, action }),
      setMyCommands: (commands: unknown) => callApi("setMyCommands", { commands }),
      config: { use: (transformer: Transformer) => transformers.push(transformer) },
    },
    use: (handler: Middleware) => middleware.push(handler),
    callbackQuery: vi.fn(),
    command: vi.fn((name: string, handler: (ctx: any) => Promise<void>) => {
      commands.set(name, handler);
    }),
    on: vi.fn((name: string, handler: (ctx: any) => Promise<void>) => {
      events.set(name, handler);
    }),
    catch: vi.fn((handler: (error: { error: unknown; ctx: any }) => Promise<void>) => {
      errorHandler = handler;
    }),
    start: vi.fn(() => options.start?.(callApi) ?? Promise.resolve()),
    stop: vi.fn(() => options.stop?.(callApi) ?? Promise.resolve()),
    isRunning: vi.fn(() => options.isRunning?.() ?? true),
    dispatch: (ctx: any) => {
      const command = /^\/([^\s]+)/.exec(ctx.message?.text ?? "")?.[1];
      const terminal =
        command !== undefined && commands.has(command)
          ? () => commands.get(command)!(ctx)
          : typeof ctx.message?.text === "string" && events.has("message:text")
            ? () => events.get("message:text")!(ctx)
            : async () => undefined;
      const invoke = middleware.reduceRight<() => Promise<void>>(
        (next, handler) => () => handler(ctx, next),
        terminal,
      );
      return invoke().catch((error) =>
        errorHandler === undefined ? Promise.reject(error) : errorHandler({ error, ctx }),
      );
    },
    rawApi,
    transformers,
  };
  return bot;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-generation-"));
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
  vi.doUnmock("@grammyjs/auto-retry");
  vi.doUnmock("../src/logging/index.js");
});

describe("Telegram polling generation release", () => {
  it("waits for denied access work because the root lifetime surrounds the security gate", async () => {
    const challenge = deferred<void>();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const bot = createComposingBot();
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry:
        () =>
        (
          previous: ApiCall,
          method: string,
          payload: Record<string, unknown>,
          signal?: AbortSignal,
        ) =>
          previous(method, payload, signal),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const input = makeRuntimeInput();
    const runtime = createTelegramBot({
      ...input,
      host: {
        ...input.host,
        language: createNpmCoachLanguage(dataDir),
        access: {
          middleware: createAuthMiddleware({
            dataDir,
            binaryName: "cycling-coach",
            challengeRateLimit: new Map(),
            challengeMinIntervalMs: 60_000,
          }),
        },
      },
    });

    const handling = bot.dispatch({
      update: { update_id: 1 },
      chat: { id: 12345, type: "private" },
      from: { id: 12345, first_name: "Athlete" },
      message: { text: "hello" },
      reply: async () => {
        markStarted();
        await challenge.promise;
      },
    });
    await started;
    await runtime.stop();
    const snapshot = runtime.captureDrain();
    let drained = false;
    const draining = snapshot.wait().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    challenge.resolve();
    await Promise.all([handling, draining]);
    expect(drained).toBe(true);
  });

  it("waits for deferred pairing consumption that returns without calling downstream middleware", async () => {
    const pairing = deferred<boolean>();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const consumePairing = vi.fn(async () => {
      markStarted();
      return pairing.promise;
    });
    const bot = createComposingBot();
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const input = makeRuntimeInput();
    const runtime = createTelegramBot({
      ...input,
      host: {
        ...input.host,
        language: createNpmCoachLanguage(dataDir),
        access: {
          middleware: createAuthMiddleware({
            dataDir,
            binaryName: "cycling-coach",
            challengeRateLimit: new Map(),
            challengeMinIntervalMs: 60_000,
            consumePairing,
          }),
        },
      },
    });
    const handling = bot.dispatch({
      update: { update_id: 2 },
      chat: { id: 12345, type: "private" },
      from: { id: 12345, first_name: "Athlete" },
      message: { text: "PAIR-CODE" },
      reply: vi.fn(async () => undefined),
    });
    await started;

    await runtime.stop();
    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    pairing.resolve(true);
    await Promise.all([handling, draining]);
    expect(consumePairing).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });

  it("accounts for command registration and treats its rejection as settled drain work", async () => {
    const commands = deferred<unknown>();
    const bot = createComposingBot({
      rawApi: (method) =>
        method === "setMyCommands" ? commands.promise : Promise.resolve({ ok: true, result: true }),
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());

    await runtime.stop();
    let state: "pending" | "resolved" | "rejected" = "pending";
    const draining = runtime
      .captureDrain()
      .wait()
      .then(
        () => {
          state = "resolved";
        },
        () => {
          state = "rejected";
        },
      );
    await Promise.resolve();
    expect(state).toBe("pending");

    commands.resolve(Promise.reject(new Error("registration failed")));
    await draining;
    expect(state).toBe("resolved");
  });

  it("tracks each polling start through settlement and refuses direct sends after stop", async () => {
    const polling = deferred<void>();
    const bot = createComposingBot({ start: () => polling.promise });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());

    void runtime.start();
    await runtime.stop();
    const callsBeforeSend = bot.rawApi.mock.calls.length;
    await expect(runtime.sendMessage("12345", "late")).rejects.toMatchObject({
      code: "telegram-generation-sealed",
    });
    expect(bot.rawApi).toHaveBeenCalledTimes(callsBeforeSend);

    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);
    polling.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it("keeps a direct send admitted before stop in the sealed generation", async () => {
    const send = deferred<unknown>();
    const bot = createComposingBot({
      rawApi: (method) =>
        method === "sendMessage" ? send.promise : Promise.resolve({ ok: true, result: true }),
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());

    const sending = runtime.sendMessage("12345", "admitted");
    await runtime.stop();
    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    send.resolve({ ok: true });
    await Promise.all([sending, draining]);
    expect(drained).toBe(true);
  });

  it("waits for fragment typing and the heartbeat pulse already in flight at stop", async () => {
    const typing = deferred<unknown>();
    const bot = createComposingBot({
      rawApi: (method) =>
        method === "sendChatAction" ? typing.promise : Promise.resolve({ ok: true, result: true }),
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const input = makeRuntimeInput();
    const runtime = createTelegramBot({
      ...input,
      engine: {
        ...input.engine,
        hasSession: vi.fn(async () => ({ hasSession: true })),
        chat: vi.fn(async () => ({ text: "ready" })),
      } as never,
    });
    const ctx = {
      update: { update_id: 3 },
      chat: { id: 12345, type: "private" },
      from: { id: 12345, first_name: "Athlete" },
      message: { text: "How is my form?", message_id: 30 },
      reply: (text: string) => bot.api.sendMessage(12345, text),
      replyWithChatAction: (action: string) => bot.api.sendChatAction(12345, action),
    };

    await bot.dispatch(ctx);
    await runtime.stop();
    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await waitUntil(
      () => bot.rawApi.mock.calls.filter(([method]) => method === "sendChatAction").length === 2,
    );
    expect(drained).toBe(false);

    typing.resolve({ ok: true });
    await draining;
    expect(drained).toBe(true);
  });

  it("waits for the guarded bot.catch reply before releasing the generation", async () => {
    const reply = deferred<unknown>();
    const bot = createComposingBot({
      rawApi: (method) =>
        method === "sendMessage" ? reply.promise : Promise.resolve({ ok: true, result: true }),
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const input = makeRuntimeInput();
    const runtime = createTelegramBot({
      ...input,
      host: {
        ...input.host,
        language: createNpmCoachLanguage(dataDir),
        access: {
          middleware: async (_ctx: unknown, next: () => Promise<void>) => {
            await next();
            throw new Error("handler failed");
          },
        },
      },
    });
    const ctx = {
      update: { update_id: 4 },
      chat: { id: 12345, type: "private" },
      from: { id: 12345, first_name: "Athlete" },
      reply: (text: string) => bot.api.sendMessage(12345, text),
    };
    const handling = bot.dispatch(ctx);
    await waitUntil(
      () => bot.rawApi.mock.calls.filter(([method]) => method === "sendMessage").length === 1,
    );

    await runtime.stop();
    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    reply.resolve({ ok: true });
    await Promise.all([handling, draining]);
    expect(drained).toBe(true);
  });

  it("requires final-offset acknowledgement and poll-loop settlement before release", async () => {
    const finalOffset = deferred<unknown>();
    const pollingAbort = new AbortController();
    const bot = createComposingBot({
      rawApi: (method, payload) => {
        if (method !== "getUpdates") return Promise.resolve({ ok: true, result: true });
        if (payload.timeout === 0) return finalOffset.promise;
        return new Promise((_resolve, reject) => {
          pollingAbort.signal.addEventListener("abort", () => reject(new Error("poll aborted")), {
            once: true,
          });
        });
      },
      start: (callApi) =>
        callApi("getUpdates", { timeout: 30 }, pollingAbort.signal).then(() => undefined),
      stop: (callApi) => {
        pollingAbort.abort();
        return callApi("getUpdates", { offset: 8, timeout: 0 }).then(() => undefined);
      },
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry:
        () =>
        (
          previous: ApiCall,
          method: string,
          payload: Record<string, unknown>,
          signal?: AbortSignal,
        ) =>
          previous(method, payload, signal),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());
    const startSettled = runtime.start().catch(() => undefined);
    const stopping = runtime.stop();
    await waitUntil(
      () =>
        bot.rawApi.mock.calls.filter(
          ([method, payload]) => method === "getUpdates" && payload.timeout === 0,
        ).length === 1,
    );
    expect(pollingAbort.signal.aborted).toBe(true);
    expect(() => runtime.captureDrain()).toThrow(/must stop before/);

    finalOffset.resolve({ ok: true, result: [] });
    await stopping;
    await Promise.all([startSettled, runtime.captureDrain().wait()]);
  });

  it("drains a sealed generation when final-offset confirmation fails after polling stops", async () => {
    const offline = new Error("offline");
    const polling = deferred<void>();
    let running = false;
    const bot = createComposingBot({
      rawApi: (method, payload) =>
        method === "getUpdates" && payload.timeout === 0
          ? Promise.reject(offline)
          : Promise.resolve({ ok: true, result: true }),
      start: async () => {
        running = true;
        await polling.promise;
      },
      stop: (callApi) => {
        running = false;
        return callApi("getUpdates", { offset: 8, timeout: 0 }).then(() => undefined);
      },
      isRunning: () => running,
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());

    const pollingSettled = runtime.start();
    await expect(runtime.stop()).resolves.toBeUndefined();
    await expect(runtime.sendMessage("12345", "late")).rejects.toMatchObject({
      code: "telegram-generation-sealed",
    });
    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    polling.resolve();
    await Promise.all([pollingSettled, draining]);
    expect(drained).toBe(true);
    expect(bot.isRunning).toHaveBeenCalledOnce();
  });

  it("keeps final-offset failure fatal while polling remains running", async () => {
    const stopFailure = new Error("stop failed");
    const bot = createComposingBot({
      rawApi: (method, payload) =>
        method === "getUpdates" && payload.timeout === 0
          ? Promise.reject(stopFailure)
          : Promise.resolve({ ok: true, result: true }),
      stop: (callApi) => callApi("getUpdates", { offset: 8, timeout: 0 }).then(() => undefined),
      isRunning: () => true,
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());

    await expect(runtime.stop()).rejects.toBe(stopFailure);
    expect(bot.isRunning).toHaveBeenCalledOnce();
    expect(() => runtime.captureDrain()).toThrow(/must stop before/);
  });

  it("tracks a retry-wrapped 429 request through its final API attempt", async () => {
    const retry = deferred<void>();
    const finalAttempt = deferred<unknown>();
    let attempts = 0;
    const bot = createComposingBot({
      rawApi: (method) => {
        if (method !== "sendMessage") return Promise.resolve({ ok: true, result: true });
        attempts += 1;
        return attempts === 1 ? Promise.reject({ error_code: 429 }) : finalAttempt.promise;
      },
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry:
        () => async (previous: ApiCall, method: string, payload: Record<string, unknown>) => {
          try {
            return await previous(method, payload);
          } catch (error) {
            if ((error as { error_code?: number }).error_code !== 429) throw error;
            await retry.promise;
            return previous(method, payload);
          }
        },
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());
    const request = bot.api.sendMessage(12345, "retry me");
    await waitUntil(() => attempts === 1);
    await runtime.stop();
    let drained = false;
    const draining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    retry.resolve();
    await waitUntil(() => attempts === 2);
    expect(drained).toBe(false);
    finalAttempt.resolve({ ok: true });
    await Promise.all([request, draining]);
    expect(drained).toBe(true);
  });

  it("stop, drain, start, and stop again do not leak work across generation snapshots", async () => {
    const secondGenerationSend = deferred<unknown>();
    const bot = createComposingBot({
      rawApi: (method, payload) =>
        method === "sendMessage" && payload.text === "second"
          ? secondGenerationSend.promise
          : Promise.resolve({ ok: true, result: true }),
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const runtime = createTelegramBot(makeRuntimeInput());

    await runtime.start();
    await runtime.stop();
    const firstSnapshot = runtime.captureDrain();
    await firstSnapshot.wait();

    await runtime.start();
    const sending = runtime.sendMessage(12345, "second");
    await runtime.stop();
    await firstSnapshot.wait();
    let secondDrained = false;
    const secondDraining = runtime
      .captureDrain()
      .wait()
      .then(() => {
        secondDrained = true;
      });
    await Promise.resolve();
    expect(secondDrained).toBe(false);

    secondGenerationSend.resolve({ ok: true });
    await Promise.all([sending, secondDraining]);
    await runtime.start();
    await runtime.stop();
    await runtime.captureDrain().wait();
  });

  it("detaches /update without letting a timeout bypass generation release", async () => {
    vi.useFakeTimers();
    const install = vi.fn(async () => undefined);
    const generationWork = deferred<unknown>();
    const bot = createComposingBot({
      rawApi: (method, payload) =>
        method === "sendMessage" && payload.text === "held generation work"
          ? generationWork.promise
          : Promise.resolve({ ok: true, result: true }),
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const input = makeRuntimeInput();
    const runtime = createTelegramBot({
      ...input,
      host: {
        ...input.host,
        language: createNpmCoachLanguage(dataDir),
        release: {
          updatePolicy: "npm-self-update",
          updateDescription: "Update",
          whatsNewUnavailableText: "Unavailable",
          version: vi.fn(async () => "test"),
          whatsNew: vi.fn(async () => ({ kind: "unavailable" as const })),
          binaryName: "cycling-coach",
          check: vi.fn(async () => ({
            current: "2026.5.5",
            latest: "2026.5.10",
            updateAvailable: true,
          })),
          install,
        },
      },
    });
    const ctx = {
      update: { update_id: 7 },
      chat: { id: 12345 },
      from: { id: 12345 },
      message: { text: "/update" },
      reply: vi.fn(async () => undefined),
    };

    const sending = runtime.sendMessage(12345, "held generation work");
    await waitUntil(
      () =>
        bot.rawApi.mock.calls.filter(
          ([method, payload]) =>
            method === "sendMessage" && payload.text === "held generation work",
        ).length === 1,
    );
    await expect(bot.dispatch(ctx)).resolves.toBeUndefined();
    await waitUntil(() => bot.stop.mock.calls.length === 1);
    expect(bot.stop).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(install).not.toHaveBeenCalled();

    generationWork.resolve({ ok: true });
    await sending;
    await waitUntil(() => install.mock.calls.length === 1);
    expect(install).toHaveBeenCalledWith("2026.5.10");
    await runtime.drainPending();
  });

  it("closes a detached /update stop failure without installing or leaking its error", async () => {
    const logError = vi.fn();
    vi.doMock("../src/logging/index.js", async () => {
      const real =
        await vi.importActual<typeof import("../src/logging/index.js")>("../src/logging/index.js");
      return {
        ...real,
        createSubsystemLogger: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: logError,
        }),
      };
    });
    const install = vi.fn(async () => undefined);
    const bot = createComposingBot({
      stop: async () => {
        throw new Error("private stop failure");
      },
    });
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const input = makeRuntimeInput();
    createTelegramBot({
      ...input,
      host: {
        ...input.host,
        language: createNpmCoachLanguage(dataDir),
        release: {
          updatePolicy: "npm-self-update",
          updateDescription: "Update",
          whatsNewUnavailableText: "Unavailable",
          version: vi.fn(async () => "test"),
          whatsNew: vi.fn(async () => ({ kind: "unavailable" as const })),
          binaryName: "cycling-coach",
          check: vi.fn(async () => ({
            current: "2026.5.5",
            latest: "2026.5.10",
            updateAvailable: true,
          })),
          install,
        },
      },
    });
    const ctx = {
      update: { update_id: 8 },
      chat: { id: 12345 },
      from: { id: 12345 },
      message: { text: "/update" },
      reply: vi.fn(async () => undefined),
    };

    await expect(bot.dispatch(ctx)).resolves.toBeUndefined();
    await waitUntil(() => logError.mock.calls.length === 1);

    expect(bot.stop).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("self_update_failed", undefined, {
      chatId: "telegram:12345",
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain("private stop failure");
  });

  it("does not send or record a notification that begins after generation sealing", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const setLastNotifiedVersion = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdateWithDailyTelemetry: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        getKnownTelegramChatIds: vi.fn(() => ["12345"]),
        getLastNotifiedVersion: vi.fn(() => null),
        setLastNotifiedVersion,
      };
    });
    const bot = createComposingBot();
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
      InputFile: class {},
    }));
    vi.doMock("@grammyjs/auto-retry", () => ({
      autoRetry: () => (previous: ApiCall, method: string, payload: Record<string, unknown>) =>
        previous(method, payload),
    }));
    const [{ createTelegramBot }, { notifyNpmTelegramUpdate }] = await Promise.all([
      import("../src/channels/telegram.js"),
      import("../src/channels/npm-telegram-host.js"),
    ]);
    const runtime = createTelegramBot(makeRuntimeInput());
    await runtime.stop();
    const apiCallsBeforeNotification = bot.rawApi.mock.calls.length;

    await notifyNpmTelegramUpdate(runtime, dataDir, cyclingBinary);

    expect(bot.rawApi).toHaveBeenCalledTimes(apiCallsBeforeNotification);
    expect(setLastNotifiedVersion).not.toHaveBeenCalled();
  });
});

function makeRuntimeInput(): CreateTelegramChannelInput {
  return {
    token: "synthetic-token",
    webhookPolicy: "preserve" as const,
    dataDir,
    engine: {
      chat: vi.fn(),
      getCoachDecision: vi.fn(async () => ({ decision: null })),
      answerCoachDecision: vi.fn(),
      skipCoachDecision: vi.fn(),
      resumeCoachDecision: vi.fn(),
      hasSession: vi.fn(),
      resetSession: vi.fn(),
      getAthleteState: vi.fn(),
    },
    host: {
      language: createNpmCoachLanguage(dataDir),
      access: { middleware: async (_ctx: unknown, next: () => Promise<void>) => next() },
      confirmations: {
        peek: vi.fn(async () => undefined),
        confirm: vi.fn(),
        cancel: vi.fn(),
      },
      authorization: { isPrimaryOperator: vi.fn(async () => false) },
      release: {
        updatePolicy: "desktop-owned" as const,
        updateDescription: "Check in Desktop",
        whatsNewUnavailableText: "Unavailable",
        version: vi.fn(async () => "test"),
        whatsNew: vi.fn(async () => ({ kind: "unavailable" as const })),
        updateNotice: vi.fn(async () => "Update in Desktop"),
      },
    },
  };
}
