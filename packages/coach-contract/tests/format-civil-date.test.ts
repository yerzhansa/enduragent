import { describe, expect, it } from "vitest";
import { formatCivilDate } from "../src/format-civil-date.js";

describe("formatCivilDate", () => {
  it("formats civil dates in en-GB without shifting the day", () => {
    expect(formatCivilDate("1998-10-04")).toBe("4 Oct 1998");
    expect(formatCivilDate("1998-09-14")).toBe("14 Sept 1998");
  });

  it.each(["1998-02-30", "1998-13-01", "04/10/1998", "invalid"])(
    "rejects an invalid civil date: %s",
    (value) => expect(formatCivilDate(value)).toBe("Unknown date"),
  );

  it("supports explicit date fields", () => {
    expect(formatCivilDate("1998-10-04", { weekday: "short" })).toBe("Sun");
  });
});
