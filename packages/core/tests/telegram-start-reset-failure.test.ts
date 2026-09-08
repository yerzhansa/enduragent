import { createNpmCoachLanguage } from "../src/language-preference.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-start-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
});

const RESET_FAILURE_REPLY =
  "Something went wrong resetting your session — your history is untouched. Please try /start again.";

const RESET_CAVEAT =
  "Note: I couldn't fully reset our previous session, so some earlier context may still apply.";

async function buildStartHandler(resetSession: ReturnType<typeof vi.fn>) {
  const bot = {
    api: { sendMessage: vi.fn(), setMyCommands: vi.fn(async () => true), config: { use: vi.fn() } },
    use: vi.fn(),
    callbackQuery: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    catch: vi.fn(),
  };
  vi.doMock("grammy", () => ({
    Bot: function FakeBot() {
      return bot;
    },
    InputFile: class {},
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const engine = {
    resetSession,
    chat: vi.fn(async () => ({ text: "ok" })),
    hasSession: vi.fn(async () => ({ hasSession: true })),
    getAthleteState: vi.fn(),
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
    release: {
      updatePolicy: "desktop-owned" as const,
      updateDescription: "Check for updates",
      whatsNewUnavailableText: "Couldn't fetch release notes. Try again later.",
      version: vi.fn(async () => "Cycling Coach v0.0.0"),
      whatsNew: vi.fn(async () => ({ kind: "unavailable" as const })),
      updateNotice: vi.fn(async () => "Update from Desktop."),
    },
  };

  const { createTelegramBot } = await import("../src/channels/telegram.js");
  createTelegramBot({
    webhookPolicy: "delete-before-polling",
    token: "FAKE_TOKEN",
    engine: engine as unknown as Parameters<typeof createTelegramBot>[0]["engine"],
    host,
    dataDir,
  });

  const start = bot.command.mock.calls.find((c: unknown[]) => c[0] === "start")![1];
  return start;
}

describe("/start reset-failure reply", () => {
  it("reset rejection → exact failure reply, no Welcome", async () => {
    const resetSession = vi.fn(async () => {
      throw new Error("boom");
    });
    const start = await buildStartHandler(resetSession);
    const ctx = { chat: { id: 777 }, reply: vi.fn(async () => undefined) };

    await start(ctx);

    expect(resetSession).toHaveBeenCalledWith({ chatId: "telegram:777" });
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith(RESET_FAILURE_REPLY);
    expect(
      ctx.reply.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("Welcome to Cycling Coach"),
      ),
    ).toBe(false);
  });

  it("reset success → Welcome, no failure copy", async () => {
    const resetSession = vi.fn(async () => ({ memoryFlushed: true }));
    const start = await buildStartHandler(resetSession);
    const ctx = { chat: { id: 777 }, reply: vi.fn(async () => undefined) };

    await start(ctx);

    expect(resetSession).toHaveBeenCalledWith({ chatId: "telegram:777" });
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(
      ctx.reply.mock.calls.some((c: unknown[]) =>
        String(c[0]).startsWith("Welcome to Cycling Coach!"),
      ),
    ).toBe(true);
    expect(
      ctx.reply.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("Something went wrong resetting"),
      ),
    ).toBe(false);
    expect(ctx.reply.mock.calls.some((c: unknown[]) => String(c[0]).includes(RESET_CAVEAT))).toBe(
      false,
    );
  });

  it("degraded reset → Welcome plus the caveat line", async () => {
    const resetSession = vi.fn(async () => ({ memoryFlushed: false }));
    const start = await buildStartHandler(resetSession);
    const ctx = { chat: { id: 777 }, reply: vi.fn(async () => undefined) };

    await start(ctx);

    expect(resetSession).toHaveBeenCalledWith({ chatId: "telegram:777" });
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(
      ctx.reply.mock.calls.some((c: unknown[]) =>
        String(c[0]).startsWith("Welcome to Cycling Coach!"),
      ),
    ).toBe(true);
    expect(ctx.reply.mock.calls.some((c: unknown[]) => String(c[0]).includes(RESET_CAVEAT))).toBe(
      true,
    );
    expect(
      ctx.reply.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("Something went wrong resetting"),
      ),
    ).toBe(false);
  });
});
