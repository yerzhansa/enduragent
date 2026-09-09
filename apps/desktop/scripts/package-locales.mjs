export const ELECTRON_LOCALE_PACKS = Object.freeze([
  "en-US",
  "es",
  "fr",
  "it",
  "de",
  "nl",
  "da",
  "sv",
  "nb",
  "fi",
  "pt-PT",
  "pt-BR",
  "pl",
  "ko",
  "ja",
  "zh-CN",
  "zh-TW",
]);

export const ELECTRON_LANGUAGES = Object.freeze(
  ELECTRON_LOCALE_PACKS.flatMap((pack) =>
    pack.includes("-") && pack !== "en-US" ? [pack, pack.replace("-", "_")] : [pack],
  ),
);

export const WINDOWS_INSTALLER_LANGUAGES = Object.freeze([
  "en_US",
  "es_ES",
  "fr_FR",
  "it_IT",
  "de_DE",
  "nl_NL",
  "da_DK",
  "sv_SE",
  "nb_NO",
  "fi_FI",
  "pt_PT",
  "pt_BR",
  "pl_PL",
  "ko_KR",
  "ja_JP",
  "zh_CN",
  "zh_TW",
]);

export const WINDOWS_LOCALE_PAK_PATHS = Object.freeze(
  ELECTRON_LOCALE_PACKS.map((pack) => `locales/${pack}.pak`),
);
