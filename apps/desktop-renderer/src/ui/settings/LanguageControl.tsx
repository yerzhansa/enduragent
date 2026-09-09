import { LanguageTagSchema } from "@enduragent/coach-contract";
import { LANGUAGE_OPTIONS } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store";
import { settingsStyles as styles } from "./styles";

export function LanguageControl(): ReactElement {
  const { say } = usePhrasebook();
  const items = [
    { value: "automatic", label: say("common.automatic") },
    ...LANGUAGE_OPTIONS.map(({ tag, endonym }) => ({ value: tag, label: endonym })),
  ];
  const language = useEnduragentStore((store) => store.settings.language);
  const port = useEnduragentStore((store) => store.settingsPorts?.language ?? null);
  const disabled = port === null || language.status === "loading" || language.status === "saving";

  return (
    <Select
      items={items}
      value={language.value ?? "automatic"}
      disabled={disabled}
      onValueChange={(value) => {
        if (value === null) return;
        port?.set(value === "automatic" ? null : LanguageTagSchema.parse(value));
      }}
    >
      <SelectTrigger className={styles.control} aria-label={say("settings.language.title")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {items.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
