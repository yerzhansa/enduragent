import type { UnitsPreference } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function UnitsControl(): ReactElement {
  const { say } = usePhrasebook();
  const options: readonly { readonly value: UnitsPreference; readonly label: string }[] = [
    { value: "metric", label: say("settings.units.metric") },
    { value: "imperial", label: say("settings.units.imperial") },
  ];
  const units = useEnduragentStore((store) => store.settings.units);
  const port = useEnduragentStore((store) => store.settingsPorts?.units ?? null);
  const disabled = port === null || units.status === "loading" || units.status === "saving";

  return (
    <div
      className="flex shrink-0 rounded-ctl border border-line bg-sunk p-0.5"
      role="group"
      aria-label={say("settings.units.displayUnits")}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="ghost"
          size="sm"
          className="text-ink-2 hover:text-ink aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-elev-1"
          aria-pressed={option.value === units.value}
          disabled={disabled}
          onClick={() => {
            port?.set(option.value);
          }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
