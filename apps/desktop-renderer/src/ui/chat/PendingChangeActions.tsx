import type { PlanChangeModel } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store";

export function PendingChangeActions(props: {
  readonly change: PlanChangeModel;
  readonly navigationKey: string | undefined;
  readonly busy: boolean;
  readonly paused: boolean;
  readonly pausedReason: string | undefined;
}): ReactElement {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((store) => store.chatActions);
  const leftoverFtp = props.change.intent.kind === "ftp";
  return (
    <>
      <div
        className="mt-row flex flex-wrap gap-inset"
        data-pending-navigation-source={props.navigationKey}
      >
        <Button
          variant="outline"
          className="border-line bg-surface"
          disabled={props.busy || actions === null}
          onClick={() => actions?.applyPlanChange("cancel")}
        >
          {say("common.cancel")}
        </Button>
        {leftoverFtp ? null : (
          <Button
            disabled={props.paused || props.busy || actions === null}
            aria-describedby={props.pausedReason}
            onClick={() => actions?.applyPlanChange("apply")}
          >
            {say("chat.planChange.apply")}
          </Button>
        )}
      </div>
      {leftoverFtp ? (
        <p className="m-0 text-xs text-ink-2">{say("chat.planChange.ftpElsewhere")}</p>
      ) : null}
    </>
  );
}
