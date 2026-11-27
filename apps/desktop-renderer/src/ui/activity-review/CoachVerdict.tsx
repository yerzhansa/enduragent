import type { PlanCalendarVerdict } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, cn } from "@enduragent/ui";
import type { ReactElement, ReactNode } from "react";
import type { RideReviewState } from "../../activity-review/review-controller";
import type { ActivityReviewActions } from "../../state/activity-review-slice";
import { useReviewText } from "./review-text";

type Kept = Extract<PlanCalendarVerdict, { state: "kept" }>;

function Frame(props: { readonly children: ReactNode }): ReactElement {
  const { say } = usePhrasebook();
  return (
    <section
      className="flex flex-col gap-2.5 rounded-card border border-brand bg-surface px-5 py-4.5"
      aria-label={say("activity.review.verdict.title")}
      data-coach-verdict=""
    >
      <span className="text-xs font-semibold text-ink-2 uppercase">
        {say("activity.review.verdict.title")}
      </span>
      {props.children}
    </section>
  );
}

function useWritten(): (verdict: Kept, replies: number) => string {
  const { say } = usePhrasebook();
  const text = useReviewText();
  return (verdict, replies) => {
    const time = text.clock(verdict.writtenAtMs);
    switch (verdict.marker.kind) {
      case "matched-to":
        return say("activity.review.verdict.before.workout", { name: verdict.marker.name });
      case "matched-extra":
        return say("activity.review.verdict.before.extra");
      case "match-pending":
        return say("activity.review.verdict.before.pending");
      case "current":
        break;
    }
    switch (verdict.trigger) {
      case "matched":
        return say("activity.review.verdict.written.matched", { time });
      case "opened":
        if (replies <= 1) {
          return verdict.usedPlan
            ? say("activity.review.verdict.written.firstOpen", { time })
            : say("activity.review.verdict.written.firstOpenNoPlan", { time });
        }
        return verdict.usedPlan
          ? say("activity.review.verdict.written.opened", { time })
          : say("activity.review.verdict.written.openedNoPlan", { time });
      case "asked":
        if (verdict.usedNote) {
          return verdict.usedPlan
            ? say("activity.review.verdict.written.askedNote", { time })
            : say("activity.review.verdict.written.askedNoteNoPlan", { time });
        }
        return verdict.usedPlan
          ? say("activity.review.verdict.written.asked", { time })
          : say("activity.review.verdict.written.askedNoPlan", { time });
    }
  };
}

function WriteAgain(props: {
  readonly busy: boolean;
  readonly actions: ActivityReviewActions | null;
}): ReactElement {
  const { say } = usePhrasebook();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={props.busy}
      onClick={() => props.actions?.writeAgain()}
    >
      {say("activity.review.verdict.writeAgain", { count: 1 })}
    </Button>
  );
}

function AskFailed(props: { readonly failed: boolean }): ReactElement | null {
  const { say } = usePhrasebook();
  if (!props.failed) return null;
  return (
    <p className="m-0 text-xs text-warn" role="alert">
      {say("activity.review.match.failed")}
    </p>
  );
}

export function CoachVerdict(props: {
  readonly state: RideReviewState;
  readonly actions: ActivityReviewActions | null;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const written = useWritten();
  const state = props.state;
  if (state.kind === "none" || state.kind === "loading") return null;
  if (state.kind === "unavailable") {
    return (
      <Frame>
        <p className="m-0 text-sm text-ink-2" role="alert">
          {say("activity.review.verdict.unavailable")}
        </p>
        <div>
          <Button type="button" variant="outline" onClick={() => props.actions?.refresh()}>
            {say("activity.review.retry")}
          </Button>
        </div>
      </Frame>
    );
  }
  const { review } = state;
  const verdict = review.verdict;
  const canWrite = review.blocked === "none";
  const busy = state.asking === "asking";
  if (verdict.state === "kept") {
    return (
      <Frame>
        <p className="m-0 text-lg leading-relaxed whitespace-pre-line">{verdict.text}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "min-w-60 flex-1 text-xs",
              verdict.marker.kind === "current" ? "text-ink-2" : "text-warn",
            )}
          >
            {say("activity.review.verdict.meta", {
              written: written(verdict, review.replies),
              replies: say("activity.review.verdict.replies", { count: review.replies }),
            })}
          </span>
          {canWrite ? <WriteAgain busy={busy} actions={props.actions} /> : null}
        </div>
        <AskFailed failed={state.asking === "failed"} />
      </Frame>
    );
  }
  if (verdict.state === "writing") {
    return (
      <Frame>
        <p className="m-0 text-sm text-ink-2" role="status">
          {say("activity.review.verdict.writing")}
        </p>
      </Frame>
    );
  }
  if (verdict.state === "failed") {
    return (
      <Frame>
        <p className="m-0 text-sm text-warn" role="alert">
          {say("activity.review.verdict.failed")}
        </p>
        {canWrite ? (
          <div>
            <WriteAgain busy={busy} actions={props.actions} />
          </div>
        ) : null}
        <AskFailed failed={state.asking === "failed"} />
      </Frame>
    );
  }
  switch (review.blocked) {
    case "none":
      return null;
    case "waiting-for-match":
      return <p className="m-0 text-xs text-ink-2">{say("activity.review.verdict.afterAnswer")}</p>;
    case "no-model":
      return (
        <Frame>
          <p className="m-0 text-sm text-ink-2">{say("activity.review.verdict.noModel")}</p>
        </Frame>
      );
    case "no-file":
      return (
        <Frame>
          <p className="m-0 text-sm text-ink-2">{say("activity.review.verdict.noFile")}</p>
        </Frame>
      );
  }
}
