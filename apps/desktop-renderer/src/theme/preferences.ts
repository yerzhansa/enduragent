import type { Appearance } from "@enduragent/ui";
import { DEFAULT_PALETTE_ID, PALETTES } from "@enduragent/ui";

export const PALETTE_STORAGE_KEY = "enduragent.ui.palette";
export const APPEARANCE_STORAGE_KEY = "enduragent.ui.appearance";

const APPEARANCES: readonly Appearance[] = ["light", "dark", "system"];

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    return;
  }
}

export function readStoredPaletteId(): string {
  const stored = read(PALETTE_STORAGE_KEY);
  return PALETTES.some((palette) => palette.id === stored) && stored !== null
    ? stored
    : DEFAULT_PALETTE_ID;
}

export function writeStoredPaletteId(id: string): void {
  write(PALETTE_STORAGE_KEY, id);
}

export function readStoredAppearance(): Appearance {
  const stored = read(APPEARANCE_STORAGE_KEY);
  return APPEARANCES.find((value) => value === stored) ?? "system";
}

export function writeStoredAppearance(appearance: Appearance): void {
  write(APPEARANCE_STORAGE_KEY, appearance);
}
