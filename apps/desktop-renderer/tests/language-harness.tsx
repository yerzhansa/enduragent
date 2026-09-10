import { createPhrasebook, type Catalog, type Phrasebook } from "@enduragent/i18n/messages";
import type { CatalogKey, Message } from "@enduragent/i18n";
import { LanguageProvider } from "@enduragent/i18n/react";
import { render, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { expect } from "vitest";
import { rendererLocale, resolvedLanguageTag } from "../src/language";
import { useEnduragentStore } from "../src/state/store";

function TestLanguageProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const tag = useEnduragentStore(resolvedLanguageTag);
  return (
    <LanguageProvider tag={tag} locale={rendererLocale(tag)}>
      {children}
    </LanguageProvider>
  );
}

export async function renderWithLanguage(element: ReactElement): Promise<RenderResult> {
  const view = render(element, { wrapper: TestLanguageProvider });
  await waitFor(() => expect(view.container.firstChild).not.toBeNull());
  return view;
}

const englishPhrasebook = await createPhrasebook({ tag: "en", locale: "en-US" });

export function renderLocalized(element: ReactElement, locale = "en-US"): RenderResult {
  const phrasebook: Phrasebook = {
    ...englishPhrasebook,
    locale,
    format: {
      ...englishPhrasebook.format,
      date: (value, options) => new Intl.DateTimeFormat(locale, options).format(value),
      number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    },
  };
  return render(element, {
    wrapper: ({ children }) => (
      <LanguageProvider tag="en" locale={locale} phrasebook={phrasebook}>
        {children}
      </LanguageProvider>
    ),
  });
}

export async function renderWithCatalog(
  element: ReactElement,
  catalog: Catalog,
): Promise<RenderResult> {
  const fallback = await createPhrasebook({ tag: "it", locale: "it-IT" });
  const find = (key: string): string | undefined => {
    let value: string | Catalog = catalog;
    for (const part of key.split(".")) {
      if (typeof value === "string" || value[part] === undefined) return undefined;
      value = value[part];
    }
    return typeof value === "string" ? value : undefined;
  };
  const phrasebook: Phrasebook = {
    ...fallback,
    say(message: Message | CatalogKey, vars?: Message["vars"]) {
      const key = typeof message === "string" ? message : message.key;
      const values = typeof message === "string" ? vars : message.vars;
      const count = values?.count;
      const translated =
        typeof count === "number"
          ? (find(`${key}_${new Intl.PluralRules("it-IT").select(count)}`) ?? find(key))
          : find(key);
      return translated !== undefined
        ? translated.replace(/\{\{(\w+)\}\}/gu, (_, name: string) => String(values?.[name] ?? ""))
        : typeof message === "string"
          ? fallback.say(message, vars)
          : fallback.say(message);
    },
  };
  const view = render(element, {
    wrapper: ({ children }) => (
      <LanguageProvider tag="it" locale="it-IT" phrasebook={phrasebook}>
        {children}
      </LanguageProvider>
    ),
  });
  return view;
}
