import { usePhrasebook } from "@enduragent/i18n/react";
import { spendWarningMessage } from "./copy";
import type { ReactElement } from "react";
import { Card } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function SpendNotice(): ReactElement {
  const { say, format } = usePhrasebook();
  const warning = useEnduragentStore((store) => store.settings.spend.warning);
  const summary = useEnduragentStore((store) => store.settings.spend.summary);
  const amount =
    summary === null
      ? undefined
      : format.number(
          summary.dailyCapUsd > 0 && summary.dailyCapUsd < 0.01
            ? 0.01
            : Number(summary.dailyCapUsd.toFixed(2)),
          {
            style: "currency",
            currency: "USD",
            currencyDisplay: "narrowSymbol",
            useGrouping: false,
          },
        );
  const formattedAmount =
    amount !== undefined &&
    summary !== null &&
    summary.dailyCapUsd > 0 &&
    summary.dailyCapUsd < 0.01
      ? say("chat.spend.belowAmount", { amount })
      : amount;
  const message = warning === null ? null : spendWarningMessage(warning, formattedAmount);

  return (
    <Card
      id="spend-cap-warning"
      className="relative mb-2.5 gap-0 overflow-hidden py-2.5 pr-3 pl-[15px] shadow-elev-1 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-danger before:content-['']"
      role="status"
      aria-live="polite"
      hidden={warning === null}
    >
      {message === null ? (warning ?? "") : say(message)}
    </Card>
  );
}
