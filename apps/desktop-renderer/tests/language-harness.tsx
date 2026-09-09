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
