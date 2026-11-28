import type { PlanCalendarFtpProposal, PlanCalendarFtpRead } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEffect, useId, useRef, type ReactElement, type RefObject } from "react";
import type { FtpNotice } from "../../activity-review/ftp-controller";
import type { FtpActions } from "../../state/activity-review-slice";
import { useFtpText, type FtpText } from "./ftp-text";

type Say = ReturnType<typeof usePhrasebook>["say"];
type Open = Exclude<PlanCalendarFtpProposal, { kind: "none" }>;
type Confirming = Extract<PlanCalendarFtpProposal, { kind: "confirming" }>;

const CARD = "flex flex-col gap-2.5 rounded-card border-2 border-brand bg-surface px-4.5 py-4";

function reasonTitle(proposal: Open, text: FtpText, say: Say): string {
  if (proposal.basis.kind === "planned-test") {
    return say("activity.review.ftp.proposal.testTitle", { watts: text.watts(proposal.watts) });
  }
  return proposal.basis.direction === "above"
    ? say("activity.review.ftp.proposal.driftAboveTitle")
    : say("activity.review.ftp.proposal.driftBelowTitle");
}

function reasonBody(proposal: Open, current: number | null, text: FtpText, say: Say): string {
  const watts = text.watts(proposal.watts);
  const basis = proposal.basis;
  if (basis.kind === "planned-test") {
    const date = text.weekdayDayMonth(basis.testDateKey);
    return basis.bestWatts === null
      ? say("activity.review.ftp.proposal.testBody", { date, watts })
      : say("activity.review.ftp.proposal.testBestBody", {
          date,
          watts,
          best: text.watts(basis.bestWatts),
        });
  }
  const ftp = current === null ? "" : text.watts(current);
  if (
    basis.sinceDateKey === null ||
    basis.lowWatts === null ||
    basis.highWatts === null ||
    basis.lowestWatts === null
  ) {
    return basis.direction === "above"
      ? say("activity.review.ftp.proposal.driftAboveLapsed", { ftp, watts })
      : say("activity.review.ftp.proposal.driftBelowLapsed", { ftp, watts });
  }
  const values = {
    range:
      basis.lowWatts === basis.highWatts
        ? say("activity.review.ftp.proposal.rangeOne", { watts: text.watts(basis.lowWatts) })
        : say("activity.review.ftp.proposal.range", {
            low: text.watts(basis.lowWatts),
            high: text.watts(basis.highWatts),
          }),
    date: text.weekdayDayMonth(basis.sinceDateKey),
    lowest: text.watts(basis.lowestWatts),
    ftp,
    watts,
  };
  return basis.direction === "above"
    ? say("activity.review.ftp.proposal.driftAboveBody", values)
    : say("activity.review.ftp.proposal.driftBelowBody", values);
}

function effect(proposal: Open, text: FtpText, say: Say): string {
  const watts = text.watts(proposal.watts);
  const percent = proposal.percent;
  if (percent === null) return say("activity.review.ftp.proposal.effectNoFtp", { watts });
  return percent >= 0
    ? say("activity.review.ftp.proposal.effectUp", { watts, percent })
    : say("activity.review.ftp.proposal.effectDown", { watts, percent: -percent });
}

function change(percent: number | null, say: Say): string | null {
  if (percent === null) return null;
  if (percent === 0) return say("activity.review.ftp.confirm.same");
  return percent > 0
    ? say("activity.review.ftp.confirm.higher", { percent })
    : say("activity.review.ftp.confirm.lower", { percent: -percent });
}

function Row(props: { readonly label: string; readonly children: string }): ReactElement {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
      <span className="text-ink-2">{props.label}</span>
      <span>{props.children}</span>
    </div>
  );
}

function ChangedNotice(props: { readonly proposal: Confirming }): ReactElement {
  const { say } = usePhrasebook();
  const text = useFtpText();
  const { icuWatts, icuChangedAtMs } = props.proposal;
  return (
    <div
      className="flex flex-col gap-1 rounded-ctl border border-warn bg-warn/10 px-3 py-2 text-sm"
      role="alert"
    >
      <span>
        {icuWatts === null
          ? say("activity.review.ftp.confirm.changedNone")
          : icuChangedAtMs === null
            ? say("activity.review.ftp.confirm.changed", { watts: text.watts(icuWatts) })
            : say("activity.review.ftp.confirm.changedAt", {
                watts: text.watts(icuWatts),
                time: text.time(icuChangedAtMs),
              })}
      </span>
      <strong>
        {say("activity.review.ftp.confirm.instead", { watts: text.watts(props.proposal.watts) })}
      </strong>
    </div>
  );
}

function Confirm(props: {
  readonly proposal: Confirming;
  readonly busy: boolean;
  readonly actions: FtpActions | null;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useFtpText();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const { proposal } = props;
  useEffect(() => {
    title.current?.focus();
  }, []);
  const from = proposal.icuWatts;
  const to = text.watts(proposal.watts);
  const moved = change(proposal.percent, say);
  const workouts =
    moved === null
      ? say("activity.review.ftp.confirm.workoutsUnknown")
      : proposal.workoutsOnIntervals === 0
        ? say("activity.review.ftp.confirm.workoutsNone", { change: moved })
        : say("activity.review.ftp.confirm.workouts", {
            count: proposal.workoutsOnIntervals,
            change: moved,
          });
  return (
    <section
      className={CARD}
      aria-labelledby={titleId}
      aria-busy={props.busy}
      data-ftp-confirm=""
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (!props.busy) props.actions?.answer("cancel");
      }}
    >
      <h3 ref={title} id={titleId} tabIndex={-1} className="m-0 text-base font-semibold">
        {say("activity.review.ftp.confirm.title", { watts: to })}
      </h3>
      {proposal.changedSinceUse ? <ChangedNotice proposal={proposal} /> : null}
      <Row label={say("activity.review.ftp.confirm.changesLabel")}>
        {from === null
          ? say("activity.review.ftp.confirm.changesNone", { to })
          : say("activity.review.ftp.confirm.changes", { from: text.watts(from), to })}
      </Row>
      <Row label={say("activity.review.ftp.confirm.workoutsLabel")}>{workouts}</Row>
      <Row label={say("activity.review.ftp.confirm.staysLabel")}>
        {from === null
          ? say("activity.review.ftp.confirm.staysNone")
          : say("activity.review.ftp.confirm.stays", { from: text.watts(from) })}
      </Row>
      <div className="flex gap-2">
        <Button
          type="button"
          className="flex-1"
          disabled={props.busy}
          onClick={() => props.actions?.answer("confirm")}
        >
          {say("activity.review.ftp.confirm.set", { watts: to })}
        </Button>
        {proposal.changedSinceUse ? (
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={() => props.actions?.answer("keep")}
          >
            {from === null
              ? say("activity.review.ftp.proposal.keepNone")
              : say("activity.review.ftp.proposal.keep", { watts: text.watts(from) })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={() => props.actions?.answer("cancel")}
          >
            {say("activity.review.ftp.confirm.cancel")}
          </Button>
        )}
      </div>
    </section>
  );
}

export function FtpProposalCard(props: {
  readonly read: PlanCalendarFtpRead;
  readonly busy: boolean;
  readonly actions: FtpActions | null;
  readonly useButton?: RefObject<HTMLButtonElement | null>;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const text = useFtpText();
  const proposal = props.read.proposal;
  if (proposal.kind === "none") return null;
  if (proposal.kind === "confirming") {
    return <Confirm proposal={proposal} busy={props.busy} actions={props.actions} />;
  }
  const current = props.read.current?.watts ?? null;
  const watts = text.watts(proposal.watts);
  return (
    <section
      className={CARD}
      aria-label={say("activity.review.ftp.proposal.label")}
      data-ftp-proposal=""
    >
      <span className="text-xs font-semibold text-ink-2 uppercase">
        {say("activity.review.ftp.proposal.tag", {
          date: text.weekdayDayMonth(proposal.shownOnDateKey),
        })}
      </span>
      <strong className="text-base">{reasonTitle(proposal, text, say)}</strong>
      <p className="m-0 text-sm">{reasonBody(proposal, current, text, say)}</p>
      <p className="m-0 text-sm text-ink-2">{effect(proposal, text, say)}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={props.busy} onClick={() => props.actions?.answer("keep")}>
          {current === null
            ? say("activity.review.ftp.proposal.keepNone")
            : say("activity.review.ftp.proposal.keep", { watts: text.watts(current) })}
        </Button>
        <Button
          ref={props.useButton}
          type="button"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.actions?.answer("use")}
        >
          {say("activity.review.ftp.proposal.use", { watts })}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.actions?.planTest(say("activity.review.ftp.proposal.testRequest"))}
        >
          {say("activity.review.ftp.proposal.planTest")}
        </Button>
      </div>
    </section>
  );
}

export function FtpNoticeLine(props: {
  readonly notice: FtpNotice;
  readonly busy: string | null;
  readonly current: number | null;
  readonly focusRef: RefObject<HTMLParagraphElement | null>;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const text = useFtpText();
  if (props.busy === "confirm" || props.busy === "use") {
    return (
      <p className="m-0 text-xs text-ink-2" role="status">
        {props.busy === "confirm"
          ? say("activity.review.ftp.notice.writing")
          : say("activity.review.ftp.notice.reading")}
      </p>
    );
  }
  if (props.notice === "written" && props.current !== null) {
    return (
      <p ref={props.focusRef} tabIndex={-1} className="m-0 text-xs text-ok" role="status">
        {say("activity.review.ftp.notice.written", { watts: text.watts(props.current) })}
      </p>
    );
  }
  if (props.notice === "unavailable" || props.notice === "failed" || props.notice === "refused") {
    return (
      <p ref={props.focusRef} tabIndex={-1} className="m-0 text-xs text-warn" role="alert">
        {props.notice === "unavailable"
          ? say("activity.review.ftp.notice.unavailable")
          : props.notice === "failed"
            ? say("activity.review.ftp.notice.failed")
            : say("activity.review.ftp.notice.refused")}
      </p>
    );
  }
  return null;
}
