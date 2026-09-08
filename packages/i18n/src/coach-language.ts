import type { LanguageTag } from "@enduragent/coach-contract";
import { detectMessageLanguage } from "./detect-message-language.js";
import { LANGUAGE_OPTIONS, type LanguageDescription } from "./registry.js";
import { resolveLanguage, type LanguageResolution, type SurfaceHint } from "./resolve.js";

export interface StoredLanguagePreference {
  readonly value: LanguageTag | null;
  readonly origin: "stored" | "environment" | "unset";
  readonly variable?: string;
}

export interface LanguagePreferenceStore {
  read(): Promise<StoredLanguagePreference>;
  write(value: LanguageTag | null): Promise<StoredLanguagePreference>;
}

export interface CoachLanguage {
  readonly options: readonly LanguageDescription[];
  resolveFor(input: { readonly athleteText?: string }): Promise<LanguageResolution>;
  current(): Promise<StoredLanguagePreference & { readonly resolved: LanguageResolution }>;
  set(value: LanguageTag | null): Promise<StoredLanguagePreference>;
}

export function createCoachLanguage(input: {
  readonly store: LanguagePreferenceStore;
  readonly surface: SurfaceHint;
}): CoachLanguage {
  return {
    options: LANGUAGE_OPTIONS,
    async resolveFor({ athleteText }) {
      const saved = await input.store.read();
      return resolveLanguage({
        saved: saved.value,
        messageLanguageHint:
          saved.value === null && athleteText !== undefined
            ? detectMessageLanguage(athleteText)
            : undefined,
        surfaceHint: input.surface,
      });
    },
    async current() {
      const saved = await input.store.read();
      return {
        ...saved,
        resolved: resolveLanguage({
          saved: saved.value,
          messageLanguageHint: undefined,
          surfaceHint: input.surface,
        }),
      };
    },
    set: (value) => input.store.write(value),
  };
}
