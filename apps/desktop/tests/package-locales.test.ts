import { LanguageTagSchema } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import {
  ELECTRON_LANGUAGES,
  ELECTRON_LOCALE_PACKS,
  MACOS_LOCALE_LPROJ_NAMES,
  WINDOWS_INSTALLER_LANGUAGES,
  WINDOWS_LOCALE_PAK_PATHS,
  macosLocaleLprojName,
} from "../scripts/package-locales.mjs";

const CHROMIUM_PACK_BY_TAG: Record<string, string> = {
  en: "en-US",
  "pt-PT": "pt-PT",
  "pt-BR": "pt-BR",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
};

describe("package locales", () => {
  it("ships one Chromium locale pack per supported language", () => {
    const expected = LanguageTagSchema.options.map((tag) => CHROMIUM_PACK_BY_TAG[tag] ?? tag);
    expect([...ELECTRON_LOCALE_PACKS]).toEqual(expected);
    expect([...WINDOWS_LOCALE_PAK_PATHS]).toEqual(expected.map((pack) => `locales/${pack}.pak`));
    expect([...MACOS_LOCALE_LPROJ_NAMES]).toEqual(expected.map((pack) => macosLocaleLprojName(pack)));
    expect(macosLocaleLprojName("en-US")).toBe("en.lproj");
    expect(macosLocaleLprojName("pt-PT")).toBe("pt_PT.lproj");
    expect(macosLocaleLprojName("zh-CN")).toBe("zh_CN.lproj");
  });

  it("lists regional packs in both the Windows and macOS spellings", () => {
    for (const pack of ELECTRON_LOCALE_PACKS) {
      expect(ELECTRON_LANGUAGES).toContain(pack);
      if (pack.includes("-") && pack !== "en-US") {
        expect(ELECTRON_LANGUAGES).toContain(pack.replace("-", "_"));
      }
    }
    expect(ELECTRON_LANGUAGES).not.toContain("en_US");
  });

  it("offers one installer language per supported language", () => {
    expect(WINDOWS_INSTALLER_LANGUAGES).toHaveLength(LanguageTagSchema.options.length);
    expect(new Set(WINDOWS_INSTALLER_LANGUAGES).size).toBe(LanguageTagSchema.options.length);
    for (const language of WINDOWS_INSTALLER_LANGUAGES)
      expect(language).toMatch(/^[a-z]{2}_[A-Z]{2}$/u);
  });
});
