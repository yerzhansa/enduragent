import { usePhrasebook } from "@enduragent/i18n/react";
import { TriangleAlert } from "lucide-react";
import type { ReactElement, RefObject } from "react";
import { useEnduragentStore } from "../../state/store";
import { sourceRestrictionSummary } from "../../training-context/manual-sync";
import { STRAVA_HELP_HREF, STRAVA_RESTRICTION_CARD_ID } from "./restriction-focus";

export function TrainingRestrictionCard(props: {
  readonly restrictionCard: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const { say, format } = usePhrasebook();
  const sync = useEnduragentStore((store) => store.sync);
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const restrictionVars =
    restriction === null
      ? undefined
      : {
          strava: "Strava",
          count: restriction.total,
          restricted: format.number(restriction.count, { useGrouping: false }),
          total: format.number(restriction.total, { useGrouping: false }),
        };

  return (
    <>
      {restriction === null ? null : (
        <div
          ref={props.restrictionCard}
          id={STRAVA_RESTRICTION_CARD_ID}
          tabIndex={-1}
          className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-elev-1"
        >
          <div className="flex items-start gap-2.5">
            <TriangleAlert
              size={17}
              strokeWidth={1.8}
              className="mt-px flex-none text-warn"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="m-0 text-sm font-semibold text-ink">
                {say("settings.athlete.restriction.title", {
                  ...restrictionVars,
                  count: restriction.count === 1 && restriction.total === 1 ? 1 : restriction.total,
                })}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {say("settings.athlete.restriction.cause", {
                  strava: "Strava",
                })}
              </p>
              <a
                className="mt-1 inline-block text-[12.5px] font-medium text-brand underline-offset-2 hover:underline"
                href={STRAVA_HELP_HREF}
                target="_blank"
                rel="noopener noreferrer"
              >
                {say("settings.athlete.restriction.helpAction")}
              </a>
            </div>
          </div>
          <div className="mt-3 grid gap-2.5 border-t border-line pt-3">
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                {format.number(1)}
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">
                  {say("settings.athlete.futurePrefix")}
                </strong>
                {say("settings.athlete.restriction.future", {
                  intervalsLower: "intervals.icu",
                  strava: "Strava",
                })}
              </p>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                {format.number(2)}
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">
                  {say("settings.athlete.pastPrefix")}
                </strong>
                {say("settings.athlete.restriction.past", {
                  intervalsLower: "intervals.icu",
                  strava: "Strava",
                })}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
