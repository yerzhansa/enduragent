import type { LanguageTag } from "@enduragent/coach-contract";
import { LANGUAGE_OPTIONS } from "@enduragent/i18n";
import { LanguageProvider, useLanguageReady, usePhrasebook } from "@enduragent/i18n/react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@enduragent/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { rendererLocale } from "../../language";
import { useEnduragentStore } from "../../state/store";
import { SetupCard } from "./SetupCard";

const ITEMS = LANGUAGE_OPTIONS.map(({ tag, endonym }) => ({ value: tag, label: endonym }));

export function LanguageGate(): ReactElement {
  const [tag, setTag] = useState<LanguageTag>("en");

  return (
    <LanguageProvider tag={tag} locale={rendererLocale(tag)}>
      <LanguageChoice tag={tag} onChange={setTag} />
    </LanguageProvider>
  );
}

function LanguageChoice(props: {
  readonly tag: LanguageTag;
  readonly onChange: (tag: LanguageTag) => void;
}): ReactElement {
  const { say, tag } = usePhrasebook();
  const ready = useLanguageReady();
  const status = useEnduragentStore((state) => state.settings.language.status);
  const port = useEnduragentStore((state) => state.settingsPorts?.language ?? null);
  const title = useRef<HTMLHeadingElement>(null);
  const disabled = port === null || status === "loading" || status === "saving";

  useEffect(() => {
    title.current?.focus();
  }, []);

  return (
    <main aria-labelledby="language-title" lang={tag}>
      <div className="setup-panel absolute top-1/2 left-1/2 w-[min(420px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2">
        <header className="mb-[22px] flex justify-center">
          <h1
            id="language-title"
            ref={title}
            tabIndex={-1}
            className="text-center text-2xl leading-8 font-semibold tracking-tight outline-none"
          >
            {say("language.chooseTitle")}
          </h1>
        </header>
        <SetupCard>
          <div className="p-4">
            <Select<LanguageTag>
              items={ITEMS}
              value={props.tag}
              disabled={disabled}
              onValueChange={(value) => {
                if (value !== null) props.onChange(value);
              }}
            >
              <SelectTrigger aria-label={say("settings.language.title")} className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ITEMS.map(({ value, label }) => (
                  <SelectItem key={value} value={value} lang={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end border-t border-line p-4">
            <Button
              type="button"
              disabled={disabled || !ready}
              onClick={() => port?.set(props.tag)}
            >
              {say("language.continue")}
            </Button>
          </div>
        </SetupCard>
      </div>
    </main>
  );
}
