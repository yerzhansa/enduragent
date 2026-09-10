import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCurrentTimeLine,
  buildCurrentTimeLine,
  isValidTimezone,
  resolveUserTimezone,
  todayInTZ,
} from "../src/sport/user-time.js";
import { Memory } from "../../core/src/memory/store.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { resolveDailyResetAtMs } from "../src/agent/session-freshness.js";
import { createPureCoreIntervalsTools } from "../src/sport/platform-tools.js";
import { COACH_EVENT_TAG } from "../src/sport/event-provenance.js";
import type { PlatformCalendarMutationsPort } from "../src/host-ports.js";

// ────────────────────────────────────────────────────────────────────────
// resolveUserTimezone — chain: configured (validated) → host → "UTC"
// ────────────────────────────────────────────────────────────────────────

describe("resolveUserTimezone", () => {
  it("returns the configured TZ when valid IANA", () => {
    expect(resolveUserTimezone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveUserTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls through invalid configured value to host TZ", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveUserTimezone("Not/A/Real/Zone");
    expect(result).not.toBe("Not/A/Real/Zone");
    expect(isValidTimezone(result)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses host TZ when nothing configured (with warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveUserTimezone(undefined);
    expect(isValidTimezone(result)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats whitespace as unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveUserTimezone("   ");
    expect(isValidTimezone(result)).toBe(true);
    warn.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────
// todayInTZ — emits YYYY-MM-DD in athlete-local frame
// ────────────────────────────────────────────────────────────────────────

describe("todayInTZ", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("UTC noon: today is the same calendar day in every zone", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    expect(todayInTZ("UTC")).toBe("2026-05-01");
    expect(todayInTZ("Asia/Tokyo")).toBe("2026-05-01");
    expect(todayInTZ("America/Los_Angeles")).toBe("2026-05-01");
  });

  it("UTC+9 just past local midnight: athlete sees the next day", () => {
    // 2026-05-01T02:00:00+09:00 = 2026-04-30T17:00Z
    vi.setSystemTime(new Date("2026-04-30T17:00:00Z"));
    expect(todayInTZ("UTC")).toBe("2026-04-30");
    expect(todayInTZ("Asia/Tokyo")).toBe("2026-05-01"); // ← AC1
  });

  it("UTC-7 (PDT) just before local midnight: athlete still on the previous day", () => {
    // 2026-04-30T23:00 PDT (UTC-7) = 2026-05-01T06:00Z
    vi.setSystemTime(new Date("2026-05-01T06:00:00Z"));
    expect(todayInTZ("UTC")).toBe("2026-05-01");
    expect(todayInTZ("America/Los_Angeles")).toBe("2026-04-30"); // ← AC1
  });
});

// ────────────────────────────────────────────────────────────────────────
// appendCurrentTimeLine — idempotent, includes both local + UTC
// ────────────────────────────────────────────────────────────────────────

describe("appendCurrentTimeLine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("appends local + UTC time", () => {
    vi.setSystemTime(new Date("2026-05-03T11:55:00Z"));
    const out = appendCurrentTimeLine("hi", "Asia/Tokyo");
    expect(out).toContain("Current time:");
    expect(out).toContain("Asia/Tokyo");
    expect(out).toContain("2026-05-03 11:55 UTC");
  });

  it("is idempotent — second call leaves the message unchanged", () => {
    vi.setSystemTime(new Date("2026-05-03T11:55:00Z"));
    const once = appendCurrentTimeLine("hi", "UTC");
    const twice = appendCurrentTimeLine(once, "UTC");
    expect(twice).toBe(once);
  });

  it("leaves an already-timed message unchanged when the clock and zone have moved on", () => {
    vi.setSystemTime(new Date("2026-05-03T11:55:00Z"));
    const stored = appendCurrentTimeLine("hi", "Asia/Tokyo");
    vi.setSystemTime(new Date("2026-05-04T08:10:00Z"));
    expect(appendCurrentTimeLine(stored, "Europe/Berlin")).toBe(stored);
  });

  it("returns empty string for empty input (no time line on no message)", () => {
    expect(appendCurrentTimeLine("", "UTC")).toBe("");
    expect(appendCurrentTimeLine("   \n  ", "UTC")).toBe("");
  });
});

describe("buildCurrentTimeLine", () => {
  it("includes weekday + ordinal day + 24h time + UTC", () => {
    // 2026-05-03 11:55 UTC = 20:55 in Asia/Tokyo (UTC+9)
    const line = buildCurrentTimeLine("Asia/Tokyo", Date.parse("2026-05-03T11:55:00Z"));
    expect(line).toContain("Sunday");
    expect(line).toContain("3rd");
    expect(line).toContain("20:55");
    expect(line).toContain("(Asia/Tokyo)");
    expect(line).toContain("2026-05-03 11:55 UTC");
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC1 + AC2 — system prompt TZ name and daily-notes filename agree
// ────────────────────────────────────────────────────────────────────────

describe("integration: system prompt + daily notes agree on 'today'", () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(join(tmpdir(), "cc-tz-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("Asia/Tokyo at local 02:00 → both see 2026-05-01", () => {
    // 2026-05-01T02:00 JST (UTC+9) = 2026-04-30T17:00Z
    vi.setSystemTime(new Date("2026-04-30T17:00:00Z"));
    const tz = "Asia/Tokyo";
    const memory = new Memory(dataDir, tz);
    memory.appendDailyNote("rode 60min Z2");

    expect(existsSync(join(dataDir, "memory", "2026-05-01.md"))).toBe(true);
    expect(existsSync(join(dataDir, "memory", "2026-04-30.md"))).toBe(false);

    const persona = { soul: "soul", skills: {}, sessionClusterGapMinutes: 60 };
    const sp = buildSystemPrompt(persona, memory, tz);
    expect(sp).toContain(`Time zone: ${tz}`);
    expect(sp).not.toMatch(/Today is /); // never bake the date into the prompt
  });

  it("America/Los_Angeles at local 23:00 → both see 2026-04-30", () => {
    vi.setSystemTime(new Date("2026-05-01T06:00:00Z")); // 23:00 PDT (UTC-7) on Apr 30
    const tz = "America/Los_Angeles";
    const memory = new Memory(dataDir, tz);
    memory.appendDailyNote("rest day");

    expect(existsSync(join(dataDir, "memory", "2026-04-30.md"))).toBe(true);
    expect(existsSync(join(dataDir, "memory", "2026-05-01.md"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC3 — intervals_delete_workout past-workout check uses athlete TZ
// ────────────────────────────────────────────────────────────────────────

function makeFakeMutations(eventDateLocal: string): PlatformCalendarMutationsPort {
  const deleteCalls: number[] = [];
  return {
    createEvent: async () => ({}),
    readEventForDelete: async ({ eventId }) => ({
      id: eventId,
      startDateLocal: eventDateLocal,
      category: "WORKOUT",
      tags: [COACH_EVENT_TAG],
    }),
    updateEvent: async () => ({}),
    deleteEvent: async ({ eventId }) => {
      deleteCalls.push(eventId);
      return { ok: true };
    },
  };
}

describe("intervals_delete_workout (AC3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("UTC-8 athlete at local 22:00 May 1: deleting today's workout is allowed", async () => {
    // 2026-05-01T22:00 PDT = 2026-05-02T05:00Z
    vi.setSystemTime(new Date("2026-05-02T05:00:00Z"));
    const tz = "America/Los_Angeles";
    const mutations = makeFakeMutations("2026-05-01T18:00:00");
    const tools = createPureCoreIntervalsTools(null, tz, undefined, mutations);
    const tool = tools.intervals_delete_workout!;

    const result = (await tool.execute!({ eventId: 42 }, {} as never)) as { deleted?: true; error?: string };
    expect(result.deleted).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("workout dated yesterday is refused as past_workout_protected", async () => {
    vi.setSystemTime(new Date("2026-05-02T05:00:00Z"));
    const tz = "America/Los_Angeles";
    const mutations = makeFakeMutations("2026-04-30T18:00:00");
    const tools = createPureCoreIntervalsTools(null, tz, undefined, mutations);
    const tool = tools.intervals_delete_workout!;

    const result = (await tool.execute!({ eventId: 99 }, {} as never)) as { error?: string };
    expect(result.error).toBe("past_workout_protected");
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC6 — dailyResetHour resolves in athlete TZ, not host TZ
// ────────────────────────────────────────────────────────────────────────

describe("resolveDailyResetAtMs (AC6)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns today 04:00 in tz when current time is past it", () => {
    // 2026-05-03 10:00 JST (UTC+9) = 2026-05-03 01:00 UTC
    vi.setSystemTime(new Date("2026-05-03T01:00:00Z"));
    const reset = resolveDailyResetAtMs(4, "Asia/Tokyo");
    // 04:00 JST = 19:00 UTC the previous day
    expect(new Date(reset).toISOString()).toBe("2026-05-02T19:00:00.000Z");
  });

  it("returns yesterday 04:00 in tz when current time is before today's reset", () => {
    // 2026-05-03 02:00 JST = 2026-05-02 17:00 UTC, before today's 04:00 reset
    vi.setSystemTime(new Date("2026-05-02T17:00:00Z"));
    const reset = resolveDailyResetAtMs(4, "Asia/Tokyo");
    // Yesterday's 04:00 JST = 2026-05-01 19:00 UTC
    expect(new Date(reset).toISOString()).toBe("2026-05-01T19:00:00.000Z");
  });
});
