import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPhrasebook, type Phrasebook } from "./messages.js";

type LanguageProviderProps = Parameters<typeof createPhrasebook>[0] & {
  readonly children: ReactNode;
};

type LanguageState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly phrasebook: Phrasebook }
  | { readonly kind: "failed"; readonly error: unknown };

const LanguageContext = createContext<{
  readonly phrasebook: Phrasebook;
  readonly ready: boolean;
} | null>(null);

export function LanguageProvider({ tag, locale, children }: LanguageProviderProps) {
  const [state, setState] = useState<LanguageState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void createPhrasebook({ tag, locale }).then(
      (phrasebook) => {
        if (active) setState({ kind: "ready", phrasebook });
      },
      (error: unknown) => {
        if (active) setState({ kind: "failed", error });
      },
    );
    return () => {
      active = false;
    };
  }, [tag, locale]);

  if (state.kind === "failed") throw state.error;
  if (state.kind === "loading") return null;

  return (
    <LanguageContext.Provider
      value={{
        phrasebook: state.phrasebook,
        ready: state.phrasebook.tag === tag && state.phrasebook.locale === locale,
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function usePhrasebook(): Phrasebook {
  const context = useContext(LanguageContext);
  if (context === null) throw new Error("usePhrasebook requires a LanguageProvider");
  return context.phrasebook;
}

export function useLanguageReady(): boolean {
  return useContext(LanguageContext)?.ready ?? false;
}
