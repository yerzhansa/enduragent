import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import type { Appearance } from "@enduragent/ui";

const OPTIONS: readonly { readonly value: Appearance; readonly label: string }[] = Object.freeze([
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]);

export function AppearanceControl(): ReactElement {
  const appearance = useEnduragentStore((state) => state.appearance);
  const setAppearance = useEnduragentStore((state) => state.setAppearance);

  return (
    <div
      className="flex shrink-0 rounded-ctl border border-line bg-sunk p-0.5"
      role="group"
      aria-label="Appearance"
    >
      {OPTIONS.map((option) => (
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
