import type { LanguageTag } from "@enduragent/coach-contract";
import { describeLanguage, normalizeLocaleHint } from "@enduragent/i18n";
import { setupDisposition } from "./state/onboarding-slice";
import type { EnduragentState } from "./state/store";

export function resolvedLanguageTag(state: Pick<EnduragentState, "settings">): LanguageTag {
  const language = state.settings.language;
  const fallback = normalizeLocaleHint(navigator.languages) ?? "en";
  return language.status === "loading" ? fallback : (language.value ?? fallback);
}

export function rendererLocale(tag: LanguageTag): string {
  try {
    const locale = Intl.getCanonicalLocales(navigator.language.trim().replaceAll("_", "-"))[0];
    if (locale !== undefined) return locale;
  } catch {}
  return describeLanguage(tag).defaultLocale;
}

export function languageRequired(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return (
    setupDisposition(state) === "required" &&
    (state.settings.language.status === "ready" || state.settings.language.status === "saving") &&
    state.settings.language.value === null &&
    normalizeLocaleHint(navigator.languages) === undefined
  );
}
