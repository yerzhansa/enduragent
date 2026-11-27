import { describe, expect, it } from "vitest";
import {
  macFirstWeekday,
  regionFirstDayArgument,
  regionFirstDayFromArguments,
  regionFirstDayOfWeek,
} from "../src/main/region-week.js";

describe("the region's first day of the week", () => {
  it.each([
    ["KZ", 1],
    ["DE", 1],
    ["GB", 1],
    ["RU", 1],
    ["US", 7],
    ["BR", 7],
    ["JP", 7],
    ["EG", 6],
    ["IR", 6],
  ] as const)("starts %s's weeks on day %i", (country, day) => {
    expect(regionFirstDayOfWeek(country)).toBe(day);
  });

  it("falls back to Monday for a missing or malformed country", () => {
    expect(regionFirstDayOfWeek("")).toBe(1);
    expect(regionFirstDayOfWeek("usa")).toBe(1);
  });

  it("carries the day to the window and reads it back", () => {
    expect(regionFirstDayArgument("US")).toBe("--enduragent-first-day=7");
    expect(regionFirstDayFromArguments(["/app", "--enduragent-first-day=6"])).toBe(6);
    expect(regionFirstDayFromArguments(["/app"])).toBe(1);
    expect(regionFirstDayFromArguments(["--enduragent-first-day=9"])).toBe(1);
  });

  it("takes the Mac's own first day of the week over the region when it is set", () => {
    expect(macFirstWeekday({ gregorian: 1 })).toBe(7);
    expect(macFirstWeekday({ gregorian: 2 })).toBe(1);
    expect(macFirstWeekday({ gregorian: 7 })).toBe(6);
    expect(macFirstWeekday({})).toBeNull();
    expect(macFirstWeekday({ gregorian: "2" })).toBeNull();
    expect(macFirstWeekday(null)).toBeNull();
    expect(regionFirstDayArgument("US", 1)).toBe("--enduragent-first-day=1");
    expect(regionFirstDayArgument("US", null)).toBe("--enduragent-first-day=7");
  });
});
