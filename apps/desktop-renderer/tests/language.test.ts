import type { LanguageTag } from "@enduragent/coach-contract";
import { describeLanguage } from "@enduragent/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { languageRequired, rendererLocale, resolvedLanguageTag } from "../src/language";
import type { LanguagePreferenceViewState } from "../src/settings/language-controller";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";

afterEach(() => vi.unstubAllGlobals());

describe("renderer language", () => {
  it.each([
    { saved: "ja", languages: ["it-IT"], expected: "ja" },
    { saved: null, languages: ["it-IT"], expected: "it" },
    { saved: null, languages: ["uk"], expected: "en" },
    { saved: null, languages: ["uk", "ja-JP"], expected: "ja" },
    { saved: null, languages: [], expected: "en" },
  ] satisfies { saved: LanguageTag | null; languages: string[]; expected: LanguageTag }[])(
    "resolves $saved with $languages to $expected",
    ({ saved, languages, expected }) => {
      vi.stubGlobal("navigator", { languages });
      expect(
        resolvedLanguageTag({
          settings: { ...EMPTY_SETTINGS_SURFACE, language: { status: "ready", value: saved } },
        }),
      ).toBe(expected);
    },
  );

  it("uses the OS fallback until the preference first loads", () => {
    vi.stubGlobal("navigator", { languages: ["it-IT"] });
    expect(
      resolvedLanguageTag({
        settings: { ...EMPTY_SETTINGS_SURFACE, language: { status: "loading", value: null } },
      }),
    ).toBe("it");
  });

  it.each(["saving", "unavailable"] as const)("keeps the saved language while %s", (status) => {
    vi.stubGlobal("navigator", { languages: ["it-IT"] });
    expect(
      resolvedLanguageTag({
        settings: { ...EMPTY_SETTINGS_SURFACE, language: { status, value: "ja" } },
      }),
    ).toBe("ja");
  });

  it.each([
    { language: { status: "loading", value: null }, languages: ["uk"], expected: false },
    { language: { status: "unavailable", value: null }, languages: ["uk"], expected: false },
    { language: { status: "ready", value: null }, languages: ["uk"], expected: true },
    { language: { status: "saving", value: null }, languages: ["uk"], expected: true },
    { language: { status: "ready", value: "it" }, languages: ["uk"], expected: false },
    { language: { status: "ready", value: null }, languages: ["it-IT"], expected: false },
  ] satisfies {
    language: LanguagePreferenceViewState;
    languages: string[];
    expected: boolean;
  }[])(
    "requires the language screen only for a ready null preference and an unsupported OS ($language.status, $language.value, $languages)",
    ({ language, languages, expected }) => {
      vi.stubGlobal("navigator", { languages });
      expect(
        languageRequired({
          onboarding: { ...READY_ONBOARDING, completionRequired: true },
          settings: { ...EMPTY_SETTINGS_SURFACE, language },
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["en_us", "en-US"],
    ["it-it", "it-IT"],
    ["uk-UA", "uk-UA"],
    ["", describeLanguage("ja").defaultLocale],
    ["invalid locale", describeLanguage("ja").defaultLocale],
  ])("normalizes locale %s to %s independently of the language", (language, expected) => {
    vi.stubGlobal("navigator", { language });
    expect(rendererLocale("ja")).toBe(expected);
  });
});
