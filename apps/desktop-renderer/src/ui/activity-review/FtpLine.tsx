import type { PlanCalendarRide } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import type { ReactElement } from "react";
import { registerFtpOpener } from "../../activity-review/ftp-opener";
import { useEnduragentStore } from "../../state/store";
import { useFtpText } from "./ftp-text";

function RideFtpText(props: { readonly ride: PlanCalendarRide }): ReactElement {
  const { say } = usePhrasebook();
  const text = useFtpText();
  const ftp = props.ride.ftp;
  if (ftp.kind === "unknown") return <span>{say("activity.review.ftp.lineNone")}</span>;
  const watts = text.watts(ftp.watts);
  if (ftp.use === "indoor") {
    return (
      <span className="flex flex-col gap-0.5" data-ftp-indoor="">
        <span>
          <strong className="text-sm text-ink">
            {say("activity.review.ftp.indoorWatts", { watts })}
          </strong>{" "}
          {say("activity.review.ftp.indoorSource", { source: text.rideSource(ftp) })}
        </span>
        {ftp.outdoorWatts === null ? null : (
          <span>
            {say("activity.review.ftp.outdoorUses", { watts: text.watts(ftp.outdoorWatts) })}
          </span>
        )}
      </span>
    );
  }
  const targets = props.ride.match.kind === "confirmed";
  if (ftp.setBy === "unknown") {
    return (
      <span>
        {targets
          ? say("activity.review.ftp.lineTargetsFrom", { watts })
          : say("activity.review.ftp.lineFrom", { watts })}
      </span>
    );
  }
  const values = { watts, source: text.rideSource(ftp) };
  return (
    <span>
      {targets
        ? say("activity.review.ftp.lineTargets", values)
        : say("activity.review.ftp.line", values)}
    </span>
  );
}

export function RideFtpLine(props: { readonly ride: PlanCalendarRide }): ReactElement {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((store) => store.ftpActions);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2" data-ride-ftp="">
      <RideFtpText ride={props.ride} />
      <Button
        ref={registerFtpOpener}
        type="button"
        variant="outline"
        size="sm"
        onClick={() => actions?.open()}
      >
        {say("activity.review.ftp.open")}
      </Button>
    </div>
  );
}
