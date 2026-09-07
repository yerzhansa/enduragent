import { describe, expect, it } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  readStoredAppearance,
  readStoredPaletteId,
  writeStoredAppearance,
  writeStoredPaletteId,
} from "../src/theme/preferences";

describe("theme preferences", () => {
  it("round-trips the palette and appearance through localStorage", () => {
    expect(readStoredPaletteId()).toBe("patrol");
    expect(readStoredAppearance()).toBe("system");

    writeStoredPaletteId("velodrome");
    writeStoredAppearance("dark");

    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("velodrome");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(readStoredPaletteId()).toBe("velodrome");
    expect(readStoredAppearance()).toBe("dark");
  });

  it("falls back to the defaults when the stored values are unknown", () => {
    localStorage.setItem(PALETTE_STORAGE_KEY, "synthetic-missing-palette");
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "synthetic-missing-appearance");

    expect(readStoredPaletteId()).toBe("patrol");
    expect(readStoredAppearance()).toBe("system");
  });
});
