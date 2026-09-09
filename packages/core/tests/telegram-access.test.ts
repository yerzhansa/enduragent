import { createPhrasebook } from "@enduragent/i18n/messages";
import { createCoachLanguage } from "@enduragent/i18n";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateAccess,
  buildPairingChallenge as pairingChallenge,
  createAuthMiddleware,
} from "../src/channels/telegram-access.js";
import {
  defaultPairingState,
  saveAllowedSenders,
  type AllowedSenders,
} from "../src/channels/allowed-senders.js";

function makeAllowed(overrides: Partial<AllowedSenders> = {}): AllowedSenders {
  return { ...defaultPairingState(), ...overrides } as AllowedSenders;
}

function makeCtx(opts: {
  chatType?: "private" | "group" | "supergroup" | "channel";
  fromId?: number | string | undefined;
}): Context {
  const ctx: Partial<Context> = {};
  if (opts.chatType !== undefined) {
    (ctx as { chat?: unknown }).chat = { type: opts.chatType, id: 0 };
  }
  if (opts.fromId !== undefined) {
    (ctx as { from?: unknown }).from = { id: opts.fromId };
  }
  return ctx as Context;
}

describe("evaluateAccess — chat-type and from-id guards", () => {
  it("rejects non-private chats (group)", () => {
    const ctx = makeCtx({ chatType: "group", fromId: 12345 });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }),
    );
    expect(result.allow).toBe(false);
  });

  it("rejects non-private chats (channel)", () => {
    const ctx = makeCtx({ chatType: "channel", fromId: 12345 });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }),
    );
    expect(result.allow).toBe(false);
  });

  it("rejects when ctx.from is undefined (service messages)", () => {
    const ctx = makeCtx({ chatType: "private", fromId: undefined });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }),
    );
    expect(result.allow).toBe(false);
  });

  it("rejects when typeof ctx.from.id !== 'number' (grammy version-drift guard)", () => {
    const ctx = makeCtx({ chatType: "private", fromId: "12345" as unknown as number });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }),
    );
    expect(result.allow).toBe(false);
  });
});

describe("evaluateAccess — allowlist matching", () => {
  it("allows when String(from.id) ∈ allowFrom (allowlist mode)", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 12345 });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"], primaryOperator: "12345" }),
    );
    expect(result).toEqual({ allow: true });
  });

  it("allows when dmPolicy is 'open' (env-var-only escape hatch), flagged viaOpenPolicy", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 99999 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "open", allowFrom: [] }));
    expect(result).toEqual({ allow: true, viaOpenPolicy: true });
  });

  it("allows an allowlisted sender under open policy WITHOUT the viaOpenPolicy flag", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 12345 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "open", allowFrom: ["12345"] }));
    expect(result).toEqual({ allow: true });
  });

  it("denies (silent) when dmPolicy is 'allowlist' and sender not in allowFrom", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 99999 });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"], primaryOperator: "12345" }),
    );
    expect(result.allow).toBe(false);
    expect(result.pairingChallenge).toBeUndefined();
  });

  it("emits pairingChallenge marker when dmPolicy is 'pairing' and sender not allowlisted", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 99999 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "pairing", allowFrom: [] }));
    expect(result.allow).toBe(false);
    expect(result.pairingChallenge).toBe("99999");
  });
});

describe("buildPairingChallenge — HTML body", () => {
  it("includes sender's user-ID, owner CLI command, and 'ask the bot owner' fallback", () => {
    const html = buildPairingChallenge("99999", "Stranger", "cycling-coach");
    expect(html).toContain("99999");
    expect(html).toContain("cycling-coach add-sender 99999");
    expect(html).toContain("ask the bot owner");
  });

  it("HTML-escapes sender name (XSS in pairing reply)", () => {
    const html = buildPairingChallenge("99999", "<script>alert(1)</script>", "cycling-coach");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes ampersand and quote in sender name", () => {
    const html = buildPairingChallenge("99999", 'Bob & "the Builder"', "cycling-coach");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("HTML-escapes binaryName defensively (constant in practice)", () => {
    const html = buildPairingChallenge("99999", undefined, "evil<bin>");
    expect(html).not.toContain("<bin>");
    expect(html).toContain("&lt;bin&gt;");
  });

  it.each([undefined, ""])("preserves the greeting for an absent sender name: %s", (senderName) => {
    const html = buildPairingChallenge("99999", senderName, "cycling-coach");
    expect(html).toContain("Hi there — your Telegram user ID is <code>99999</code>.");
  });

  it("accepts numeric senderId and stringifies it", () => {
    const html = buildPairingChallenge(12345, "Alice", "cycling-coach");
    expect(html).toContain("12345");
  });
});

describe("createAuthMiddleware — gating", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-mw-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeMwCtx(opts: {
    chatType?: "private" | "group";
    fromId?: number;
    fromFirstName?: string;
    messageText?: string;
  }): Context & { reply: ReturnType<typeof vi.fn> } {
    const ctx: Record<string, unknown> = {
      reply: vi.fn(async () => undefined),
    };
    if (opts.chatType !== undefined) {
      ctx.chat = { type: opts.chatType, id: opts.fromId ?? 0 };
    }
    if (opts.fromId !== undefined) {
      ctx.from = { id: opts.fromId, first_name: opts.fromFirstName };
    }
    if (opts.messageText !== undefined) {
      ctx.message = { text: opts.messageText };
    }
    return ctx as unknown as Context & { reply: ReturnType<typeof vi.fn> };
  }

  it("calls next() for allowed senders (allowlist mode)", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 12345 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("sends pairing-challenge HTML and does NOT call next() for stranger in pairing mode", async () => {
    // dataDir empty + no env → default-pairing mode
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999, fromFirstName: "Stranger" });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [html, options] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(html).toContain("99999");
    expect(html).toContain("cycling-coach add-sender 99999");
    expect(options).toEqual({ parse_mode: "HTML" });
  });

  it("supports a host-owned pairing prompt and authorization source", async () => {
    const language = createCoachLanguage({
      phrasebooks: createPhrasebook,
      store: {
        read: async () => ({ value: null, origin: "unset" }),
        write: async (value) => ({ value, origin: "stored" }),
      },
      surface: { language: "en", locale: "en-US" },
    });
    const loadAllowedSenders = vi.fn(() => defaultPairingState());
    const pairingChallenge = vi.fn(
      ({ senderId }: { senderId: string }) =>
        `<b>Approve <code>${senderId}</code> in Desktop Settings.</b>`,
    );
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "unused",
      language,
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
      loadAllowedSenders,
      pairingChallenge,
    });
    const ctx = makeMwCtx({
      chatType: "private",
      fromId: 99999,
      messageText: "明日のトレーニングについて詳しく教えてください。",
    });

    await mw(ctx, vi.fn());

    expect(loadAllowedSenders).toHaveBeenCalledWith(dataDir);
    expect(pairingChallenge).toHaveBeenCalledWith({
      senderId: "99999",
      senderName: undefined,
      phrasebook: expect.objectContaining({ tag: "ja" }),
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      "<b>Approve <code>99999</code> in Desktop Settings.</b>",
      { parse_mode: "HTML" },
    );
  });

  it("offers exact private text to consumePairing before loading the allowlist", async () => {
    const events: string[] = [];
    const consumePairing = vi.fn(async (input) => {
      events.push("consume");
      expect(input).toEqual({
        senderId: "99999",
        senderName: "Athlete",
        messageText: "  AbC123  ",
      });
      return true;
    });
    const loadAllowedSenders = vi.fn(() => {
      events.push("load");
      return defaultPairingState();
    });
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
      consumePairing,
      loadAllowedSenders,
    });
    const ctx = makeMwCtx({
      chatType: "private",
      fromId: 99999,
      fromFirstName: "Athlete",
      messageText: "  AbC123  ",
    });
    const next = vi.fn(async () => undefined);

    await mw(ctx, next);

    expect(events).toEqual(["consume"]);
    expect(loadAllowedSenders).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("does not let a consumed pairing code from an allowlisted sender reach next", async () => {
    const consumePairing = vi.fn(async () => true);
    const loadAllowedSenders = vi.fn(() =>
      makeAllowed({
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
      }),
    );
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
      consumePairing,
      loadAllowedSenders,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 12345, messageText: "a1b2c3" });
    const next = vi.fn(async () => undefined);

    await mw(ctx, next);

    expect(consumePairing).toHaveBeenCalledTimes(1);
    expect(loadAllowedSenders).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("continues through normal allowlist authorization when pairing does not consume", async () => {
    const consumePairing = vi.fn(async () => false);
    const loadAllowedSenders = vi.fn(() =>
      makeAllowed({
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
      }),
    );
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
      consumePairing,
      loadAllowedSenders,
    });
    const next = vi.fn(async () => undefined);

    await mw(
      makeMwCtx({ chatType: "private", fromId: 12345, messageText: "ordinary message" }),
      next,
    );

    expect(consumePairing).toHaveBeenCalledTimes(1);
    expect(loadAllowedSenders).toHaveBeenCalledWith(dataDir);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never invokes consumePairing without a valid private numeric sender and text message", async () => {
    const consumePairing = vi.fn(async () => true);
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
      consumePairing,
    });

    await mw(makeMwCtx({ chatType: "group", fromId: 12345, messageText: "a1b2c3" }), vi.fn());
    await mw(makeMwCtx({ chatType: "private", fromId: 12345 }), vi.fn());
    await mw(makeMwCtx({ chatType: "private", fromId: 1, messageText: "a1b2c3" }), vi.fn());
    const nonNumeric = makeMwCtx({ chatType: "private", messageText: "a1b2c3" });
    (nonNumeric as unknown as { from: { id: string } }).from = { id: "12345" };
    await mw(nonNumeric, vi.fn());

    expect(consumePairing).not.toHaveBeenCalled();
  });

  it("fails closed when consumePairing rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consumePairing = vi.fn(async () => {
      throw new Error("pairing store unavailable");
    });
    const loadAllowedSenders = vi.fn(() =>
      makeAllowed({
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
      }),
    );
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
      consumePairing,
      loadAllowedSenders,
    });
    const next = vi.fn(async () => undefined);

    await mw(makeMwCtx({ chatType: "private", fromId: 12345, messageText: "a1b2c3" }), next);

    expect(loadAllowedSenders).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security] middleware error"));
    errSpy.mockRestore();
  });

  it("does NOT call next() for stranger in allowlist mode (silent drop, no reply)", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();

    const callbackCtx = makeMwCtx({ chatType: "private", fromId: 99999 });
    (callbackCtx as unknown as { callbackQuery: { data: string } }).callbackQuery = {
      data: "cg:y:attacker-value",
    };
    const callbackNext = vi.fn(async () => undefined);
    await mw(callbackCtx, callbackNext);
    expect(callbackNext).not.toHaveBeenCalled();
  });

  it("rate-limit: same sender messaging twice within window → only one reply", async () => {
    const map = new Map<string, number>();
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const ctx1 = makeMwCtx({ chatType: "private", fromId: 99999 });
    const ctx2 = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx1, next);
    await mw(ctx2, next);
    expect(ctx1.reply).toHaveBeenCalledTimes(1);
    expect(ctx2.reply).not.toHaveBeenCalled();
  });

  it("rate-limit: different senders are rate-limited independently", async () => {
    const map = new Map<string, number>();
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const ctxA = makeMwCtx({ chatType: "private", fromId: 11111 });
    const ctxB = makeMwCtx({ chatType: "private", fromId: 22222 });
    const next = vi.fn(async () => undefined);
    await mw(ctxA, next);
    await mw(ctxB, next);
    expect(ctxA.reply).toHaveBeenCalledTimes(1);
    expect(ctxB.reply).toHaveBeenCalledTimes(1);
  });

  it("rate-limit: same sender after window elapses → second reply fires", async () => {
    const map = new Map<string, number>();
    // Pre-seed map to simulate the previous reply was 70s ago.
    map.set("99999", Date.now() - 70_000);
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("rate-limit map LRU bound: 1001 distinct senders → map size stays ≤ 1000", async () => {
    const map = new Map<string, number>();
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    for (let i = 0; i < 1001; i++) {
      const ctx = makeMwCtx({ chatType: "private", fromId: 100000 + i });
      // eslint-disable-next-line no-await-in-loop
      await mw(ctx, next);
    }
    expect(map.size).toBeLessThanOrEqual(1000);
    // The *last-seen* sender should still be in the map (not the first).
    expect(map.has("101000")).toBe(true);
    expect(map.has("100000")).toBe(false);
  });

  it("open policy (env): serves non-allowlisted sender but warns to stderr once per sender", async () => {
    vi.stubEnv("CYCLING_COACH_DM_POLICY", "open");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    await mw(makeMwCtx({ chatType: "private", fromId: 99999 }), next);
    await mw(makeMwCtx({ chatType: "private", fromId: 99999 }), next);
    expect(next).toHaveBeenCalledTimes(2);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("Open DM policy"));
    expect(warnings.length).toBe(1);
    expect(String(warnings[0][0])).toContain("99999");
    errSpy.mockRestore();
  });

  it("open policy (env): distinct non-allowlisted senders each get one warning", async () => {
    vi.stubEnv("CYCLING_COACH_DM_POLICY", "open");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    await mw(makeMwCtx({ chatType: "private", fromId: 11111 }), next);
    await mw(makeMwCtx({ chatType: "private", fromId: 22222 }), next);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("Open DM policy"));
    expect(warnings.length).toBe(2);
    errSpy.mockRestore();
  });

  it("open policy (env): allowlisted sender is served without the open-policy warning", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    vi.stubEnv("CYCLING_COACH_DM_POLICY", "open");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    await mw(makeMwCtx({ chatType: "private", fromId: 12345 }), next);
    expect(next).toHaveBeenCalledTimes(1);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("Open DM policy"));
    expect(warnings.length).toBe(0);
    errSpy.mockRestore();
  });

  it("fail-closed: load throws → drops update without calling next() and logs to stderr", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Use an obviously-illegal dataDir so loadAllowedSenders+saveAllowedSenders throw.
    // (loadAllowedSenders by itself only logs — but the inner ensureDataDirSecure inside
    // a real save would throw on a bad path. To force a throw inside load, we instead
    // pass a path that triggers the JSON read error: write a directory in place of the file.)
    // Simpler: throw from a custom middleware via stubbing — use a Map proxy that throws.
    const throwingMap = new Proxy(new Map<string, number>(), {
      get(_target, prop) {
        if (prop === "get") {
          return () => {
            throw new Error("synthetic boom");
          };
        }
        return Reflect.get(_target, prop);
      },
    }) as Map<string, number>;
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: throwingMap,
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security] middleware error"));
    errSpy.mockRestore();
  });

  // ── next() runs OUTSIDE the auth guard ─────────────────────────────
  it("a downstream next() throw propagates and is NOT logged as a security error", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 12345 });
    const next = vi.fn(async () => {
      throw new Error("downstream handler boom");
    });
    await expect(mw(ctx, next)).rejects.toThrow("downstream handler boom");
    const securityLogs = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes("[security] middleware error"),
    );
    expect(securityLogs.length).toBe(0);
    errSpy.mockRestore();
  });

  it("an allowlist-load throw is caught fail-closed (logged, no next(), no rethrow)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A throwing challengeRateLimit.get forces a throw on the pairing path,
    // exercising the guarded auth-logic catch (default-pairing dataDir).
    const throwingMap = new Proxy(new Map<string, number>(), {
      get(target, prop) {
        if (prop === "get") {
          return () => {
            throw new Error("synthetic auth boom");
          };
        }
        return Reflect.get(target, prop);
      },
    }) as Map<string, number>;
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: throwingMap,
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await expect(mw(ctx, next)).resolves.toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security] middleware error"));
    errSpy.mockRestore();
  });

  it("a granted (allowlisted) sender runs next() exactly once", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 12345 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("a non-allowlisted pairing sender gets the challenge and next() is NOT called", async () => {
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999, fromFirstName: "Stranger" });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});

const englishBook = await createPhrasebook({ tag: "en", locale: "en-GB" });
const buildPairingChallenge = (
  senderId: string | number,
  senderName: string | undefined,
  binaryName: string,
) => pairingChallenge(senderId, senderName, binaryName, englishBook);
