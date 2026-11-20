import type { App } from "electron";

export type PreferredSystemLanguagesPort = Pick<App, "getPreferredSystemLanguages">;

export function readPreferredSystemLanguages(
  source: PreferredSystemLanguagesPort,
): readonly string[] {
  try {
    return source.getPreferredSystemLanguages();
  } catch {
    return [];
  }
}
