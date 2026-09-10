import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";

import { scriptedPrompts } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import {
  defaultPairingState,
  saveAllowedSenders,
  loadAllowedSenders,
  type AllowedSenders,
} from "../src/channels/allowed-senders.js";

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;

beforeEach(() => {
  for (const key of ["ENDURAGENT_LANGUAGE", "LANGUAGE", "LC_ALL", "LC_MESSAGES"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("LANG", "en_US.UTF-8");
  tempHome = mkdtempSync(join(tmpdir(), "cc-setup-allow-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origStdinTTY = process.stdin.isTTY;
  origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.resetModules();
  vi.doMock("../src/secrets/backends/detect.js", () => ({
    detectBackends: vi.fn(async () => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    })),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.HOME = origHome;
  Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("@clack/prompts");
  vi.doUnmock("../src/channels/operator-capture.js");
  vi.doUnmock("../src/secrets/backends/detect.js");
});

const CONFIG = () => join(tempHome, ".cycling-coach", "config.yaml");
const ALLOWLIST = () => join(tempHome, ".cycling-coach", "allowed-senders.json");

function seedConfig(obj: Record<string, unknown>): void {
  writeFileSync(CONFIG(), toYaml(obj), { mode: 0o600 });
}

interface MockCaptureSpec {
  status:
    | "captured"
    | "declined"
    | "timeout"
    | "getme-failed"
    | "lockfile-contention"
    | "write-failed";
  capturedId?: string;
  botUsername?: string;
  reason?: string;
  /** Callback the test runs to simulate post-capture confirm + write to disk. */
  onCapture?: (dataDir: string) => void;
}

function mockOperatorCapture(spec: MockCaptureSpec): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async (opts: { dataDir: string; confirm: (info: unknown) => Promise<boolean> }) => {
      if (spec.status === "captured") {
        // Simulate the capture flow's confirm prompt being invoked, then writing the file.
        const ok = await opts.confirm({
          capturedId: spec.capturedId ?? "12345",
          senderUsername: "alice",
          senderFirstName: "Alice",
          botUsername: spec.botUsername ?? "testbot",
          binaryName: "cycling-coach",
        });
        if (!ok) return { status: "declined" as const };
        spec.onCapture?.(opts.dataDir);
        return {
          status: "captured" as const,
          capturedId: spec.capturedId ?? "12345",
          botUsername: spec.botUsername ?? "testbot",
        };
      }
      if (spec.status === "declined") {
        // Simulate confirm prompt firing but operator declines.
        await opts.confirm({
          capturedId: spec.capturedId ?? "12345",
          senderUsername: "alice",
          senderFirstName: "Alice",
          botUsername: spec.botUsername ?? "testbot",
          binaryName: "cycling-coach",
        });
        return { status: "declined" as const };
      }
      return {
        status: spec.status,
        capturedId: spec.capturedId,
        botUsername: spec.botUsername,
        reason: spec.reason,
      };
    },
  );
  vi.doMock("../src/channels/operator-capture.js", () => ({
    captureAndPersistOperator: fn,
  }));
  return fn;
}

describe("setup wizard — operator capture integration (Phase 5)", () => {
  it("H1 (CRITICAL): cancel-at-config-confirm leaves NO orphan allowed-senders.json", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      telegram: { bot_token: "tg-keep" },
    });
    const beforeBytes = readFileSync(CONFIG());
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["", "", ""], // anthropic key keep, intervals keep, telegram keep
        texts: ["", ""], // intervals athlete-id keep (not asked) and other text
        confirms: [false], // decline the "Update config?" confirm
      }),
    );
    const captureFn = mockOperatorCapture({ status: "captured" });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(readFileSync(CONFIG())).toEqual(beforeBytes); // config unchanged
    expect(existsSync(ALLOWLIST())).toBe(false); // CRITICAL: no orphan
    expect(captureFn).not.toHaveBeenCalled(); // capture never ran
  });

  it("captures operator when confirm:true at the captured-id prompt", async () => {
    // Fresh install: no prior config or allowlist.
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["sk-ant-fresh", "", "BOT-TOKEN-1234"],
        texts: ["", "i42"],
        confirms: [true, true], // update config, save captured operator
      }),
    );
    const captureFn = mockOperatorCapture({
      status: "captured",
      capturedId: "12345",
      botUsername: "testbot",
      onCapture: (dataDir) => {
        // Simulate the helper's transformer-based persistence.
        saveAllowedSenders(dataDir, () => ({
          ...defaultPairingState(),
          dmPolicy: "allowlist",
          allowFrom: ["12345"],
          primaryOperator: "12345",
          capturedAt: new Date().toISOString(),
        }));
      },
    });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).toHaveBeenCalledTimes(1);
    expect(existsSync(ALLOWLIST())).toBe(true);
    const reloaded = loadAllowedSenders(join(tempHome, ".cycling-coach"));
    expect(reloaded.dmPolicy).toBe("allowlist");
    expect(reloaded.allowFrom).toEqual(["12345"]);
    expect(reloaded.primaryOperator).toBe("12345");
  });

  it("captured-id confirm defaults to decline (bare Enter does not save)", async () => {
    const confirmCalls: Array<{ message: string; initialValue?: boolean }> = [];
    vi.doMock("@clack/prompts", () => {
      const selects = ["anthropic", "claude-sonnet-4-6", "plain"];
      let s = 0;
      const passwords = ["sk-ant-fresh", "", "BOT-TOKEN-1234"];
      let p = 0;
      return {
        intro: vi.fn(),
        outro: vi.fn(),
        cancel: vi.fn(),
        log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
        note: vi.fn(),
        isCancel: () => false,
        select: vi.fn(async () => selects[s++]),
        password: vi.fn(async () => passwords[p++]),
        text: vi.fn(async () => ""),
        confirm: vi.fn(async (opts: { message: string; initialValue?: boolean }) => {
          confirmCalls.push(opts);
          return true;
        }),
      };
    });
    const captureFn = mockOperatorCapture({ status: "captured", capturedId: "12345" });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).toHaveBeenCalledTimes(1);
    const saveConfirm = confirmCalls.find((c) => c.message.includes("Captured operator id"));
    expect(saveConfirm).toBeDefined();
    expect(saveConfirm?.initialValue).toBe(false);
  });

  it("declined at captured-id prompt → no allowed-senders.json written", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["sk-ant-fresh", "", "BOT-TOKEN-1234"],
        texts: ["", "i42"],
        confirms: [true, false], // update config, decline save
      }),
    );
    const captureFn = mockOperatorCapture({ status: "declined" });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).toHaveBeenCalledTimes(1);
    expect(existsSync(ALLOWLIST())).toBe(false);
  });

  it("capture timeout → wizard continues, no file written", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["sk-ant-fresh", "", "BOT-TOKEN-1234"],
        texts: ["", "i42"],
        confirms: [true], // update config (capture flow doesn't confirm — timeout before confirm)
      }),
    );
    const captureFn = mockOperatorCapture({ status: "timeout" });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).toHaveBeenCalledTimes(1);
    expect(existsSync(ALLOWLIST())).toBe(false);
    expect(existsSync(CONFIG())).toBe(true); // config.yaml still committed
  });

  it("getme-failed → wizard does NOT abort; logs warning", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["sk-ant-fresh", "", "BAD-TOKEN"],
        texts: ["", "i42"],
        confirms: [true],
      }),
    );
    const captureFn = mockOperatorCapture({ status: "getme-failed", reason: "401 Unauthorized" });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).toHaveBeenCalledTimes(1);
    expect(existsSync(ALLOWLIST())).toBe(false);
    expect(existsSync(CONFIG())).toBe(true);
  });

  it("re-run with existing allowlist + answer N to re-capture → file unchanged (idempotency)", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      telegram: { bot_token: "tg-keep" },
    });
    const existing: AllowedSenders = {
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345", "67890"],
      primaryOperator: "12345",
      capturedAt: "2026-01-01T00:00:00.000Z",
      addedAt: { "12345": "2026-01-01T00:00:00.000Z", "67890": "2026-01-02T00:00:00.000Z" },
    };
    saveAllowedSenders(join(tempHome, ".cycling-coach"), () => existing);
    const beforeBytes = readFileSync(ALLOWLIST());

    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["", "", ""],
        texts: ["", ""],
        confirms: [true, false], // update config, decline re-capture
      }),
    );
    const captureFn = mockOperatorCapture({ status: "captured" });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).not.toHaveBeenCalled(); // skipped per re-capture decline
    expect(readFileSync(ALLOWLIST())).toEqual(beforeBytes); // byte-for-byte unchanged
  });

  it("S11 re-capture preserves existing allowFrom (Set-union)", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      telegram: { bot_token: "tg-keep" },
    });
    saveAllowedSenders(join(tempHome, ".cycling-coach"), () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["11111", "22222"],
      primaryOperator: "11111",
    }));

    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["", "", ""],
        texts: ["", ""],
        confirms: [true, true, true], // update config, re-capture YES, save captured
      }),
    );
    const captureFn = mockOperatorCapture({
      status: "captured",
      capturedId: "33333",
      onCapture: (dataDir) => {
        saveAllowedSenders(dataDir, (current) => {
          const base = current ?? defaultPairingState();
          const merged = base.allowFrom.includes("33333")
            ? base.allowFrom
            : [...base.allowFrom, "33333"];
          return {
            ...base,
            dmPolicy: "allowlist",
            allowFrom: merged,
            primaryOperator: "33333",
            addedAt: { ...base.addedAt, "33333": new Date().toISOString() },
            capturedAt: new Date().toISOString(),
          };
        });
      },
    });

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(captureFn).toHaveBeenCalledTimes(1);
    const reloaded = loadAllowedSenders(join(tempHome, ".cycling-coach"));
    expect(reloaded.allowFrom.sort()).toEqual(["11111", "22222", "33333"]);
    expect(reloaded.primaryOperator).toBe("33333"); // updated to new operator
  });
});
