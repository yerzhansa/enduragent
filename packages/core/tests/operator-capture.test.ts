import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import {
  defaultPairingState,
  saveAllowedSenders,
  loadAllowedSenders,
} from "../src/channels/allowed-senders.js";

// ─── Fake grammy Bot factory ─────────────────────────────────────────────────
// Each test sets up its desired bot behavior by pushing onto these queues.

interface FakeBot {
  api: { getMe: ReturnType<typeof vi.fn> };
  use: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  fireUpdate: (ctx: unknown) => Promise<void>;
}

function makeFakeBot(opts: {
  getMe: () => Promise<{ is_bot: boolean; username?: string }>;
  /** when bot.start() is called, the test can decide to fire an update or never resolve */
  onStart?: (bot: FakeBot) => void;
}): FakeBot {
  let middleware: ((ctx: unknown, next: () => Promise<void>) => Promise<void>) | undefined;
  let stopResolver: (() => void) | undefined;
  const bot: FakeBot = {
    api: { getMe: vi.fn(opts.getMe) },
    use: vi.fn((mw: typeof middleware) => {
      middleware = mw;
    }),
    start: vi.fn(
      () =>
        new Promise<void>((res) => {
          stopResolver = res;
          opts.onStart?.(bot);
        }),
    ),
    stop: vi.fn(async () => {
      stopResolver?.();
    }),
    fireUpdate: async (ctx) => {
      if (!middleware) throw new Error("Test bug: bot.use was never called");
      await middleware(ctx, async () => undefined);
    },
  };
  return bot;
}

let dataDir: string;
let savedEnv: string | undefined;
let nextBots: FakeBot[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-capture-"));
  savedEnv = process.env.CYCLING_COACH_OPERATOR_ID;
  delete process.env.CYCLING_COACH_OPERATOR_ID;
  nextBots = [];
  vi.resetModules();
  vi.doMock("grammy", () => ({
    Bot: function FakeBot(this: unknown, _token: string) {
      const next = nextBots.shift();
      if (!next) throw new Error("Test bug: no fake bot queued");
      return next;
    },
  }));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CYCLING_COACH_OPERATOR_ID;
  else process.env.CYCLING_COACH_OPERATOR_ID = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
});

async function importHelper() {
  return (await import("../src/channels/operator-capture.js")).captureAndPersistOperator;
}

// The pairing code is generated inside the helper and only surfaced via log();
// tests read it back from the logged lines to echo it in fake updates.
function pairingLog() {
  const lines: string[] = [];
  return {
    log: (s: string) => lines.push(s),
    code: () => {
      const line = lines.find((l) => l.includes("Pairing code:"));
      if (!line) throw new Error("Test bug: pairing code was never logged");
      return line.split("Pairing code:")[1]!.trim();
    },
  };
}

describe("captureAndPersistOperator — getMe gate", () => {
  it("getMe rejects → status: 'getme-failed', no bot.start() invoked", async () => {
    const bot = makeFakeBot({
      getMe: async () => {
        throw new Error("401 Unauthorized");
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
    });
    expect(result.status).toBe("getme-failed");
    expect(bot.start).not.toHaveBeenCalled();
  });

  it("getMe returns is_bot:false → status: 'getme-failed'", async () => {
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: false, username: "notabot" }),
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
    });
    expect(result.status).toBe("getme-failed");
    expect(bot.start).not.toHaveBeenCalled();
  });

  it("getMe returns empty username → status: 'getme-failed'", async () => {
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "" }),
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
    });
    expect(result.status).toBe("getme-failed");
  });
});

describe("captureAndPersistOperator — capture flow", () => {
  it("captures + confirm true → file written, status 'captured'", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 12345 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const confirm = vi.fn(async () => true);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm,
      log: pairing.log,
    });
    expect(result.status).toBe("captured");
    expect(bot.start).toHaveBeenCalledWith(expect.objectContaining({ drop_pending_updates: true }));
    expect(result.capturedId).toBe("12345");
    expect(result.botUsername).toBe("testbot");
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        capturedId: "12345",
        senderUsername: "alice",
        senderFirstName: "Alice",
        botUsername: "testbot",
        binaryName: "cycling-coach",
      }),
    );
    expect(existsSync(join(dataDir, "allowed-senders.json"))).toBe(true);
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.dmPolicy).toBe("allowlist");
    expect(reloaded.allowFrom).toEqual(["12345"]);
    expect(reloaded.primaryOperator).toBe("12345");
  });

  it("captures + confirm false → status 'declined', no file written", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 12345 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => false,
      log: pairing.log,
    });
    expect(result.status).toBe("declined");
    expect(existsSync(join(dataDir, "allowed-senders.json"))).toBe(false);
  });

  it("timeout → status 'timeout', no file written", async () => {
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      // onStart absent → bot.start() never resolves; only the timer wakes it.
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      timeoutMs: 50,
      confirm: async () => true,
    });
    expect(result.status).toBe("timeout");
    expect(existsSync(join(dataDir, "allowed-senders.json"))).toBe(false);
  });

  it("captured from.id failing ^[1-9]\\d+$ → 'getme-failed' (defense-in-depth)", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 0 },
          from: { id: 0, username: "x", first_name: "x" }, // id=0 violates regex
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      timeoutMs: 100,
      confirm: async () => true,
      log: pairing.log,
    });
    // Either the bad id is rejected at capture (timeout) or surfaced as getme-failed.
    expect(["getme-failed", "timeout"]).toContain(result.status);
    expect(existsSync(join(dataDir, "allowed-senders.json"))).toBe(false);
  });

  it("non-private chat ctx is ignored during capture window", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        // Group-chat update fires but capture should ignore it even with the
        // right code; capture window then expires.
        await b.fireUpdate({
          chat: { type: "group", id: -1234 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      timeoutMs: 50,
      confirm: async () => true,
      log: pairing.log,
    });
    expect(result.status).toBe("timeout");
  });
});

describe("captureAndPersistOperator — pairing code gate", () => {
  it("sender with non-matching text is ignored → timeout, no confirm, no file", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 99999 },
          from: { id: 99999, username: "stranger", first_name: "Mallory" },
          message: { text: "/start" },
        });
      },
    });
    nextBots.push(bot);
    const confirm = vi.fn(async () => true);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      timeoutMs: 50,
      confirm,
      log: pairing.log,
    });
    expect(result.status).toBe("timeout");
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "allowed-senders.json"))).toBe(false);
  });

  it("wrong-code sender then matching sender → captures only the matching sender", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 99999 },
          from: { id: 99999, username: "stranger", first_name: "Mallory" },
          message: { text: "not-the-code" },
        });
        await b.fireUpdate({
          chat: { type: "private", id: 12345 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
          message: { text: `  ${pairing.code()}  ` }, // surrounding whitespace is trimmed
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
      log: pairing.log,
    });
    expect(result.status).toBe("captured");
    expect(result.capturedId).toBe("12345");
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.primaryOperator).toBe("12345");
  });

  it("update without message text is ignored → timeout", async () => {
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 12345 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      timeoutMs: 50,
      confirm: async () => true,
      log: pairing.log,
    });
    expect(result.status).toBe("timeout");
  });
});

describe("captureAndPersistOperator — re-capture preserves allowFrom (S11)", () => {
  it("Set-unions captured id into existing allowFrom; updates primaryOperator", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["op-old", "friend"].map((s) => (s === "op-old" ? "11111" : "22222")),
      primaryOperator: "11111",
      capturedAt: "2026-01-01T00:00:00.000Z",
    }));
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 33333 },
          from: { id: 33333, username: "newop", first_name: "New" },
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
      log: pairing.log,
    });
    expect(result.status).toBe("captured");
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.allowFrom.sort()).toEqual(["11111", "22222", "33333"]);
    expect(reloaded.primaryOperator).toBe("33333");
    expect(reloaded.capturedAt).not.toBe("2026-01-01T00:00:00.000Z"); // refreshed
  });
});

describe("captureAndPersistOperator — write-failed mapping (T2)", () => {
  it.each([
    ["ENOSPC", "no space left on device"],
    ["EACCES", "permission denied"],
    ["EROFS", "read-only filesystem"],
    ["EIO", "input/output error"],
    ["GENERIC", "totally unexpected"],
  ])("save throwing %s → status 'write-failed'", async (_code, message) => {
    vi.doMock("../src/channels/allowed-senders.js", async () => {
      const real = await vi.importActual<typeof import("../src/channels/allowed-senders.js")>(
        "../src/channels/allowed-senders.js",
      );
      return {
        ...real,
        saveAllowedSenders: vi.fn(() => {
          throw new Error(message);
        }),
      };
    });
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 12345 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
      log: pairing.log,
    });
    expect(result.status).toBe("write-failed");
    expect(result.reason).toContain(message);
  });

  it("save throwing LockfileContentionError → status 'lockfile-contention'", async () => {
    vi.doMock("../src/channels/allowed-senders.js", async () => {
      const real = await vi.importActual<typeof import("../src/channels/allowed-senders.js")>(
        "../src/channels/allowed-senders.js",
      );
      return {
        ...real,
        saveAllowedSenders: vi.fn(() => {
          throw new real.LockfileContentionError("held");
        }),
      };
    });
    const pairing = pairingLog();
    const bot = makeFakeBot({
      getMe: async () => ({ is_bot: true, username: "testbot" }),
      onStart: async (b) => {
        await b.fireUpdate({
          chat: { type: "private", id: 12345 },
          from: { id: 12345, username: "alice", first_name: "Alice" },
          message: { text: pairing.code() },
        });
      },
    });
    nextBots.push(bot);
    const captureAndPersistOperator = await importHelper();
    const result = await captureAndPersistOperator({
      botToken: "FAKE",
      binary: cyclingBinary,
      dataDir,
      confirm: async () => true,
      log: pairing.log,
    });
    expect(result.status).toBe("lockfile-contention");
  });
});
