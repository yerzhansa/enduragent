import type { ReactElement } from "react";
import { Card } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function SpendNotice(): ReactElement {
  const warning = useEnduragentStore((store) => store.settings.spend.warning);

  return (
    <Card
      id="spend-cap-warning"
      className="relative mb-2.5 gap-0 overflow-hidden py-2.5 pr-3 pl-[15px] shadow-elev-1 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-danger before:content-['']"
      role="status"
      aria-live="polite"
      hidden={warning === null}
    >
      {warning ?? ""}
    </Card>
  );
}
