import { LanguageTagSchema, type LanguageTag } from "@enduragent/coach-contract";

export interface LanguageDescription {
  readonly tag: LanguageTag;
  readonly endonym: string;
  readonly englishName: string;
  readonly telegramCode: string;
  readonly defaultLocale: string;
}

const REGISTRY: Readonly<Record<LanguageTag, LanguageDescription>> = {
  en: {
    tag: "en",
    endonym: "English",
    englishName: "English",
    telegramCode: "en",
    defaultLocale: "en-GB",
  },
  es: {
    tag: "es",
    endonym: "Español",
    englishName: "Spanish",
    telegramCode: "es",
    defaultLocale: "es-ES",
  },
  fr: {
    tag: "fr",
    endonym: "Français",
    englishName: "French",
    telegramCode: "fr",
    defaultLocale: "fr-FR",
  },
  it: {
    tag: "it",
    endonym: "Italiano",
    englishName: "Italian",
    telegramCode: "it",
    defaultLocale: "it-IT",
  },
  de: {
    tag: "de",
    endonym: "Deutsch",
    englishName: "German",
    telegramCode: "de",
    defaultLocale: "de-DE",
  },
  nl: {
    tag: "nl",
    endonym: "Nederlands",
    englishName: "Dutch",
    telegramCode: "nl",
    defaultLocale: "nl-NL",
  },
  da: {
    tag: "da",
    endonym: "Dansk",
    englishName: "Danish",
    telegramCode: "da",
    defaultLocale: "da-DK",
  },
  sv: {
    tag: "sv",
    endonym: "Svenska",
    englishName: "Swedish",
    telegramCode: "sv",
    defaultLocale: "sv-SE",
  },
  nb: {
    tag: "nb",
    endonym: "Norsk bokmål",
    englishName: "Norwegian Bokmål",
    telegramCode: "nb",
    defaultLocale: "nb-NO",
  },
  fi: {
    tag: "fi",
    endonym: "Suomi",
    englishName: "Finnish",
    telegramCode: "fi",
    defaultLocale: "fi-FI",
  },
  "pt-PT": {
    tag: "pt-PT",
    endonym: "Português (Portugal)",
    englishName: "Portuguese (Portugal)",
    telegramCode: "pt",
    defaultLocale: "pt-PT",
  },
  "pt-BR": {
    tag: "pt-BR",
    endonym: "Português (Brasil)",
    englishName: "Portuguese (Brazil)",
    telegramCode: "pt",
    defaultLocale: "pt-BR",
  },
  pl: {
    tag: "pl",
    endonym: "Polski",
    englishName: "Polish",
    telegramCode: "pl",
    defaultLocale: "pl-PL",
  },
  ko: {
    tag: "ko",
    endonym: "한국어",
    englishName: "Korean",
    telegramCode: "ko",
    defaultLocale: "ko-KR",
  },
  ja: {
    tag: "ja",
    endonym: "日本語",
    englishName: "Japanese",
    telegramCode: "ja",
    defaultLocale: "ja-JP",
  },
  "zh-Hans": {
    tag: "zh-Hans",
    endonym: "简体中文",
    englishName: "Simplified Chinese",
    telegramCode: "zh",
    defaultLocale: "zh-Hans-CN",
  },
  "zh-Hant": {
    tag: "zh-Hant",
    endonym: "繁體中文",
    englishName: "Traditional Chinese",
    telegramCode: "zh",
    defaultLocale: "zh-Hant-TW",
  },
};

export const LANGUAGE_OPTIONS: readonly LanguageDescription[] = LanguageTagSchema.options.map(
  (tag) => REGISTRY[tag],
);

export function describeLanguage(tag: LanguageTag): LanguageDescription {
  return REGISTRY[tag];
}

export function telegramRegistrationCodes(): readonly {
  code: string;
  representative: LanguageTag;
}[] {
  const seen = new Set<string>();
  return LANGUAGE_OPTIONS.flatMap(({ tag, telegramCode }) => {
    if (seen.has(telegramCode)) return [];
    seen.add(telegramCode);
    return [{ code: telegramCode, representative: tag }];
  });
}
