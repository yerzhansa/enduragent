import { describe, expect, it, vi } from "vitest";
import { readPreferredSystemLanguages } from "../src/main/system-languages.js";

describe("preferred system languages", () => {
  it("returns the languages the system reports", () => {
    const getPreferredSystemLanguages = vi.fn(() => ["en-US", "de-DE"]);

    expect(readPreferredSystemLanguages({ getPreferredSystemLanguages })).toEqual([
      "en-US",
      "de-DE",
    ]);
    expect(getPreferredSystemLanguages).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns no languages when the system lookup throws", () => {
    const getPreferredSystemLanguages = vi.fn((): string[] => {
      throw new Error("synthetic language lookup failure");
    });

    expect(readPreferredSystemLanguages({ getPreferredSystemLanguages })).toEqual([]);
    expect(getPreferredSystemLanguages).toHaveBeenCalledOnce();
  });
});
