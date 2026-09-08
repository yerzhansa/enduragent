import { describe, expect, it } from "vitest";
import {
  LEDGER_DATE_PATTERN,
  LEDGER_EVENT_KINDS,
  LEDGER_EVENT_SOURCES,
  type LedgerEventInput,
} from "../src/sport/ledger-event.js";

describe("ledger event contract", () => {
  it("covers all declared kinds and sources", () => {
    const events: LedgerEventInput[] = LEDGER_EVENT_KINDS.flatMap((kind) =>
      LEDGER_EVENT_SOURCES.map((source) => ({
        date: "2026-07-18",
        kind,
        text: kind,
        source,
      })),
    );
    expect([...new Set(events.map((event) => event.kind))]).toEqual([
      "decision",
      "override",
      "illness",
      "experiment",
      "outcome",
    ]);
    expect(new Set(events.map((event) => event.source))).toEqual(new Set(["flush", "chat"]));
  });

  it("accepts the canonical date shape and rejects malformed dates", () => {
    expect(LEDGER_DATE_PATTERN.test("2026-07-18")).toBe(true);
    for (const invalid of ["2026-7-18", "18-07-2026", "2026-07-18T00:00:00Z", ""])
      expect(LEDGER_DATE_PATTERN.test(invalid)).toBe(false);
  });
});
