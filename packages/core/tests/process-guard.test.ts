import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real serializeError is the redaction surface this module delegates to;
// keep it real so the "no payload keys leak" assertion is meaningful, but
// capture every emitted line so tests can assert on shape without a log file.
const captured: Array<{
  level: string;
  component: string;
  event: string;
  line: Record<string, unknown>;
}> = [];

vi.mock("../src/logging/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logging/index.js")>();
  return {
    ...actual,
    createSubsystemLogger: (component: string) => ({
      debug: () => {},
      info: (event: string, fields?: Record<string, unknown>) => {
        captured.push({ level: "info", component, event, line: { event, ...fields } });
      },
      warn: (event: string, err?: unknown, fields?: Record<string, unknown>) => {
        captured.push({
          level: "warn",
          component,
          event,
          line: {
            event,
            err: err === undefined ? undefined : actual.serializeError(err),
            ...fields,
          },
        });
      },
      error: (event: string, err?: unknown, fields?: Record<string, unknown>) => {
        captured.push({
          level: "error",
          component,
          event,
          line: {
            event,
            err: err === undefined ? undefined : actual.serializeError(err),
            ...fields,
          },
        });
      },
    }),
  };
});

let tempHome: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

let priorUncaught: NodeJS.UncaughtExceptionListener[];
let priorRejection: Array<(...args: unknown[]) => void>;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-guard-"));
  captured.length = 0;
  // Snapshot the framework's own handlers so the per-test handlers this suite
  // installs can be stripped in afterEach without disturbing vitest's.
  priorUncaught = process.listeners("uncaughtException");
  priorRejection = process.listeners("unhandledRejection") as Array<(...args: unknown[]) => void>;
  vi.resetModules();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}`);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const l of process.listeners("uncaughtException")) {
    if (!priorUncaught.includes(l)) process.removeListener("uncaughtException", l);
  }
  for (const l of process.listeners("unhandledRejection") as Array<(...args: unknown[]) => void>) {
    if (!priorRejection.includes(l)) process.removeListener("unhandledRejection", l);
  }
  exitSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const breadcrumb = () => join(tempHome, "last-run.json");

async function loadGuard() {
  const mod = await import("../src/process-guard.js");
  mod.__resetProcessGuardForTesting();
  return mod;
}

describe("installCrashHandlers", () => {
  it("writes exactly one redacted last-gasp line then exits non-zero", async () => {
    const { installCrashHandlers } = await loadGuard();
    installCrashHandlers({ dataDir: tempHome });

    const leaky = Object.assign(new Error("boom"), {
      requestBodyValues: { messages: "SECRET PROMPT" },
      responseBody: "SECRET BODY",
      payload: { text: "ATHLETE HEALTH SECRET" },
      authorization: "Bearer SECRET",
    });

    expect(() => process.emit("uncaughtException", leaky)).toThrow("__exit_1");

    expect(captured).toHaveLength(1);
    const line = captured[0]!.line;
    expect(line.event).toBe("uncaught_exception");
    const err = line.err as Record<string, unknown>;
    expect(err.name).toBe("Error");
    expect(err).not.toHaveProperty("message");
    expect(err).not.toHaveProperty("stack");
    expect("requestBodyValues" in err).toBe(false);
    expect("responseBody" in err).toBe(false);
    expect("payload" in err).toBe(false);
    expect(JSON.stringify(line)).not.toContain("ATHLETE HEALTH SECRET");
    expect(JSON.stringify(line)).not.toContain("SECRET PROMPT");
    expect(JSON.stringify(line)).not.toContain("Bearer SECRET");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("re-entrancy latch: a second exception while crashing does not double-write", async () => {
    const { installCrashHandlers } = await loadGuard();
    installCrashHandlers({ dataDir: tempHome });

    expect(() => process.emit("uncaughtException", new Error("first"))).toThrow("__exit_1");
    // The latch is set; a second emit must not write a second line.
    expect(() => process.emit("uncaughtException", new Error("second"))).not.toThrow();
    expect(captured).toHaveLength(1);
  });

  it("registers handlers idempotently if called twice", async () => {
    const { installCrashHandlers } = await loadGuard();
    const before = process.listenerCount("uncaughtException");
    installCrashHandlers({ dataDir: tempHome });
    installCrashHandlers({ dataDir: tempHome });
    const after = process.listenerCount("uncaughtException");
    expect(after - before).toBe(1);
  });
});

describe("logBootLine + breadcrumb lifecycle", () => {
  it("arms the breadcrumb running at boot", async () => {
    const { logBootLine } = await loadGuard();
    logBootLine({ dataDir: tempHome });

    expect(existsSync(breadcrumb())).toBe(true);
    const crumb = JSON.parse(readFileSync(breadcrumb(), "utf-8")) as {
      status: string;
      startedAt: number;
    };
    expect(crumb.status).toBe("running");
    expect(typeof crumb.startedAt).toBe("number");
    expect(captured.some((c) => c.event === "boot")).toBe(true);
  });

  it("detects a stale running breadcrumb from a prior boot as unclean", async () => {
    const { logBootLine } = await loadGuard();
    logBootLine({ dataDir: tempHome }); // first boot arms `running`
    captured.length = 0;
    logBootLine({ dataDir: tempHome }); // second boot sees the stale `running`

    expect(captured.some((c) => c.event === "previous_run_unclean")).toBe(true);
  });

  it("a clean shutdown then re-boot is NOT flagged unclean", async () => {
    const { logBootLine, markCleanShutdown } = await loadGuard();
    logBootLine({ dataDir: tempHome });
    markCleanShutdown({ dataDir: tempHome });
    expect(existsSync(breadcrumb())).toBe(false);
    captured.length = 0;
    logBootLine({ dataDir: tempHome });

    expect(captured.some((c) => c.event === "previous_run_unclean")).toBe(false);
  });

  it("flags a handler-written `unclean` breadcrumb at the next boot and carries uncleanAt", async () => {
    const { logBootLine } = await loadGuard();
    const uncleanAt = 1_700_000_000_000;
    // Simulate a prior run whose crash handler fired and recorded the death.
    writeFileSync(
      breadcrumb(),
      JSON.stringify({ startedAt: uncleanAt - 5_000, status: "unclean", uncleanAt }),
    );
    captured.length = 0;
    logBootLine({ dataDir: tempHome });

    const warn = captured.find((c) => c.event === "previous_run_unclean");
    expect(warn).toBeDefined();
    expect(warn!.line.priorStatus).toBe("unclean");
    expect(warn!.line.uncleanAt).toBe(uncleanAt);
  });
});

describe("reportFatal", () => {
  it("prints actionable 401 copy, writes the last-gasp line once, exits non-zero", async () => {
    const { reportFatal } = await loadGuard();
    expect(() =>
      reportFatal({ error_code: 401, description: "Unauthorized" }, { dataDir: tempHome }),
    ).toThrow("__exit_1");
    expect(
      errSpy.mock.calls.some((c: unknown[]) => /revoked|invalid|@BotFather/i.test(String(c[0]))),
    ).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.event).toBe("fatal");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints actionable 409 copy and exits non-zero", async () => {
    const { reportFatal } = await loadGuard();
    expect(() =>
      reportFatal({ error_code: 409, description: "Conflict" }, { dataDir: tempHome }),
    ).toThrow("__exit_1");
    expect(
      errSpy.mock.calls.some((c: unknown[]) => /409|conflict|another instance/i.test(String(c[0]))),
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("a generic error exits non-zero but prints no token-specific copy", async () => {
    const { reportFatal } = await loadGuard();
    expect(() => reportFatal(new Error("nope"), { dataDir: tempHome })).toThrow("__exit_1");
    expect(
      errSpy.mock.calls.some((c: unknown[]) =>
        /revoked|409|conflict|@BotFather/i.test(String(c[0])),
      ),
    ).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("marks the breadcrumb unclean", async () => {
    const { reportFatal } = await loadGuard();
    expect(() => reportFatal(new Error("nope"), { dataDir: tempHome })).toThrow("__exit_1");
    const crumb = JSON.parse(readFileSync(breadcrumb(), "utf-8")) as { status: string };
    expect(crumb.status).toBe("unclean");
  });
});

describe("breadcrumb write never throws out of a handler", () => {
  it("a crash handler reaches process.exit even when the breadcrumb is unwritable", async () => {
    const { installCrashHandlers } = await loadGuard();
    // Point dataDir at a path whose parent is a regular file, so the breadcrumb
    // write fails — the failure must be swallowed and the handler must still exit.
    const unwritable = join(tempHome, "afile", "nested");
    writeFileSync(join(tempHome, "afile"), "x");
    installCrashHandlers({ dataDir: unwritable });

    expect(() => process.emit("uncaughtException", new Error("boom"))).toThrow("__exit_1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The last-gasp log line is still emitted despite the swallowed breadcrumb write.
    expect(captured).toHaveLength(1);
  });
});
