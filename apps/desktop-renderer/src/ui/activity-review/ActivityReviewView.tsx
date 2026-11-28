import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, Page } from "@enduragent/ui";
import { TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { selectedRide } from "../../activity-review/rides";
import { rendererPlatformProjection } from "../../platform-copy";
import { useEnduragentStore } from "../../state/store";
import { FtpSheet } from "./FtpSheet";
import { RideDetail } from "./RideDetail";
import { RideList } from "./RideList";
import { useReviewText } from "./review-text";

function RefreshFailed(props: { readonly onRetry: () => void }): ReactElement {
  const { say } = usePhrasebook();
  return (
    <div
      className="mx-7 mt-4 flex flex-wrap items-center gap-2.5 rounded-card border border-warn bg-warn/10 px-3.5 py-2.5 text-sm"
      role="status"
    >
      <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
      <span>{say("activity.review.refreshFailed")}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        {say("activity.review.retry")}
      </Button>
    </div>
  );
}

export function ActivityReviewView(): ReactElement {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const state = useEnduragentStore((store) => store.activityReview);
  const actions = useEnduragentStore((store) => store.activityReviewActions);
  const review = useEnduragentStore((store) => store.rideReview);
  const ftpPanel = useEnduragentStore((store) => store.ftpPanel);
  const ftpActions = useEnduragentStore((store) => store.ftpActions);
  const ride = state.kind === "ready" ? selectedRide(state.read, state.selectedId) : null;
  const facts =
    ride === null ? null : { day: text.weekdayDayMonth(ride.dateKey), name: text.rideName(ride) };
  const subtitle =
    state.kind !== "ready" || facts === null
      ? undefined
      : state.read.plan === null
        ? say("activity.review.subtitleNoPlan", facts)
        : say("activity.review.subtitle", facts);
  return (
    <Page
      title={say("sidebar.views.activityReview")}
      {...(subtitle === undefined ? {} : { subtitle })}
      busy={state.kind === "loading" || (state.kind === "ready" && state.refresh === "refreshing")}
      action={
        ride === null || facts === null ? undefined : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => actions?.showInCalendar(ride.dateKey)}
            >
              {say("activity.review.showInCalendar")}
            </Button>
            {ride.match.kind === "suggested" ? null : (
              <Button
                type="button"
                variant="outline"
                onClick={() => actions?.askCoach(say("activity.review.askDraft", facts))}
              >
                {say("activity.review.ask")}
              </Button>
            )}
          </div>
        )
      }
      className="activity-review-view"
      contentMode="workspace"
    >
      {state.kind === "unavailable" ? (
        <section className="flex flex-col items-start gap-3 px-5 py-6" role="alert">
          <p className="m-0 text-sm text-ink-2">{say("activity.review.unavailable")}</p>
          <Button type="button" variant="outline" onClick={() => actions?.refresh()}>
            {say("activity.review.retry")}
          </Button>
        </section>
      ) : null}
      {state.kind === "ready" && ride === null ? (
        <p className="m-0 px-5 py-6 text-sm text-ink-2" data-activity-review-state="empty">
          {say("activity.review.empty")}
        </p>
      ) : null}
      {state.kind === "ready" && ride !== null ? (
        <div className="relative flex h-full min-h-0" data-activity-review-state="ready">
          <RideList
            read={state.read}
            firstDay={rendererPlatformProjection().firstDayOfWeek}
            selectedId={ride.activityId}
            onSelect={(activityId) => actions?.select(activityId)}
          />
          <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-page-scroll="">
            {state.refresh === "failed" ? (
              <RefreshFailed onRetry={() => actions?.refresh()} />
            ) : null}
            <RideDetail
              read={state.read}
              ride={ride}
              choices={state.choices}
              saving={state.saving}
              review={review}
              actions={actions}
            />
          </div>
          <FtpSheet state={ftpPanel} actions={ftpActions} />
        </div>
      ) : null}
    </Page>
  );
}
