import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { APICallError } from "@ai-sdk/provider";
import type {
  BinaryConfig,
  CoreDeps,
  MemorySectionSpec,
  Sport,
  ToolRegistration,
} from "../src/index.js";

import { baseAgentConfig } from "./helpers/base-agent-config.js";

// ---------------------------------------------------------------------------
// Stub running-coach Sport — the load-bearing proof that Core is sport-agnostic.
// ---------------------------------------------------------------------------

const runningSections: readonly MemorySectionSpec[] = [
  { name: "running-profile", description: "VDOT, easy pace, recent race times" },
  { name: "running-equipment", description: "Shoes, watch, footstrike notes" },
  { name: "running-history", description: "Injuries, mileage history, peak weeks" },
];

const stubRunningSport: Sport = {
  id: "running",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: runningSections,
  mustPreserveTokens: () => ["VDOT"],
  intervalsActivityTypes: ["Run", "TrailRun"],
  athleteProfileSchema: z.object({}),
  tools: (_deps: CoreDeps): readonly ToolRegistration[] => {
    // Compose only Core's generic memory tools. Sport-specific tools (zones,
    // plan-skeleton, intervals.icu workouts) would land here for a real sport.
    return [];
  },
};

const stubRunningBinary: BinaryConfig = {
  binaryName: "running-coach",
  displayName: "Running Coach",
  dataSubdir: "running",
  keychainPrefix: "running-coach",
  homeEnvVar: "RUNNING_COACH_HOME",
};

// ---------------------------------------------------------------------------

describe("Core is sport-agnostic — CoachAgent constructs and chats with a non-cycling Sport", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "cc-run-binary-"));
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = join(tempHome, ".running-coach");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("constructs CoachAgent with stubRunningSport and round-trips a chat through a mocked codex LLM", async () => {
    const complete = vi.fn(async () => ({
      text: "ack from running-coach",
      toolCalls: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      stopReason: "stop" as const,
    }));

    vi.doMock("../src/agent/codex/responses.js", () => ({
      codexResponses: complete,
    }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));

    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    const agent = new CoachAgent(stubRunningSport, baseAgentConfig(dataDir));
    const text = await agent.chat("running-test", "hi");

    expect(text).toBe("ack from running-coach");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runBinary CLI routing — version command, unknown command
// ---------------------------------------------------------------------------

describe("runBinary CLI routing", () => {
  let origArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origArgv = process.argv;
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv = origArgv;
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("`version` command prints `${binary.binaryName} v<version>` and returns without exit", async () => {
    process.argv = ["node", "running-coach", "version"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("../src/updater.js", () => ({ getCurrentVersion: () => "2026.7.2" }));

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubRunningSport, stubRunningBinary);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toBe("running-coach v2026.7.2");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("unknown command prints USAGE then exits with code 1", async () => {
    process.argv = ["node", "running-coach", "bogus"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubRunningSport, stubRunningBinary)).rejects.toThrow("__exit_1");

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Unknown command: bogus"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatCliReply — shared classified copy for the CLI reply position
// ---------------------------------------------------------------------------

describe("formatCliReply", () => {
  function apiError(statusCode: number, retryAfterSec?: number): APICallError {
    return new APICallError({
      message: "api error",
      url: "https://example.invalid/api",
      requestBodyValues: {},
      statusCode,
      responseHeaders:
        retryAfterSec === undefined ? undefined : { "retry-after": String(retryAfterSec) },
    });
  }

  it("on a 429 returns the friendly wait copy (no stack)", async () => {
    const { formatCliReply } = await import("../src/run-binary.js");
    const reply = formatCliReply(apiError(429, 30));
    expect(reply).toBe("Rate limited — please try again in ~30 seconds.");
    expect(reply).not.toContain("APICallError");
    expect(reply).not.toContain("\n");
  });

  it("on a provider-auth error returns the provider-neutral one-liner (no payload)", async () => {
    const { formatCliReply } = await import("../src/run-binary.js");
    const reply = formatCliReply(apiError(401));
    expect(reply).toBe("The model provider rejected the API key — check your provider credentials.");
    expect(reply).not.toContain("Anthropic");
    expect(reply).not.toContain("example.invalid");
  });

  it("on a provider-down error returns the one-line classified copy", async () => {
    const { formatCliReply } = await import("../src/run-binary.js");
    expect(formatCliReply(apiError(503))).toBe(
      "The model provider is having trouble — try again in a few minutes.",
    );
  });

  it("on an unknown error returns the single-line apology with no raw message", async () => {
    const { formatCliReply } = await import("../src/run-binary.js");
    const reply = formatCliReply(new Error("SENSITIVE provider payload at /secret/path"));
    expect(reply).toBe("Sorry, something went wrong. Please try again.");
    expect(reply).not.toContain("SENSITIVE");
    expect(reply).not.toContain("/secret/path");
  });
});

describe("_promptProposalConfirm", () => {
  it.each(["y", "yes", " Y ", "YeS\n"])("confirms explicit yes answer %j", async (answer) => {
    const confirm = vi.fn(async () => ({
      status: "executed" as const,
      summary: "Save the training plan",
      result: { saved: true },
    }));
    const cancel = vi.fn();
    const question = vi.fn((_prompt: string, cb: (value: string) => void) => cb(answer));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { _promptProposalConfirm } = await import("../src/run-binary.js");
    await _promptProposalConfirm(
      { question },
      {
        confirmations: {
          peek: () => ({ nonce: "server-nonce", summary: "Save the training plan" }),
          confirm,
          cancel,
        },
      },
    );
    expect(question).toHaveBeenCalledWith(
      "Confirm: Save the training plan? [y/N]: ",
      expect.any(Function),
    );
    expect(confirm).toHaveBeenCalledWith("cli", "server-nonce");
    expect(cancel).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Done — Save the training plan.");
  });

  it.each(["", "n", "no", "sure", "1"])("cancels non-explicit answer %j", async (answer) => {
    const confirm = vi.fn();
    const cancel = vi.fn(() => "canceled" as const);
    const question = vi.fn((_prompt: string, cb: (value: string) => void) => cb(answer));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { _promptProposalConfirm } = await import("../src/run-binary.js");
    await _promptProposalConfirm(
      { question },
      {
        confirmations: {
          peek: () => ({ nonce: "server-nonce", summary: "Delete workout" }),
          confirm,
          cancel,
        },
      },
    );
    expect(cancel).toHaveBeenCalledWith("cli", "server-nonce");
    expect(confirm).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Canceled.");
  });

  it.each([
    { answer: "y", confirmed: true },
    { answer: "n", confirmed: false },
  ])(
    "routes the confirm answer $answer to the question callback, never the chat dispatcher",
    async ({ answer, confirmed }) => {
      let pendingQuestion: ((answer: string) => void) | undefined;
      let lineListener: ((line: string) => void) | undefined;
      const lineDispatch = vi.fn();
      const emitLine = (line: string) => {
        if (pendingQuestion !== undefined) {
          const cb = pendingQuestion;
          pendingQuestion = undefined;
          cb(line);
          return;
        }
        lineListener?.(line);
      };
      const rl = {
        on(event: string, cb: (line: string) => void) {
          if (event === "line") lineListener = cb;
        },
        question(_prompt: string, cb: (value: string) => void) {
          pendingQuestion = cb;
        },
      };
      rl.on("line", lineDispatch);
      emitLine("hello coach");
      expect(lineDispatch).toHaveBeenCalledWith("hello coach");
      lineDispatch.mockClear();

      const confirm = vi.fn(async () => ({
        status: "executed" as const,
        summary: "Delete workout",
        result: { deleted: true },
      }));
      const cancel = vi.fn(() => "canceled" as const);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { _promptProposalConfirm } = await import("../src/run-binary.js");
      const pending = _promptProposalConfirm(rl, {
        confirmations: {
          peek: () => ({ nonce: "server-nonce", summary: "Delete workout" }),
          confirm,
          cancel,
        },
      });
      emitLine(answer);
      await pending;

      expect(lineDispatch).not.toHaveBeenCalled();
      if (confirmed) {
        expect(confirm).toHaveBeenCalledWith("cli", "server-nonce");
        expect(cancel).not.toHaveBeenCalled();
      } else {
        expect(cancel).toHaveBeenCalledWith("cli", "server-nonce");
        expect(confirm).not.toHaveBeenCalled();
      }
    },
  );

  it("does nothing without a pending proposal", async () => {
    const question = vi.fn();
    const { _promptProposalConfirm } = await import("../src/run-binary.js");
    await _promptProposalConfirm(
      { question },
      {
        confirmations: {
          peek: () => undefined,
          confirm: vi.fn(),
          cancel: vi.fn(),
        },
      },
    );
    expect(question).not.toHaveBeenCalled();
  });
});
