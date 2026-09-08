import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCivilDate, formatInstantDateTime, formatOffsetWallTime } from "../src/lib/date";
import { pinDefaultLocale } from "./intl";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("regional date and time formatting", () => {
  it("uses US date order and a 12-hour wall clock", () => {
    pinDefaultLocale("en-US");

    expect(formatCivilDate("1998-07-18")).toBe("Jul 18, 1998");
    expect(formatCivilDate("1998-07-18", { day: "numeric", month: "numeric" })).toBe("7/18");
    expect(formatOffsetWallTime(900_000_000, 21_600)).toBe("10:00 PM");
    expect(formatInstantDateTime("1998-07-20T08:00:00.000Z")).toBe("Jul 20, 1998, 8:00 AM");
  });

  it("uses British date order and a 24-hour wall clock", () => {
    pinDefaultLocale("en-GB");

    expect(formatCivilDate("1998-07-18")).toBe("18 Jul 1998");
    expect(formatCivilDate("1998-07-18", { day: "numeric", month: "numeric" })).toBe("18/07");
    expect(formatOffsetWallTime(900_000_000, 21_600)).toBe("22:00");
    expect(formatInstantDateTime("1998-07-20T08:00:00.000Z")).toBe("20 Jul 1998, 08:00");
  });

  it("uses the device zone only for real instants", () => {
    pinDefaultLocale("en-US", "America/Los_Angeles");

    expect(formatInstantDateTime("1998-07-20T08:00:00.000Z")).toBe("Jul 20, 1998, 1:00 AM");
    expect(formatOffsetWallTime(900_000_000, 21_600)).toBe("10:00 PM");
  });

  it("rejects invalid civil dates and omits wall time without an offset", () => {
    pinDefaultLocale("en-US");

    expect(formatCivilDate("1998-02-30")).toBe("Unknown date");
    expect(formatCivilDate("1998-07-18T12:00:00Z")).toBe("Unknown date");
    expect(formatInstantDateTime("not-an-instant")).toBe("Unknown date and time");
    expect(formatOffsetWallTime(900_000_000, null)).toBeNull();
  });
});
