import { LanguageTagSchema } from "@enduragent/coach-contract";
import { LANGUAGE_OPTIONS } from "@enduragent/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store";
import { settingsStyles as styles } from "./styles";

const ITEMS = [
  { value: "automatic", label: "Automatic" },
  ...LANGUAGE_OPTIONS.map(({ tag, endonym }) => ({ value: tag, label: endonym })),
];

export function LanguageControl(): ReactElement {
  const language = useEnduragentStore((store) => store.settings.language);
  const port = useEnduragentStore((store) => store.settingsPorts?.language ?? null);
  const disabled = port === null || language.status === "loading" || language.status === "saving";

  return (
    <Select
      items={ITEMS}
      value={language.value ?? "automatic"}
      disabled={disabled}
      onValueChange={(value) => {
        if (value === null) return;
        port?.set(value === "automatic" ? null : LanguageTagSchema.parse(value));
      }}
    >
      <SelectTrigger className={styles.control} aria-label="Language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {ITEMS.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
