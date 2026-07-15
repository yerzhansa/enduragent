import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import {
  defaultPairingState,
  saveAllowedSenders,
  loadAllowedSenders,
} from "../src/channels/allowed-senders.js";
import { _parseConfirmAnswer } from "../src/run-binary.js";

let tempHome: string;
let origHome: string | undefined;
let origArgv: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-rb-allow-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origArgv = process.argv;
  vi.resetModules();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  process.env.HOME = origHome;
  process.argv = origArgv;
  exitSpy.mockRestore();
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const dataDir = () => join(tempHome ?? "", ".cycling-coach");
const ALLOWLIST = () => join(dataDir(), "allowed-senders.json");

const stubSport = {
  id: "stub",
  soul: "",
  skills: {},
  memorySections: [],
  mustPreserveTokens: () => [],
  intervalsActivityTypes: [],
  athleteProfileSchema: { parse: () => ({}) },
  tools: () => [],
};

describe("CLI subcommands — allowlist mutations", () => {
  it("add-sender abc → exits 1 with 'positive integer' message", async () => {
    process.argv = ["node", "cycling-coach", "add-sender", "abc"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubSport as never, cyclingBinary)).rejects.toThrow("__exit_1");
    expect(errSpy.mock.calls.some((c) => String(c[0]).match(/positive integer/))).toBe(true);
    errSpy.mockRestore();
  });

  it("add-sender 0 → exits 1 (regex rejects)", async () => {
    process.argv = ["node", "cycling-coach", "add-sender", "0"];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubSport as never, cyclingBinary)).rejects.toThrow("__exit_1");
  });

  it("add-sender 12345 → file written, exits 0", async () => {
    process.argv = ["node", "cycling-coach", "add-sender", "12345"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubSport as never, cyclingBinary)).rejects.toThrow("__exit_0");
    expect(existsSync(ALLOWLIST())).toBe(true);
    const reloaded = loadAllowedSenders(dataDir());
    expect(reloaded.allowFrom).toEqual(["12345"]);
    expect(reloaded.dmPolicy).toBe("allowlist");
  });

  it("add-sender (no id) → exits 1 with usage message", async () => {
    process.argv = ["node", "cycling-coach", "add-sender"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubSport as never, cyclingBinary)).rejects.toThrow("__exit_1");
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);
    errSpy.mockRestore();
  });

  it("remove-sender 12345 → file updated, exits 0", async () => {
    saveAllowedSenders(dataDir(), () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345", "67890"],
      primaryOperator: "12345",
    }));
    process.argv = ["node", "cycling-coach", "remove-sender", "12345"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubSport as never, cyclingBinary)).rejects.toThrow("__exit_0");
    const reloaded = loadAllowedSenders(dataDir());
    expect(reloaded.allowFrom).toEqual(["67890"]);
  });

  it("list-senders prints policy, allowFrom, addedAt", async () => {
    saveAllowedSenders(dataDir(), () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
      addedAt: { "12345": "2026-05-09T10:00:00.000Z" },
    }));
    process.argv = ["node", "cycling-coach", "list-senders"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubSport as never, cyclingBinary)).rejects.toThrow("__exit_0");
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("Policy: allowlist");
    expect(printed).toContain("Primary operator: 12345");
    expect(printed).toContain("12345");
    logSpy.mockRestore();
  });
});

describe("makeReadlineConfirm — parsing matrix (T4)", () => {
  it.each([
    // [input, expected]
    ["", false],
    ["y", true],
    ["Y", true],
    ["yes", true],
    ["YES", true],
    [" yes ", true],
    ["\nyes\n", true],
    ["n", false],
    ["N", false],
    ["no", false],
    ["NO", false],
    [" no ", false],
    ["yes please", false],
    ["yeah", false],
    ["yep", false],
    ["hmm", false],
    ["да", false],
    ["1", false],
    ["true", false],
  ])("parses %j → %s", (input, expected) => {
    expect(_parseConfirmAnswer(input)).toBe(expected);
  });
});

describe("startup-capture predicate (T3)", () => {
  // We exercise the predicate by mocking loadAllowedSenders to control its output.
  // The real wiring is verified by the integration sweep — these tests guard the
  // T3 invariants (env-var case rejection, no-token skip, file-already-set skip).

  function setupBaseMocks(opts: {
    isTTY: boolean;
    botToken: string;
    allowFromInFile?: string[];
    operatorIdEnv?: string;
  }): { captureFn: ReturnType<typeof vi.fn>; notifyUpdateFn: ReturnType<typeof vi.fn> } {
    Object.defineProperty(process.stdin, "isTTY", { value: opts.isTTY, configurable: true });

    if (opts.allowFromInFile && opts.allowFromInFile.length > 0) {
      saveAllowedSenders(dataDir(), () => ({
        ...defaultPairingState(),
        dmPolicy: "allowlist",
        allowFrom: opts.allowFromInFile!,
        primaryOperator: opts.allowFromInFile![0],
      }));
    }
    if (opts.operatorIdEnv !== undefined) {
      process.env.CYCLING_COACH_OPERATOR_ID = opts.operatorIdEnv;
    } else {
      delete process.env.CYCLING_COACH_OPERATOR_ID;
    }

    const captureFn = vi.fn(async () => ({
      status: "timeout" as const,
      botUsername: "testbot",
    }));
    vi.doMock("../src/channels/operator-capture.js", () => ({
      captureAndPersistOperator: captureFn,
    }));

    // Stub config + LLM dispatch + agent so we can run the bot-start path.
    vi.doMock("../src/config.js", async () => {
      const real = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
      return {
        ...real,
        loadConfig: () => ({
          llm: { provider: "anthropic", model: "x", apiKey: "sk-x" },
          telegram: { botToken: opts.botToken },
          intervals: { apiKey: "x", athleteId: "x" },
          dataDir: dataDir(),
        }),
        resolveConfigSecrets: async (c: unknown) => c,
      };
    });
    // Stub CoachAgent to isolate startup capture and allowlist behavior.
    vi.doMock("../src/agent/coach-agent.js", () => ({
      CoachAgent: class {
        constructor() {}
        getMemory() { return { readMemory: () => "" } as never; }
        chat() { return Promise.resolve("ok"); }
        hasSession() { return false; }
        resetSession() { return Promise.resolve(); }
      },
    }));
    // Stub the telegram bot construction so we don't actually try to start polling.
    const notifyUpdateFn = vi.fn(async () => undefined);
    vi.doMock("../src/channels/telegram.js", () => ({
      createTelegramBot: vi.fn(() => ({
        bot: { start: vi.fn(async () => undefined), api: { sendMessage: vi.fn() } },
        drainPending: vi.fn(async () => undefined),
      })),
      notifyUpdate: notifyUpdateFn,
    }));

    return { captureFn, notifyUpdateFn };
  }

  afterEach(() => {
    delete process.env.CYCLING_COACH_OPERATOR_ID;
    delete process.env.CYCLING_COACH_NO_UPDATE_CHECK;
    vi.doUnmock("../src/channels/operator-capture.js");
    vi.doUnmock("../src/config.js");
    vi.doUnmock("../src/agent/coach-agent.js");
    vi.doUnmock("../src/channels/telegram.js");
  });

  it("TTY + no file + token + no env → capture invoked", async () => {
    process.argv = ["node", "cycling-coach"];
    const { captureFn } = setupBaseMocks({ isTTY: true, botToken: "TOKEN" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(captureFn).toHaveBeenCalledTimes(1);
  });

  it("no TTY → capture NOT invoked; bot starts in pairing mode", async () => {
    process.argv = ["node", "cycling-coach"];
    const { captureFn } = setupBaseMocks({ isTTY: false, botToken: "TOKEN" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(captureFn).not.toHaveBeenCalled();
  });

  it("env-var CYCLING_COACH_OPERATOR_ID set → capture NOT invoked", async () => {
    process.argv = ["node", "cycling-coach"];
    const { captureFn } = setupBaseMocks({
      isTTY: true,
      botToken: "TOKEN",
      operatorIdEnv: "12345",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(captureFn).not.toHaveBeenCalled();
  });

  it("T3: invalid env-var → loadAllowedSenders falls through to default-pairing → capture invoked", async () => {
    process.argv = ["node", "cycling-coach"];
    const { captureFn } = setupBaseMocks({
      isTTY: true,
      botToken: "TOKEN",
      operatorIdEnv: "abc",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(captureFn).toHaveBeenCalledTimes(1);
  });

  it("CYCLING_COACH_NO_UPDATE_CHECK set → notifyUpdate NOT invoked", async () => {
    process.argv = ["node", "cycling-coach"];
    process.env.CYCLING_COACH_NO_UPDATE_CHECK = "1";
    const { notifyUpdateFn } = setupBaseMocks({ isTTY: false, botToken: "TOKEN" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(notifyUpdateFn).not.toHaveBeenCalled();
  });

  it("CYCLING_COACH_NO_UPDATE_CHECK unset → notifyUpdate invoked once", async () => {
    process.argv = ["node", "cycling-coach"];
    delete process.env.CYCLING_COACH_NO_UPDATE_CHECK;
    const { notifyUpdateFn } = setupBaseMocks({ isTTY: false, botToken: "TOKEN" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(notifyUpdateFn).toHaveBeenCalledTimes(1);
  });

  it("startup tightens the data dir to 0o700", async () => {
    process.argv = ["node", "cycling-coach"];
    setupBaseMocks({ isTTY: false, botToken: "TOKEN" });
    chmodSync(dataDir(), 0o755);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(statSync(dataDir()).mode & 0o777).toBe(0o700);
  });

  it("file already exists with non-empty allowFrom → capture NOT invoked", async () => {
    process.argv = ["node", "cycling-coach"];
    const { captureFn } = setupBaseMocks({
      isTTY: true,
      botToken: "TOKEN",
      allowFromInFile: ["12345"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(captureFn).not.toHaveBeenCalled();
  });

  it("getme-failed result → bot still starts (capture is non-fatal)", async () => {
    process.argv = ["node", "cycling-coach"];
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    delete process.env.CYCLING_COACH_OPERATOR_ID;
    const captureFn = vi.fn(async () => ({
      status: "getme-failed" as const,
      reason: "401",
    }));
    vi.doMock("../src/channels/operator-capture.js", () => ({
      captureAndPersistOperator: captureFn,
    }));
    vi.doMock("../src/config.js", async () => {
      const real = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
      return {
        ...real,
        loadConfig: () => ({
          llm: { provider: "anthropic", model: "x", apiKey: "sk-x" },
          telegram: { botToken: "TOKEN" },
          intervals: { apiKey: "x", athleteId: "x" },
          dataDir: dataDir(),
        }),
        resolveConfigSecrets: async (c: unknown) => c,
      };
    });
    vi.doMock("../src/agent/coach-agent.js", () => ({
      CoachAgent: class {
        constructor() {}
        getMemory() { return { readMemory: () => "" } as never; }
      },
    }));
    const startSpy = vi.fn(async () => undefined);
    vi.doMock("../src/channels/telegram.js", () => ({
      createTelegramBot: vi.fn(() => ({
        bot: { start: startSpy, api: { sendMessage: vi.fn() } },
        drainPending: vi.fn(async () => undefined),
      })),
      notifyUpdate: vi.fn(async () => undefined),
    }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubSport as never, cyclingBinary);
    expect(captureFn).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1); // bot started despite getme-failed
    // Normal startup no longer drops pending updates (offline messages survive a
    // restart); the update-offset guard dedupes replays instead.
    expect(startSpy).toHaveBeenCalledWith();
  });
});
