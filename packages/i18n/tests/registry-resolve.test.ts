import { describe, expect, it } from "vitest";
import { LanguageTagSchema, type LanguageTag } from "@enduragent/coach-contract";
import {
  LANGUAGE_OPTIONS,
  describeLanguage,
  telegramRegistrationCodes,
  normalizeLocaleHint,
  resolveLanguage,
  msg,
} from "../src/index.js";

describe("language registry", () => {
  it("covers the contract in order with valid formatting locales", () => {
    expect(LANGUAGE_OPTIONS.map(({ tag }) => tag)).toEqual(LanguageTagSchema.options);
    for (const option of LANGUAGE_OPTIONS) {
      expect(describeLanguage(option.tag)).toEqual(option);
      expect(option.endonym.length).toBeGreaterThan(0);
      expect(option.englishName.length).toBeGreaterThan(0);
      expect(Intl.getCanonicalLocales(option.defaultLocale)).toEqual([option.defaultLocale]);
      expect(option.telegramCode).toMatch(/^[a-z]{2}$/);
    }
  });
  it("registers each Telegram code once using the first variant", () => {
    const codes = telegramRegistrationCodes();
    expect(codes).toHaveLength(15);
    expect(new Set(codes.map(({ code }) => code)).size).toBe(codes.length);
    expect(codes).toContainEqual({ code: "pt", representative: "pt-PT" });
    expect(codes).toContainEqual({ code: "zh", representative: "zh-Hans" });
  });
  it("creates minimal message values", () => {
    expect(msg("common.save")).toEqual({ key: "common.save" });
    expect(msg("settings.language.automaticDetail", { operatingSystem: "macOS" })).toEqual({
      key: "settings.language.automaticDetail",
      vars: { operatingSystem: "macOS" },
    });
  });
});

describe("locale normalization", () => {
  it.each([
    ["it_IT.UTF-8", "it"],
    ["C", undefined],
    ["C.UTF-8", undefined],
    ["POSIX", undefined],
    ["pt-br", "pt-BR"],
    ["nl-BE", "nl"],
    ["fr-BE", "fr"],
    ["de-BE", "de"],
    ["pt", "pt-PT"],
    ["zh", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-Hans-TW", "zh-Hans"],
    ["zh-Hant-CN", "zh-Hant"],
    ["no", "nb"],
    ["nn", "nb"],
    ["en_US:en", "en"],
    ["ru_RU:fr_FR:en", "fr"],
    ["it_IT.UTF-8@euro", "it"],
    ["xx", undefined],
    ["", undefined],
  ])("normalizes %s", (hint, expected) => {
    expect(normalizeLocaleHint(hint)).toBe(expected);
  });
  it("selects the first supported array or colon-list entry", () => {
    expect(normalizeLocaleHint(["ru", "fr-BE", "it"])).toBe("fr");
    expect(normalizeLocaleHint(["C:xx", "pt-br:en"])).toBe("pt-BR");
    expect(normalizeLocaleHint([])).toBeUndefined();
    expect(normalizeLocaleHint(null)).toBeUndefined();
    expect(normalizeLocaleHint(undefined)).toBeUndefined();
  });
  it.each(LanguageTagSchema.options)("round trips %s", (tag) => {
    expect(normalizeLocaleHint(tag)).toBe(tag);
  });
});

describe("language resolution", () => {
  for (const saved of [null, "it"] satisfies (LanguageTag | null)[]) {
    for (const messageLanguageHint of [undefined, "fr"] satisfies (LanguageTag | undefined)[]) {
      for (const surfaceLanguage of [undefined, "nl"] satisfies (LanguageTag | undefined)[]) {
        it(`resolves saved=${saved}, message=${messageLanguageHint}, surface=${surfaceLanguage}`, () => {
          const result = resolveLanguage({
            saved,
            messageLanguageHint,
            surfaceHint: { language: surfaceLanguage, locale: "de-BE" },
          });
          expect(result).toEqual({
            language: saved ?? messageLanguageHint ?? surfaceLanguage ?? "en",
            source: saved
              ? "preference"
              : messageLanguageHint
                ? "message"
                : surfaceLanguage
                  ? "surface"
                  : "default",
            locale: "de-BE",
          });
        });
      }
    }
  }
  it.each(LanguageTagSchema.options)(
    "uses %s default locale only when no surface locale exists",
    (tag) => {
      expect(
        resolveLanguage({
          saved: tag,
          messageLanguageHint: undefined,
          surfaceHint: { language: undefined, locale: undefined },
        }).locale,
      ).toBe(describeLanguage(tag).defaultLocale);
    },
  );
});
