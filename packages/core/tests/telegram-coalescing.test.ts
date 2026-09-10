import { createNpmCoachLanguage } from "../src/language-preference.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_COALESCE_MS } from "../src/channels/telegram.js";
import type {
  TelegramInvocationCapabilities,
  TelegramInvocationReservation,
  TelegramOperationsCapabilities,
} from "../src/channels/telegram-host.js";

const grammyFake = vi.hoisted(() => ({
  bot: undefined as ((token: string) => unknown) | undefined,
  InputFile: class FakeInputFile {
    constructor(
      readonly data: Buffer,
      readonly filename: string,
    ) {}
  },
  GrammyError: class FakeGrammyError extends Error {},
}));
vi.mock("grammy", () => ({
  Bot: function FakeBot(this: unknown, token: string) {
    if (grammyFake.bot === undefined) throw new Error("Test bug: no fake bot queued");
    return grammyFake.bot(token);
  },
  InputFile: grammyFake.InputFile,
  GrammyError: grammyFake.GrammyError,
}));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-coalesce-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

interface StubEngine {
  chat: ReturnType<typeof vi.fn>;
  hasSession: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
  getAthleteState: ReturnType<typeof vi.fn>;
}

interface BuildBotResult {
  bot: FakeBot;
  engine: StubEngine;
  drainPending: () => Promise<void>;
}

async function buildBot(
  overrides: Partial<StubEngine> = {},
  operations?: TelegramOperationsCapabilities,
  invocations?: TelegramInvocationCapabilities,
): Promise<BuildBotResult> {
  const bot: FakeBot = {
    api: {
      sendMessage: vi.fn(async () => undefined),
      setMyCommands: vi.fn(async () => true),
      config: { use: vi.fn() },
    },
    use: vi.fn(),
    callbackQuery: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    stop: vi.fn(async () => undefined),
    catch: vi.fn(),
  };
  grammyFake.bot = () => bot;

  const engine: StubEngine = {
    chat: vi.fn(async () => ({ text: "ok" })),
    hasSession: vi.fn(async () => ({ hasSession: true })),
    resetSession: vi.fn(async () => ({ memoryFlushed: true })),
    getAthleteState: vi.fn(),
    ...overrides,
  };
  const host = {
    language: createNpmCoachLanguage(dataDir),
    access: { middleware: async (_ctx: unknown, next: () => Promise<void>) => next() },
    confirmations: {
      peek: vi.fn(async () => undefined),
      confirm: vi.fn(),
      cancel: vi.fn(),
    },
    authorization: { isPrimaryOperator: vi.fn(async () => false) },
    ...(operations === undefined ? {} : { operations }),
    ...(invocations === undefined ? {} : { invocations }),
    release: {
      updatePolicy: "desktop-owned" as const,
      updateDescription: "Check for updates",
      whatsNewUnavailableText: "Couldn't fetch release notes. Try again later.",
      version: vi.fn(async () => "Cycling Coach v0.0.0"),
      whatsNew: vi.fn(async () => ({ kind: "unavailable" as const })),
      updateNotice: vi.fn(async () => "Update from Desktop."),
    },
  };

  vi.resetModules();

  const { createTelegramBot } = await import("../src/channels/telegram.js");
  const { drainPending } = createTelegramBot({
    webhookPolicy: "delete-before-polling",
    token: "FAKE_TOKEN",
    engine: engine as unknown as Parameters<typeof createTelegramBot>[0]["engine"],
    host,
    dataDir,
  });

  return { bot, engine, drainPending };
}

function getMessageText(bot: FakeBot) {
  const call = bot.on.mock.calls.find((c: unknown[]) => c[0] === "message:text");
  if (!call) throw new Error("message:text handler not registered");
  return call[1] as (ctx: unknown) => Promise<void>;
}

function getCommand(bot: FakeBot, name: string) {
  const call = bot.command.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`${name} command handler not registered`);
  return call[1] as (ctx: unknown) => Promise<void>;
}

function getFlushMiddleware(bot: FakeBot) {
  const call = bot.use.mock.calls[2];
  if (!call) throw new Error("flush middleware not registered");
  return call[0] as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

function getAuthMiddleware(bot: FakeBot) {
  const call = bot.use.mock.calls[1];
  if (!call) throw new Error("auth middleware not registered");
  return call[0] as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

function getHandlerTrackingMiddleware(bot: FakeBot) {
  const call = bot.use.mock.calls[0];
  if (!call) throw new Error("handler-tracking middleware not registered");
  return call[0] as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

interface FakeCtx {
  chat: { id: number };
  match: string;
  message: { text: string; message_id?: number };
  reply: ReturnType<typeof vi.fn>;
  replyWithDocument: ReturnType<typeof vi.fn>;
  replyWithChatAction: ReturnType<typeof vi.fn>;
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

describe("inbound coalescing (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("three fragments within the window produce ONE engine.chat call with newline-joined text, threaded to the last fragment", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const handler = getMessageText(bot);
    const ctxA = makeCtx({ message: { text: "one", message_id: 11 } });
    const ctxB = makeCtx({ message: { text: "two", message_id: 12 } });
    const ctxC = makeCtx({ message: { text: "three", message_id: 13 } });

    await handler(ctxA);
    await handler(ctxB);
    await handler(ctxC);
    expect(engine.chat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();

    expect(engine.chat).toHaveBeenCalledTimes(1);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "one\ntwo\nthree",
      }),
      expect.any(Function),
    );

    // The flushed answer threads to the LAST fragment's message id, on the
    // last fragment's reply context.
    const htmlCall = ctxC.reply.mock.calls.find(
      (c: unknown[]) => (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
    );
    expect(htmlCall).toBeDefined();
    expect(
      (htmlCall![1] as { reply_parameters?: { message_id?: number } }).reply_parameters,
    ).toEqual({ message_id: 13, allow_sending_without_reply: true });
  });

  it("each fragment resets the timer: nothing fires until the window elapses after the LAST fragment", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "a" } }));
    await vi.advanceTimersByTimeAsync(1_000);
    await handler(makeCtx({ message: { text: "b" } }));
    await vi.advanceTimersByTimeAsync(1_000);
    await handler(makeCtx({ message: { text: "c" } }));

    // 100ms short of the window after the last fragment: still buffered.
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS - 100);
    expect(engine.chat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await drainPending();
    expect(engine.chat).toHaveBeenCalledTimes(1);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "telegram:777", message: "a\nb\nc" }),
      expect.any(Function),
    );
  });

  it("different chats are isolated: concurrent fragments never cross-join", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ chat: { id: 1 }, message: { text: "left" } }));
    await handler(makeCtx({ chat: { id: 2 }, message: { text: "right" } }));
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();

    expect(engine.chat).toHaveBeenCalledTimes(2);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "telegram:1", message: "left" }),
      expect.any(Function),
    );
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "telegram:2", message: "right" }),
      expect.any(Function),
    );
  });

  it("preserves first-message order while asynchronous session lookup is pending", async () => {
    let resolveSession!: (value: { hasSession: boolean }) => void;
    const session = new Promise<{ hasSession: boolean }>((resolve) => {
      resolveSession = resolve;
    });
    const hasSession = vi.fn(() => session);
    const { bot, engine, drainPending } = await buildBot({ hasSession });
    const handler = getMessageText(bot);

    const first = handler(makeCtx({ message: { text: "first", message_id: 41 } }));
    const second = handler(makeCtx({ message: { text: "second", message_id: 42 } }));

    await vi.waitFor(() => expect(hasSession).toHaveBeenCalledOnce());
    expect(hasSession).toHaveBeenCalledWith({ chatId: "telegram:777" });
    resolveSession({ hasSession: true });
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();

    expect(engine.chat).toHaveBeenCalledOnce();
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "first\nsecond",
      }),
      expect.any(Function),
    );
  });

  it("a slash update mid-buffer flushes the pending text BEFORE the command handler runs", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "pending thought" } }));
    expect(engine.chat).not.toHaveBeenCalled();

    const next = vi.fn(async () => undefined);
    await getFlushMiddleware(bot)(makeCtx({ message: { text: "/status" } }), next);

    expect(next).toHaveBeenCalledTimes(1);
    await drainPending();
    expect(engine.chat).toHaveBeenCalledTimes(1);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "pending thought",
      }),
      expect.any(Function),
    );

    // The flush cleared the debounce timer: the window elapsing later must not
    // double-dispatch the same buffered text.
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS * 2);
    expect(engine.chat).toHaveBeenCalledTimes(1);
  });

  it("preserves buffered-before-command order when turn contexts resolve out of order", async () => {
    let resolveBufferedContext!: (value: undefined) => void;
    const bufferedContext = new Promise<undefined>((resolve) => {
      resolveBufferedContext = resolve;
    });
    const resolveTurnContext = vi
      .fn<TelegramOperationsCapabilities["resolveTurnContext"]>()
      .mockReturnValueOnce(bufferedContext)
      .mockResolvedValueOnce(undefined);
    const { bot, engine, drainPending } = await buildBot(
      {},
      {
        resolveTurnContext,
        sync: vi.fn(async () => ({ text: "synced" })),
      },
    );
    const bufferedCtx = makeCtx({ message: { text: "pending thought", message_id: 21 } });
    const commandCtx = makeCtx({ message: { text: "/status", message_id: 22 } });

    await getMessageText(bot)(bufferedCtx);
    await getFlushMiddleware(bot)(commandCtx, () => getCommand(bot, "status")(commandCtx));
    await Promise.resolve();

    expect(resolveTurnContext).toHaveBeenCalledTimes(1);
    resolveBufferedContext(undefined);
    await drainPending();

    expect(resolveTurnContext).toHaveBeenCalledTimes(2);
    expect(engine.chat.mock.calls).toMatchObject([
      [{ chatId: "telegram:777", message: "pending thought" }, expect.any(Function)],
      [{ chatId: "telegram:777", message: "/status" }, expect.any(Function)],
    ]);
  });

  it("starts a buffered chat before a following /start reset when turn context is delayed", async () => {
    let resolveBufferedContext!: (value: undefined) => void;
    const bufferedContext = new Promise<undefined>((resolve) => {
      resolveBufferedContext = resolve;
    });
    const resolveTurnContext = vi
      .fn<TelegramOperationsCapabilities["resolveTurnContext"]>()
      .mockReturnValueOnce(bufferedContext);
    const { bot, engine, drainPending } = await buildBot(
      {},
      {
        resolveTurnContext,
        sync: vi.fn(async () => ({ text: "synced" })),
      },
    );
    const bufferedCtx = makeCtx({ message: { text: "pending thought", message_id: 31 } });
    const startCtx = makeCtx({ message: { text: "/start", message_id: 32 } });

    await getMessageText(bot)(bufferedCtx);
    const handlingStart = getFlushMiddleware(bot)(startCtx, () =>
      getCommand(bot, "start")(startCtx),
    );
    await Promise.resolve();

    expect(resolveTurnContext).toHaveBeenCalledOnce();
    expect(engine.chat).not.toHaveBeenCalled();
    expect(engine.resetSession).not.toHaveBeenCalled();

    resolveBufferedContext(undefined);
    await handlingStart;
    await drainPending();

    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "pending thought",
      }),
      expect.any(Function),
    );
    expect(engine.resetSession).toHaveBeenCalledWith({ chatId: "telegram:777" });
    expect(engine.chat.mock.invocationCallOrder[0]).toBeLessThan(
      engine.resetSession.mock.invocationCallOrder[0],
    );
  });

  it("registration order: auth → handler tracking → flush → update guard → commands", async () => {
    const { bot, drainPending } = await buildBot();
    expect(bot.use).toHaveBeenCalledTimes(4);
    const authOrder = bot.use.mock.invocationCallOrder[0];
    const trackingOrder = bot.use.mock.invocationCallOrder[1];
    const flushOrder = bot.use.mock.invocationCallOrder[2];
    const guardOrder = bot.use.mock.invocationCallOrder[3];
    expect(authOrder).toBeLessThan(trackingOrder);
    expect(trackingOrder).toBeLessThan(flushOrder);
    expect(flushOrder).toBeLessThan(guardOrder);
    expect(bot.command.mock.invocationCallOrder.length).toBeGreaterThan(0);
    for (const commandOrder of bot.command.mock.invocationCallOrder) {
      expect(guardOrder).toBeLessThan(commandOrder);
    }
    await drainPending();
  });

  it("drainPending flushes buffered text immediately — no debounce-timer wait", async () => {
    const { bot, engine, drainPending } = await buildBot();
    await getMessageText(bot)(makeCtx({ message: { text: "about to shut down" } }));
    expect(engine.chat).not.toHaveBeenCalled();

    // No timer advance: the drain itself must flush, then await the turn.
    await drainPending();
    expect(engine.chat).toHaveBeenCalledTimes(1);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "about to shut down",
      }),
      expect.any(Function),
    );
  });

  it("keeps the first fragment's admission reservation through a shutdown drain", async () => {
    let admissionOpen = true;
    const run = vi.fn(<T>(operation: () => Promise<T>) => operation());
    const cancel = vi.fn();
    const reservation: TelegramInvocationReservation = {
      run<T>(operation: () => Promise<T>): Promise<T> {
        return run(operation) as Promise<T>;
      },
      cancel,
    };
    const reserve = vi.fn((_chatId: string) => {
      if (!admissionOpen) throw new Error("admission closed");
      return reservation;
    });
    const { bot, engine, drainPending } = await buildBot({}, undefined, { reserve });
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "accepted before shutdown" } }));
    await handler(makeCtx({ message: { text: "and still accepted" } }));
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith("telegram:777");
    expect(run).not.toHaveBeenCalled();

    admissionOpen = false;
    await drainPending();

    expect(run).toHaveBeenCalledOnce();
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "accepted before shutdown\nand still accepted",
      }),
      expect.any(Function),
    );
    expect(cancel).not.toHaveBeenCalled();

    await expect(
      handler(makeCtx({ chat: { id: 778 }, message: { text: "too late" } })),
    ).rejects.toThrow("admission closed");
    expect(engine.chat).toHaveBeenCalledTimes(1);
  });

  it("runs first-message session lookup inside the admission reservation", async () => {
    const run = vi.fn(<T>(operation: () => Promise<T>) => operation());
    const cancel = vi.fn();
    const reservation: TelegramInvocationReservation = {
      run<T>(operation: () => Promise<T>): Promise<T> {
        return run(operation) as Promise<T>;
      },
      cancel,
    };
    const reserve = vi.fn(() => reservation);
    const hasSession = vi.fn(async () => {
      throw new Error("session lookup failed");
    });
    const { bot, engine, drainPending } = await buildBot({ hasSession }, undefined, { reserve });
    const ctx = makeCtx();

    await getMessageText(bot)(ctx);
    expect(hasSession).not.toHaveBeenCalled();
    await drainPending();

    expect(reserve).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hasSession).toHaveBeenCalledOnce());
    expect(engine.chat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "Sorry, something went wrong. Please try again.",
      undefined,
    );
  });

  it("each fragment fires one best-effort typing action during the window; the flushed turn still heartbeats", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const handler = getMessageText(bot);
    const ctxA = makeCtx({ message: { text: "one" } });
    const ctxB = makeCtx({ message: { text: "two" } });
    const ctxC = makeCtx({ message: { text: "three" } });

    await handler(ctxA);
    await handler(ctxB);
    await handler(ctxC);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctxA.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctxB.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctxC.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctxA.replyWithChatAction).toHaveBeenCalledTimes(1);
    expect(ctxB.replyWithChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();
    expect(engine.chat).toHaveBeenCalledTimes(1);
    // The heartbeat runs on the LAST fragment's rebound context.
    expect(ctxC.replyWithChatAction.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a typing-action failure never breaks the handler or the buffered turn", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const ctx = makeCtx({ message: { text: "hello" } });
    ctx.replyWithChatAction.mockRejectedValue(new Error("chat action down"));

    await expect(getMessageText(bot)(ctx)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "telegram:777", message: "hello" }),
      expect.any(Function),
    );
  });

  it("leading-slash message:text (unregistered command fallthrough) is never buffered", async () => {
    const { bot, engine, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "a buffered thought" } }));
    await handler(makeCtx({ message: { text: "/unknowncmd" } }));
    await vi.advanceTimersByTimeAsync(0);

    // The slash turn dispatched immediately — no window wait, no coalescing
    // with the pending free-form fragment.
    expect(engine.chat).toHaveBeenCalledTimes(1);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "/unknowncmd",
      }),
      expect.any(Function),
    );

    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();
    expect(engine.chat).toHaveBeenCalledTimes(2);
    expect(engine.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "telegram:777",
        message: "a buffered thought",
      }),
      expect.any(Function),
    );
  });
});

describe("inbound coalescing (timer plumbing)", () => {
  it("debounce timers are unref'd; a reset clears exactly the previous timer", async () => {
    const { bot, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    const unrefA = vi.fn();
    const unrefB = vi.fn();
    const timers = [{ unref: unrefA }, { unref: unrefB }];
    const setTimeoutSpy = vi.fn(() => timers[setTimeoutSpy.mock.calls.length - 1]);
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);
    try {
      await handler(makeCtx({ message: { text: "first" } }));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(unrefA).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      await handler(makeCtx({ message: { text: "second" } }));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(unrefB).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timers[0]);
    } finally {
      vi.unstubAllGlobals();
      await drainPending();
    }
  });
});

describe("in-handler drain tracking", () => {
  it("drainPending waits for an authorized in-handler asynchronous task", async () => {
    vi.stubEnv("CYCLING_COACH_OPERATOR_ID", "777");
    const { bot, drainPending } = await buildBot();
    const auth = getAuthMiddleware(bot);
    const trackHandler = getHandlerTrackingMiddleware(bot);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finish!: () => void;
    const unfinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = vi.fn(async () => {
      markStarted();
      await unfinished;
    });
    const ctx = {
      chat: { id: 777, type: "private" },
      from: { id: 777, first_name: "Athlete" },
      reply: vi.fn(async () => undefined),
    };

    const handling = trackHandler(ctx, () => auth(ctx, task));
    await started;
    let drained = false;
    const draining = drainPending().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(task).toHaveBeenCalledOnce();
    expect(drained).toBe(false);

    finish();
    await Promise.all([handling, draining]);
    expect(drained).toBe(true);
  });

  it("drainPending flushes text buffered by an active authorized handler after draining starts", async () => {
    vi.stubEnv("CYCLING_COACH_OPERATOR_ID", "777");
    const { bot, engine, drainPending } = await buildBot();
    const auth = getAuthMiddleware(bot);
    const trackHandler = getHandlerTrackingMiddleware(bot);
    const messageHandler = getMessageText(bot);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let allowBuffering!: () => void;
    const mayBuffer = new Promise<void>((resolve) => {
      allowBuffering = resolve;
    });
    const ctx = {
      ...makeCtx({ message: { text: "arrived during drain", message_id: 31 } }),
      chat: { id: 777, type: "private" },
      from: { id: 777, first_name: "Athlete" },
    };
    const task = vi.fn(async () => {
      markStarted();
      await mayBuffer;
      await messageHandler(ctx);
    });

    const handling = trackHandler(ctx, () => auth(ctx, task));
    await started;
    const draining = drainPending();
    allowBuffering();
    await Promise.all([handling, draining]);

    try {
      expect(engine.chat).toHaveBeenCalledOnce();
      expect(engine.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "telegram:777",
          message: "arrived during drain",
        }),
        expect.any(Function),
      );
    } finally {
      await drainPending();
    }
  });

  it("drainPending ignores a tracked rejection and waits for other tracked work", async () => {
    const { bot, drainPending } = await buildBot();
    const trackHandler = getHandlerTrackingMiddleware(bot);
    let rejectHandler!: (reason: Error) => void;
    const rejection = new Promise<void>((_resolve, reject) => {
      rejectHandler = reject;
    });
    let markOtherStarted!: () => void;
    const otherStarted = new Promise<void>((resolve) => {
      markOtherStarted = resolve;
    });
    let finishOther!: () => void;
    const otherMayFinish = new Promise<void>((resolve) => {
      finishOther = resolve;
    });
    const failingHandling = trackHandler({}, () => rejection);
    const observedFailure = failingHandling.catch(() => undefined);
    const otherHandling = trackHandler({}, async () => {
      markOtherStarted();
      await otherMayFinish;
    });
    await otherStarted;
    let drainState: "pending" | "resolved" | "rejected" = "pending";
    const draining = drainPending().then(
      () => {
        drainState = "resolved";
      },
      () => {
        drainState = "rejected";
      },
    );

    rejectHandler(new Error("tracked handler failed"));
    await observedFailure;
    await Promise.resolve();

    try {
      expect(drainState).toBe("pending");
    } finally {
      finishOther();
      await Promise.allSettled([otherHandling, draining]);
    }
    expect(drainState).toBe("resolved");
  });
});
