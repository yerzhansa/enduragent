import type { ReactElement } from "react";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import type { Appearance } from "@enduragent/ui";

export function AppearanceControl(): ReactElement {
  const { say } = usePhrasebook();
  const options: readonly { readonly value: Appearance; readonly label: string }[] = [
    { value: "system", label: say("settings.appearance.system") },
    { value: "light", label: say("settings.appearance.light") },
    { value: "dark", label: say("settings.appearance.dark") },
  ];
  const appearance = useEnduragentStore((state) => state.appearance);
  const setAppearance = useEnduragentStore((state) => state.setAppearance);

  return (
    <div
      className="flex shrink-0 rounded-ctl border border-line bg-sunk p-0.5"
      role="group"
      aria-label={say("settings.appearance.title")}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="ghost"
          size="sm"
          className="text-ink-2 hover:text-ink aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-elev-1"
          aria-pressed={option.value === appearance}
          onClick={() => {
            setAppearance(option.value);
          }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
