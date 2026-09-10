import { describe, expect, it } from "vitest";
import { dateKeySchema, validateListRange } from "../src/agent/date-schema.js";

describe("dateKeySchema", () => {
  it("accepts the required shape and rejects alternate formats", () => {
    expect(dateKeySchema.safeParse("2026-07-10").success).toBe(true);
    for (const value of ["June 15", "2026-7-1", "20260710"]) {
      expect(dateKeySchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("validateListRange", () => {
  it("allows an inclusive 366-day range", () => {
    expect(validateListRange("2025-01-01", "2026-01-01", 366)).toBeNull();
  });

  it("refuses 367 days with chunking guidance", () => {
    const result = validateListRange("2025-01-01", "2026-01-02", 366);
    expect(result?.error).toBe("range_too_wide");
    expect(result?.details).toContain("367 days");
    expect(result?.details).toContain("chunks");
    expect(result?.details).toContain("366");
  });

  it("refuses swapped bounds", () => {
    expect(validateListRange("2026-07-11", "2026-07-10", 366)?.error).toBe("invalid_range");
  });

  it("refuses impossible dates", () => {
    expect(validateListRange("2026-02-31", "2026-03-01", 366)?.error).toBe("invalid_date");
    expect(validateListRange("2026-02-01", "2026-02-31", 366)?.error).toBe("invalid_date");
  });

  it("caps an omitted newest bound against today in UTC", () => {
    const oldest = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    expect(validateListRange(oldest, undefined, 366)?.error).toBe("range_too_wide");
  });
});
