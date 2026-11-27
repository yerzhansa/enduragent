import { cn } from "@enduragent/ui";
import type { ReactElement } from "react";

export function SettingSwitch(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        "relative h-5 w-8.5 flex-none rounded-full transition-colors disabled:opacity-60",
        props.checked ? "bg-brand" : "bg-line-2",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.75 left-0.75 size-3.5 rounded-full bg-surface transition-transform",
          props.checked && "translate-x-3.5",
        )}
      />
    </button>
  );
}
