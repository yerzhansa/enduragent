import { createInstance } from "i18next";
import type { LanguageTag } from "@enduragent/coach-contract";
import type { CatalogKey } from "./catalog-keys.js";
import type { Message } from "./message.js";

export type { CatalogKey } from "./catalog-keys.js";
export type Catalog = { readonly [key: string]: string | Catalog };

export interface Phrasebook {
  readonly tag: LanguageTag;
  readonly locale: string;
  say(message: Message): string;
  say(key: CatalogKey, vars?: Message["vars"]): string;
  readonly format: {
    date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
    number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
    list(values: readonly string[], options?: Intl.ListFormatOptions): string;
    relativeDays(days: number): string;
  };
}

export async function loadCatalog(tag: LanguageTag): Promise<Catalog> {
  switch (tag) {
    case "en":
      return (await import("../catalogs/en.json", { with: { type: "json" } })).default;
    case "es":
      return (await import("../catalogs/es.json", { with: { type: "json" } })).default;
    case "fr":
      return (await import("../catalogs/fr.json", { with: { type: "json" } })).default;
    case "it":
      return (await import("../catalogs/it.json", { with: { type: "json" } })).default;
    case "de":
      return (await import("../catalogs/de.json", { with: { type: "json" } })).default;
    case "nl":
      return (await import("../catalogs/nl.json", { with: { type: "json" } })).default;
    case "da":
      return (await import("../catalogs/da.json", { with: { type: "json" } })).default;
    case "sv":
      return (await import("../catalogs/sv.json", { with: { type: "json" } })).default;
    case "nb":
      return (await import("../catalogs/nb.json", { with: { type: "json" } })).default;
    case "fi":
      return (await import("../catalogs/fi.json", { with: { type: "json" } })).default;
    case "pt-PT":
      return (await import("../catalogs/pt-PT.json", { with: { type: "json" } })).default;
    case "pt-BR":
      return (await import("../catalogs/pt-BR.json", { with: { type: "json" } })).default;
    case "pl":
      return (await import("../catalogs/pl.json", { with: { type: "json" } })).default;
    case "ko":
      return (await import("../catalogs/ko.json", { with: { type: "json" } })).default;
    case "ja":
      return (await import("../catalogs/ja.json", { with: { type: "json" } })).default;
    case "zh-Hans":
      return (await import("../catalogs/zh-Hans.json", { with: { type: "json" } })).default;
    case "zh-Hant":
      return (await import("../catalogs/zh-Hant.json", { with: { type: "json" } })).default;
    default: {
      const exhaustive: never = tag;
      throw new Error(`Unsupported language: ${exhaustive}`);
    }
  }
}

export async function createPhrasebook(input: {
  readonly tag: LanguageTag;
  readonly locale: string;
}): Promise<Phrasebook> {
  const { tag, locale } = input;
  const [english, catalog] = await Promise.all([loadCatalog("en"), loadCatalog(tag)]);
  const instance = createInstance();
  await instance.init({
    lng: tag,
    initImmediate: false,
    fallbackLng: "en",
    load: "currentOnly",
    resources: { en: { translation: english }, [tag]: { translation: catalog } },
    keySeparator: ".",
    nsSeparator: false,
    interpolation: { escapeValue: false },
  });
  const translate = instance.getFixedT(tag, "translation");
  return {
    tag,
    locale,
    say(message: Message | CatalogKey, vars?: Message["vars"]) {
      const key = typeof message === "string" ? message : message.key;
      const values = typeof message === "string" ? vars : message.vars;
      return translate(key, { interpolation: { escapeValue: false }, replace: values });
    },
    format: {
      date: (value, options) => new Intl.DateTimeFormat(locale, options).format(value),
      number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
      list: (values, options) => new Intl.ListFormat(locale, options).format(values),
      relativeDays: (days) =>
        new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day"),
    },
  };
}
