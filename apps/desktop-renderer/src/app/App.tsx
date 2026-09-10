import { useEffect, type ReactElement } from "react";
import { useEnduragentStore } from "../state/store";
import { DARK_MEDIA_QUERY } from "@enduragent/ui";
import { Shell } from "./Shell";
import { LanguageProvider } from "@enduragent/i18n/react";
import { rendererLocale, resolvedLanguageTag } from "../language";

export function App(props: { readonly onReady: () => void }): ReactElement {
  const appearance = useEnduragentStore((state) => state.appearance);
  const refreshTheme = useEnduragentStore((state) => state.refreshTheme);
  const tag = useEnduragentStore(resolvedLanguageTag);

  useEffect(() => {
    document.documentElement.lang = tag;
  }, [tag]);

  useEffect(() => {
    if (appearance !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia(DARK_MEDIA_QUERY);
    const onChange = (): void => {
      refreshTheme();
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, [appearance, refreshTheme]);

  return (
    <LanguageProvider tag={tag} locale={rendererLocale(tag)}>
      <Shell onReady={props.onReady} />
    </LanguageProvider>
  );
}
