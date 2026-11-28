import type { PlanCalendarEarlierVerdict } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, cn } from "@enduragent/ui";
import type { ReactElement, ReactNode } from "react";
import type { RideReviewState } from "../../activity-review/review-controller";
import type { ActivityReviewActions } from "../../state/activity-review-slice";
import { useVerdictMeta, type VerdictDays, type VerdictMetaFacts } from "./verdict-meta";

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

function Meta(props: {
  readonly verdict: VerdictMetaFacts;
  readonly replies: number;
  readonly days: VerdictDays;
}): ReactElement {
  const meta = useVerdictMeta();
  return (
    <span
      className={cn(
        "min-w-60 flex-1 text-xs",
        props.verdict.marker.kind === "current" ? "text-ink-2" : "text-warn",
      )}
    >
      {meta(props.verdict, props.replies, props.days)}
    </span>
  );
}

function Earlier(props: {
  readonly earlier: PlanCalendarEarlierVerdict;
  readonly days: VerdictDays;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2.5" data-earlier-verdict="">
      <p className="m-0 text-lg leading-relaxed whitespace-pre-line">{props.earlier.text}</p>
      <div className="flex">
        <Meta verdict={props.earlier} replies={props.earlier.replies} days={props.days} />
      </div>
    </div>
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
  readonly days: VerdictDays;
  readonly actions: ActivityReviewActions | null;
}): ReactElement | null {
  const { say } = usePhrasebook();
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
          <Meta verdict={verdict} replies={review.replies} days={props.days} />
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
          {verdict.earlier === null
            ? say("activity.review.verdict.failed")
            : say("activity.review.verdict.failedKeepsEarlier")}
        </p>
        {canWrite ? (
          <div>
            <WriteAgain busy={busy} actions={props.actions} />
          </div>
        ) : null}
        <AskFailed failed={state.asking === "failed"} />
        {verdict.earlier === null ? null : <Earlier earlier={verdict.earlier} days={props.days} />}
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
