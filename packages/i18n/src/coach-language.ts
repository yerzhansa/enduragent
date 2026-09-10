import type { LanguageTag } from "@enduragent/coach-contract";
import { detectMessageLanguage } from "./detect-message-language.js";
import { LANGUAGE_OPTIONS, describeLanguage, type LanguageDescription } from "./registry.js";
import { resolveLanguage, type LanguageResolution, type SurfaceHint } from "./resolve.js";
import type { Phrasebook } from "./messages.js";

export interface LanguageInput {
  readonly chatId?: string;
  readonly athleteText?: string;
  readonly surfaceHint?: SurfaceHint;
}

export type PhrasebookLoader = (input: {
  readonly tag: LanguageTag;
  readonly locale: string;
}) => Promise<Phrasebook>;

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
  resolveFor(input: LanguageInput): Promise<LanguageResolution>;
  phrasebookFor(input: LanguageInput): Promise<Phrasebook>;
  current(): Promise<StoredLanguagePreference & { readonly resolved: LanguageResolution }>;
  set(value: LanguageTag | null): Promise<StoredLanguagePreference>;
}

export function createCoachLanguage(input: {
  readonly store: LanguagePreferenceStore;
  readonly surface: SurfaceHint;
  readonly phrasebooks: PhrasebookLoader;
}): CoachLanguage {
  const phrasebooks = new Map<string, Promise<Phrasebook>>();
  const load = (tag: LanguageTag, locale: string): Promise<Phrasebook> => {
    const key = JSON.stringify([tag, locale]);
    const cached = phrasebooks.get(key);
    if (cached !== undefined) return cached;
    const pending = input.phrasebooks({ tag, locale });
    phrasebooks.set(key, pending);
    void pending.catch(() => {
      if (phrasebooks.get(key) === pending) phrasebooks.delete(key);
    });
    return pending;
  };
  const language: CoachLanguage = {
    options: LANGUAGE_OPTIONS,
    async resolveFor({ athleteText, surfaceHint }) {
      const saved = await input.store.read();
      return resolveLanguage({
        saved: saved.value,
        messageLanguageHint:
          saved.value === null && athleteText !== undefined
            ? detectMessageLanguage(athleteText)
            : undefined,
        surfaceHint: surfaceHint ?? input.surface,
      });
    },
    async phrasebookFor(request) {
      const resolved = await language.resolveFor(request).catch(() => ({
        language: "en" as LanguageTag,
        locale: describeLanguage("en").defaultLocale,
      }));
      const { language: tag, locale } = resolved;
      try {
        return await load(tag, locale);
      } catch (error) {
        if (tag === "en") throw error;
        return load("en", describeLanguage("en").defaultLocale);
      }
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
  return language;
}
