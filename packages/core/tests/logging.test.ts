import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSubsystemLogger,
  createRootLogger,
  serializeError,
  pruneFileByAge,
  LOG_FILE,
  LOG_MAX_AGE_MS,
} from "../src/logging/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-log-"));
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function logFilePath(dataDir: string): string {
  return join(dataDir, "logs", LOG_FILE);
}

function readLines(dataDir: string): string[] {
  return readFileSync(logFilePath(dataDir), "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("subsystem logger — file sink", () => {
  it("writes a JSONL line carrying ts, level, component, event", () => {
    const log = createSubsystemLogger("agent", dir);
    log.info("turn_started", { chatId: "telegram:i1" });

    const lines = readLines(dir);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(parsed.ts).toBeTypeOf("string");
    expect(parsed.level).toBe("info");
    expect(parsed.component).toBe("agent");
    expect(parsed.event).toBe("turn_started");
    expect(parsed.chatId).toBe("telegram:i1");
  });

  it.runIf(process.platform !== "win32")(
    "writes the file at mode 0600 inside a 0700 logs dir",
    () => {
      const log = createSubsystemLogger("sync", dir);
      log.info("tick");

      const fileMode = statSync(logFilePath(dir)).mode & 0o777;
      const dirMode = statSync(join(dir, "logs")).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    },
  );
});

describe("born-redacted invariant", () => {
  it("redacts payload/requestBodyValues/responseBody and denylisted keys while keeping name/statusCode", () => {
    const err = Object.assign(new Error("upstream blew up"), {
      name: "APICallError",
      statusCode: 429,
      payload: { text: "ATHLETE HEALTH SECRET" },
      requestBodyValues: { messages: ["SECRET PROMPT"] },
      responseBody: "SECRET BODY",
      headers: {
        authorization: "Bearer SECRET",
        api_key: "sk-SECRET",
        token: "SECRET",
        cookie: "SECRET",
      },
    });

    const log = createSubsystemLogger("telegram", dir);
    log.error("command_failed", err, { chatId: "telegram:i1" });

    const raw = readLines(dir).join("\n");
    expect(raw).not.toContain("ATHLETE HEALTH SECRET");
    expect(raw).not.toContain("SECRET PROMPT");
    expect(raw).not.toContain("SECRET BODY");
    expect(raw).not.toContain("Bearer SECRET");
    expect(raw).not.toContain("sk-SECRET");

    expect(raw).toContain("APICallError");
    expect(raw).not.toContain("upstream blew up");
    expect(raw).toContain("429");
  });
});

describe("size-cap rotation", () => {
  it("rotates the live file to .jsonl.1 once it crosses the byte cap", () => {
    const path = logFilePath(dir);
    const root = createRootLogger(dir, { maxBytes: 256 });
    // Seed the live file above the (tiny, injected) cap, then emit once.
    root.emit("info", { component: "agent", event: "seed", filler: "x".repeat(512) });
    expect(statSync(path).size).toBeGreaterThan(256);

    root.emit("info", { component: "agent", event: "after_rotate" });

    expect(existsSync(`${path}.1`)).toBe(true);
    const live = readLines(dir);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]).event).toBe("after_rotate");
  });
});

describe("age-cap retention", () => {
  it("prunes lines older than the cap and keeps fresh ones", () => {
    const now = Date.UTC(2000, 0, 15);
    const oldTs = new Date(now - LOG_MAX_AGE_MS - 1000).toISOString();
    const freshTs = new Date(now - 1000).toISOString();
    const path = logFilePath(dir);
    const root = createRootLogger(dir, { now: () => now });
    // Prime the dir, then overwrite with a mixed-age file.
    root.emit("info", { component: "agent", event: "prime" });
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: oldTs, level: "info", component: "agent", event: "STALE_LINE" }),
        JSON.stringify({ ts: freshTs, level: "info", component: "agent", event: "FRESH_LINE" }),
      ].join("\n") + "\n",
    );

    pruneFileByAge(path, now - LOG_MAX_AGE_MS);

    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain("STALE_LINE");
    expect(raw).toContain("FRESH_LINE");
  });

  it("rolls aged content on the next emit when the file is under the size cap", () => {
    const now = Date.UTC(2000, 0, 15);
    const path = logFilePath(dir);
    const root = createRootLogger(dir, { now: () => now });
    root.emit("info", { component: "agent", event: "prime" });
    writeFileSync(
      path,
      JSON.stringify({
        ts: new Date(now - LOG_MAX_AGE_MS - 1000).toISOString(),
        level: "info",
        component: "agent",
        event: "STALE_LINE",
      }) + "\n",
    );
    // Touch back-date so the file modtime cannot mask the in-line age check.
    const old = (now - LOG_MAX_AGE_MS - 1000) / 1000;
    utimesSync(path, old, old);

    root.emit("info", { component: "agent", event: "FRESH_EMIT" });

    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain("STALE_LINE");
    expect(raw).toContain("FRESH_EMIT");
  });
});

describe("never throws on an unwritable target", () => {
  it("does not throw when the parent of the logs dir is a regular file", () => {
    // Point dataDir at a path whose parent is a file, so mkdir/open fails.
    const blocker = join(dir, "block");
    writeFileSync(blocker, "i am a file, not a dir");
    const log = createSubsystemLogger("agent", join(blocker, "nested"));

    expect(() => log.error("boom", new Error("x"))).not.toThrow();
    expect(() => log.info("ok")).not.toThrow();
  });
});

describe("serializeError unit cases", () => {
  it.each([TypeError, RangeError, SyntaxError])(
    "keeps the safe built-in error name",
    (ErrorType) => {
      expect(serializeError(new ErrorType("marker"))).toEqual({ name: ErrorType.name });
    },
  );

  it("does not inspect a proxied error prototype", () => {
    const callback = vi.fn(() => {
      throw new Error("marker");
    });
    const error = Object.setPrototypeOf(
      new Error("marker"),
      new Proxy(TypeError.prototype, {
        get: callback,
        getOwnPropertyDescriptor: callback,
      }),
    );
    expect(serializeError(error)).toEqual({ name: "Error" });
    expect(callback).not.toHaveBeenCalled();
  });
  it("keeps name without message or stack for a plain Error", () => {
    const out = serializeError(new Error("plain failure"));
    expect(out.name).toBe("Error");
    expect(out).not.toHaveProperty("message");
    expect(out).not.toHaveProperty("stack");
  });

  it("returns a fixed name for a non-Error without deep inspection", () => {
    const out = serializeError({ not: "an error" });
    expect(out).toEqual({ name: "NonError" });
  });

  it("does not throw and yields a sentinel for a circular error", () => {
    const err = new Error("cyclic") as Error & { self?: unknown };
    err.self = err;
    let out: Record<string, unknown> = {};
    expect(() => {
      out = serializeError(err);
    }).not.toThrow();
    expect(out.name).toBe("Error");
    expect(out).not.toHaveProperty("message");
    // The circular field is replaced by a sentinel, never recursed into.
    expect(JSON.stringify(out)).toContain("[redacted]");
  });

  it("drops requestBodyValues/responseBody/payload entirely", () => {
    const err = Object.assign(new Error("leak vector"), {
      requestBodyValues: { messages: ["SECRET PROMPT"] },
      responseBody: "SECRET BODY",
      payload: { text: "SECRET REPLY" },
    });
    const out = serializeError(err);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("SECRET PROMPT");
    expect(serialized).not.toContain("SECRET BODY");
    expect(serialized).not.toContain("SECRET REPLY");
    expect(out).not.toHaveProperty("requestBodyValues");
    expect(out).not.toHaveProperty("responseBody");
    expect(out).not.toHaveProperty("payload");
  });
});

describe("final diagnostic sinks", () => {
  it("sanitizes raw root fields, nested errors and URL text before persistence and console output", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createRootLogger(dir);
    root.emit("error", {
      component: "agent",
      event: "request_failed https://marker@example.invalid/marker?token=marker#marker",
      err: Object.assign(new Error("marker"), {
        statusCode: 503,
        code: "ECONNRESET",
        path: "marker",
        cause: new Error("marker"),
      }),
      nested: [{ apiKey: "marker", message: "marker", url: "marker" }],
      note: "Bearer marker",
      requestUrl: "marker",
    });
    const raw = readLines(dir).join("\n");
    expect(raw).not.toContain("marker");
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain("marker");
    expect(JSON.parse(raw).err).toMatchObject({
      name: "Error",
      statusCode: 503,
      code: "ECONNRESET",
    });
  });

  it.each(["debug", "info", "warn", "error"] as const)("protects canonical %s fields", (level) => {
    const log = createSubsystemLogger("agent", dir, { threshold: "error" });
    const fields = {
      component: "marker",
      event: "marker",
      err: { token: "marker" },
      ts: "marker",
      level: "marker",
    };
    if (level === "warn" || level === "error")
      log[level]("request_failed", new Error("marker"), fields);
    else log[level]("request_failed", fields);
    const raw = readLines(dir).join("\n");
    expect(raw).not.toContain("marker");
    expect(JSON.parse(raw)).toMatchObject({ component: "agent", event: "request_failed", level });
  });

  it("never invokes field getters, proxy traps, toJSON or error coercion", () => {
    const callback = vi.fn(() => {
      throw new Error("marker");
    });
    const hostile = new Proxy({}, { ownKeys: callback, get: callback });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const fields = Object.defineProperty(
      { hostile, revoked: revoked.proxy, toJSON: callback, bigint: 1n },
      "getter",
      { enumerable: true, get: callback },
    );
    const log = createSubsystemLogger("agent", dir);
    expect(() => log.error("request_failed", { toString: callback }, fields)).not.toThrow();
    expect(() => log.info("request_failed", hostile)).not.toThrow();
    expect(() =>
      createRootLogger(dir).emit(
        "info",
        Object.defineProperty({ component: "agent", event: "request_failed" }, "getter", {
          enumerable: true,
          get: callback,
        }),
      ),
    ).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(readLines(dir)).toHaveLength(3);
    expect(readLines(dir).join("\n")).not.toContain("marker");
  });

  it("does not throw if timestamp generation fails", () => {
    const root = createRootLogger(dir, {
      now: () => {
        throw new Error("marker");
      },
    });
    expect(() => root.emit("info", { component: "agent", event: "request_failed" })).not.toThrow();
  });
});
