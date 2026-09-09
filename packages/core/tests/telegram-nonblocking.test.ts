import { createNpmCoachLanguage } from "../src/language-preference.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-nonblock-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
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
}

interface StubReference {
  runSync: ReturnType<typeof vi.fn>;
  loadLatest: ReturnType<typeof vi.fn>;
}

interface BuildBotResult {
  bot: FakeBot;
  agent: StubAgent;
  drainPending: () => Promise<void>;
  chatCoalesceMs: number;
}

async function buildBot(opts?: { reference?: StubReference }): Promise<BuildBotResult> {
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
  vi.doMock("grammy", () => ({
    Bot: function FakeBot() {
      return bot;
    },
    InputFile: class {},
  }));

  const agent: StubAgent = {
    chat: vi.fn(),
    hasSession: vi.fn(),
    resetSession: vi.fn(),
    getAthleteState: vi.fn(),
  };

  const [{ createTelegramBot, CHAT_COALESCE_MS }, { createNpmTelegramHost }] = await Promise.all([
    import("../src/channels/telegram.js"),
    import("../src/channels/npm-telegram-host.js"),
  ]);
  const host = createNpmTelegramHost({
    language: createNpmCoachLanguage(dataDir),
    binary: cyclingBinary,
    confirmations: {
      peek: vi.fn(),
      confirm: vi.fn(),
      cancel: vi.fn(),
    },
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

  return { bot, agent, drainPending, chatCoalesceMs: CHAT_COALESCE_MS };
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

interface FakeCtx {
  chat: { id: number };
  match: string;
  message: { text: string };
  reply: ReturnType<typeof vi.fn>;
  replyWithDocument: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides?: Partial<FakeCtx>): FakeCtx {
  return {
    chat: { id: 777 },
    match: "",
    message: { text: "hi" },
    reply: vi.fn(async () => undefined),
    replyWithDocument: vi.fn(async () => undefined),
    ...overrides,
  };
}

function replyTexts(ctx: FakeCtx): string[] {
  return ctx.reply.mock.calls.map((c: unknown[]) => String(c[0]));
}

function someReply(ctx: FakeCtx, needle: string): boolean {
  return replyTexts(ctx).some((t) => t.includes(needle));
}

function htmlReply(ctx: FakeCtx, needle: string): boolean {
  return ctx.reply.mock.calls.some(
    (c: unknown[]) =>
      String(c[0]).includes(needle) &&
      (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
  );
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

describe("non-blocking dispatch", () => {
  it("a turn handler returns before agent.chat resolves", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const g = gate();
    agent.chat.mockImplementation(async () => {
      await g.promise;
      return { text: "the plan" };
    });
    const ctx = makeCtx();

    await getCommand(bot, "plan")(ctx);

    expect(someReply(ctx, "Analyzing your data")).toBe(true);
    expect(htmlReply(ctx, "the plan")).toBe(false);

    g.release();
    await drainPending();

    expect(htmlReply(ctx, "the plan")).toBe(true);
  });

  it("/version answers while a long turn is in flight", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const g = gate();
    agent.chat.mockImplementation(async () => {
      await g.promise;
      return { text: "done" };
    });

    const longCtx = makeCtx({ chat: { id: 100 }, message: { text: "build me a plan" } });
    agent.hasSession.mockResolvedValue({ hasSession: true });
    await getMessageText(bot)(longCtx);

    const versionCtx = makeCtx({ chat: { id: 200 } });
    await getCommand(bot, "version")(versionCtx);

    expect(someReply(versionCtx, "Cycling Coach")).toBe(true);

    g.release();
    await drainPending();
  });

  it("no unhandled rejection when both agent.chat and the error reply throw", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { bot, agent, drainPending } = await buildBot();
      agent.chat.mockRejectedValue(new Error("boom"));
      const ctx = makeCtx();
      ctx.reply.mockImplementation(async (text: string) => {
        if (String(text).includes("Sorry")) throw new Error("reply down");
        return undefined;
      });

      await getCommand(bot, "plan")(ctx);
      await drainPending();
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("same-chat dispatches reach agent.chat in send order; ordering is the agent's lock, not a channel lock", async () => {
    const { bot, agent, drainPending, chatCoalesceMs } = await buildBot();
    const chatOrder: string[] = [];
    agent.chat.mockImplementation(async ({ message }: { message: string }) => {
      chatOrder.push(message);
      return { text: "ok" };
    });
    const ctxA = makeCtx({ chat: { id: 333 }, message: { text: "first" } });
    const ctxB = makeCtx({ chat: { id: 333 }, message: { text: "second" } });
    agent.hasSession.mockResolvedValue({ hasSession: true });

    // Advance past the coalesce window between sends so each message is its
    // own turn (fragments inside the window are a single coalesced turn —
    // covered in telegram-coalescing.test.ts).
    vi.useFakeTimers();
    try {
      await getMessageText(bot)(ctxA);
      await vi.advanceTimersByTimeAsync(chatCoalesceMs);
      await getMessageText(bot)(ctxB);
      await vi.advanceTimersByTimeAsync(chatCoalesceMs);
      await drainPending();
    } finally {
      vi.useRealTimers();
    }

    expect(agent.chat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "telegram:333", message: "first" }),
    );
    expect(agent.chat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "telegram:333", message: "second" }),
    );
    // The synchronous handler prologue captures each message before dispatching,
    // so the two turns must reach agent.chat in send order. A future change that
    // awaited anything before capturing the text (reordering the prologue) would
    // let "second" jump ahead and fail this.
    expect(chatOrder).toEqual(["first", "second"]);
  });
});

describe("setMyCommands menu list", () => {
  it("includes the full command set (with start) and excludes snapshot when reference is present", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    await vi.waitFor(() => expect(bot.api.setMyCommands).toHaveBeenCalledTimes(1));
    const menu = bot.api.setMyCommands.mock.calls[0][0] as {
      command: string;
      description: string;
    }[];
    const names = menu.map((c) => c.command);
    for (const c of [
      "start",
      "plan",
      "workout",
      "status",
      "review",
      "sync",
      "version",
      "whatsnew",
      "update",
    ]) {
      expect(names).toContain(c);
    }
    expect(names).not.toContain("snapshot");
    for (const entry of menu) {
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("excludes sync when reference is undefined", async () => {
    const { bot } = await buildBot();
    await vi.waitFor(() => expect(bot.api.setMyCommands).toHaveBeenCalledTimes(1));
    const menu = bot.api.setMyCommands.mock.calls[0][0] as {
      command: string;
      description: string;
    }[];
    const names = menu.map((c) => c.command);
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
