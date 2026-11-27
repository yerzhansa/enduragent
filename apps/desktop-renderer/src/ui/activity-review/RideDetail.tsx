import type { PlanCalendarRide, PlanCalendarRideWorkout } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import type { ReactElement } from "react";
import type { ReviewChoices, ReviewSaving } from "../../activity-review/controller";
import { rideOutcome, type ActivityReviewRead } from "../../activity-review/rides";
import type { ActivityReviewActions } from "../../state/activity-review-slice";
import { useReviewText } from "./review-text";

interface ChoiceProps {
  readonly ride: PlanCalendarRide;
  readonly choices: ReviewChoices;
  readonly saving: ReviewSaving;
  readonly actions: ActivityReviewActions | null;
}

function SavingLine(props: { readonly saving: ReviewSaving }): ReactElement | null {
  const { say } = usePhrasebook();
  if (props.saving === "idle") return null;
  if (props.saving === "saving") {
    return (
      <p className="m-0 text-xs text-ink-2" role="status">
        {say("activity.review.match.saving")}
      </p>
    );
  }
  return (
    <p className="m-0 text-xs text-warn" role="alert">
      {props.saving === "failed"
        ? say("activity.review.match.failed")
        : say("activity.review.match.refused")}
    </p>
  );
}

function OtherWorkouts(props: ChoiceProps): ReactElement {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const busy = props.saving === "saving";
  return (
    <div className="flex flex-col gap-2" data-other-workouts="">
      <strong className="text-sm">{say("activity.review.match.pickTitle")}</strong>
      {props.ride.otherWorkouts.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{say("activity.review.match.pickNone")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {props.ride.otherWorkouts.map((workout) => (
            <Button
              key={workout.planWorkoutId}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => props.actions?.rematch(workout.planWorkoutId)}
            >
              {workout.durationS === null
                ? say("activity.review.match.pickItem", {
                    day: text.weekdayDay(workout.dateKey),
                    name: workout.name,
                  })
                : say("activity.review.match.pickItemLength", {
                    day: text.weekdayDay(workout.dateKey),
                    name: workout.name,
                    duration: text.duration(workout.durationS),
                  })}
            </Button>
          ))}
        </div>
      )}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => props.actions?.closeChoices()}
        >
          {say("activity.review.match.cancel")}
        </Button>
      </div>
    </div>
  );
}

function MatchCard(
  props: ChoiceProps & { readonly workout: PlanCalendarRideWorkout; readonly waiting: boolean },
): ReactElement {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const busy = props.saving === "saving";
  const weekday = text.weekdayLong(props.workout.dateKey);
  const distance = props.ride.distanceM === null ? null : text.distance(props.ride.distanceM);
  const power = props.ride.averagePowerW === null ? null : text.watts(props.ride.averagePowerW);
  const facts =
    distance === null
      ? power === null
        ? null
        : say("activity.review.match.averagePower", { power })
      : power === null
        ? distance
        : say("activity.review.match.rideFacts", { distance, power });
  const rideTitle =
    props.ride.durationS === null
      ? text.rideName(props.ride)
      : say("activity.review.match.rideTitle", {
          name: text.rideName(props.ride),
          duration: text.duration(props.ride.durationS),
        });
  return (
    <section
      className="flex flex-col gap-3.5 rounded-card border-2 border-brand bg-surface px-5 py-4.5"
      aria-label={say("activity.review.match.label")}
      data-match-card=""
    >
      <strong className="text-lg">
        {say("activity.review.match.question", { weekday, name: props.workout.name })}
      </strong>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-0.5 rounded-ctl border border-line px-3 py-2.5 text-sm">
          <span className="text-xs font-semibold text-ink-2 uppercase">
            {say("activity.review.match.planWorkout", {
              day: text.weekdayDay(props.workout.dateKey),
            })}
          </span>
          <strong>{props.workout.name}</strong>
          {props.workout.durationS === null ? null : (
            <span>{text.duration(props.workout.durationS)}</span>
          )}
        </div>
        <div className="flex flex-col gap-0.5 rounded-ctl border border-line px-3 py-2.5 text-sm">
          <span className="text-xs font-semibold text-ink-2 uppercase">
            {say("activity.review.match.thisRide")}
          </span>
          <strong>{rideTitle}</strong>
          {facts === null ? null : <span>{facts}</span>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy}
          onClick={() => props.actions?.confirm(props.workout.planWorkoutId)}
        >
          {say("activity.review.match.yes")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => props.actions?.extra()}
        >
          {say("activity.review.match.no")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          aria-expanded={props.choices === "other-day"}
          onClick={() => props.actions?.otherDay()}
        >
          {say("activity.review.match.otherDay")}
        </Button>
      </div>
      {props.choices === "other-day" ? <OtherWorkouts {...props} /> : null}
      <SavingLine saving={props.saving} />
      {props.waiting ? (
        <p className="m-0 text-xs text-ink-2">
          {say("activity.review.match.waiting", { weekday })}
        </p>
      ) : null}
    </section>
  );
}

function MatchSection(
  props: ChoiceProps & { readonly read: ActivityReviewRead },
): ReactElement | null {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const match = props.ride.match;
  if (match.kind === "suggested") {
    return <MatchCard {...props} workout={match} waiting />;
  }
  if (match.kind === "confirmed") {
    return (
      <>
        <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span>
            {match.by === "you"
              ? say("activity.review.match.confirmed", {
                  weekday: text.weekdayLong(match.dateKey),
                })
              : say("activity.review.match.paired", { weekday: text.weekdayLong(match.dateKey) })}
          </span>
          {props.choices === "closed" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.actions?.change()}
            >
              {say("activity.review.match.change")}
            </Button>
          ) : null}
        </p>
        {props.choices === "closed" ? (
          <SavingLine saving={props.saving} />
        ) : (
          <MatchCard {...props} workout={match} waiting={false} />
        )}
      </>
    );
  }
  if (props.read.plan === null) {
    return <p className="m-0 text-xs text-ink-2">{say("activity.review.match.noPlan")}</p>;
  }
  if (rideOutcome(props.read, props.ride).kind !== "extra") return null;
  return (
    <>
      <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <span>{say("activity.review.match.extra")}</span>
        {props.choices === "closed" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.actions?.otherDay()}
          >
            {say("activity.review.match.change")}
          </Button>
        ) : null}
      </p>
      {props.choices === "closed" ? (
        <SavingLine saving={props.saving} />
      ) : (
        <section
          className="flex flex-col gap-3 rounded-card border border-line bg-surface px-5 py-4.5"
          aria-label={say("activity.review.match.label")}
        >
          <OtherWorkouts {...props} />
          <SavingLine saving={props.saving} />
        </section>
      )}
    </>
  );
}

function Stat(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 bg-surface px-3.5 py-2.5">
      <dt className="text-xs text-ink-2">{props.label}</dt>
      <dd className="m-0 text-base font-semibold">{props.value}</dd>
    </div>
  );
}

function Stats(props: { readonly ride: PlanCalendarRide }): ReactElement {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const ride = props.ride;
  const missing = say("activity.review.stats.notRecorded");
  return (
    <dl
      className="m-0 grid grid-cols-3 gap-px overflow-hidden rounded-card border border-line bg-line"
      aria-label={say("activity.review.stats.label")}
    >
      <Stat
        label={say("activity.review.stats.time")}
        value={ride.durationS === null ? missing : text.duration(ride.durationS)}
      />
      <Stat
        label={say("activity.review.stats.distance")}
        value={ride.distanceM === null ? missing : text.distance(ride.distanceM)}
      />
      <Stat
        label={say("activity.review.stats.load")}
        value={ride.load === null ? missing : text.load(ride.load)}
      />
      <Stat
        label={say("activity.review.stats.power")}
        value={ride.averagePowerW === null ? missing : text.watts(ride.averagePowerW)}
      />
      <Stat
        label={say("activity.review.stats.heartRate")}
        value={ride.averageHeartRateBpm === null ? missing : text.bpm(ride.averageHeartRateBpm)}
      />
      <Stat
        label={say("activity.review.stats.exertion")}
        value={text.exertion(ride.perceivedExertion)}
      />
    </dl>
  );
}

export function RideDetail(props: {
  readonly read: ActivityReviewRead;
  readonly ride: PlanCalendarRide;
  readonly choices: ReviewChoices;
  readonly saving: ReviewSaving;
  readonly actions: ActivityReviewActions | null;
}): ReactElement {
  const text = useReviewText();
  return (
    <article
      className="flex max-w-215 min-w-0 flex-col gap-4 px-7 pt-5.5 pb-9"
      data-ride-detail={props.ride.activityId}
    >
      <header className="flex flex-col gap-1">
        <p className="m-0 text-xs text-ink-2">{text.startLine(props.ride)}</p>
        <h2 className="m-0 text-xl font-semibold">{text.rideName(props.ride)}</h2>
      </header>
      <MatchSection {...props} />
      <Stats ride={props.ride} />
    </article>
  );
}
