import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { FtpPanelState } from "../../activity-review/ftp-controller";
import { focusFtpOpener } from "../../activity-review/ftp-opener";
import type { FtpActions } from "../../state/activity-review-slice";
import { FtpChart } from "./FtpChart";
import { FtpNoticeLine, FtpProposalCard } from "./FtpProposal";
import { useFtpText } from "./ftp-text";

const FRAME =
  "absolute top-0 right-0 bottom-0 z-10 flex w-140 max-w-full flex-col gap-3.5 overflow-auto border-l border-line bg-surface px-6 py-5 shadow-elev-3";

function History(props: {
  readonly read: Extract<FtpPanelState, { kind: "ready" }>["read"];
}): ReactElement | null {
  const { say } = usePhrasebook();
  const text = useFtpText();
  if (props.read.history.length === 0) return null;
  return (
    <table className="w-full border-collapse text-sm" data-ftp-history="">
      <caption className="sr-only">{say("activity.review.ftp.historyLabel")}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{say("activity.review.ftp.historyDate")}</th>
          <th scope="col">{say("activity.review.ftp.historyWatts")}</th>
          <th scope="col">{say("activity.review.ftp.historyFrom")}</th>
        </tr>
      </thead>
      <tbody>
        {[...props.read.history].reverse().map((line, index) => (
          <tr
            key={`${line.dateKey}-${line.watts}-${index}`}
            className="border-t border-line first:border-t-0"
          >
            <td className="w-16 py-1.5 pr-2.5 align-top text-ink-2">
              {line.source === "first-sync" ? "" : text.dayMonth(line.dateKey)}
            </td>
            <td className="w-16 py-1.5 pr-2.5 align-top font-semibold">
              {say("activity.review.ftp.currentWatts", { watts: text.watts(line.watts) })}
            </td>
            <td className="py-1.5 align-top">{text.historySource(line)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body(props: {
  readonly state: Extract<FtpPanelState, { kind: "ready" }>;
  readonly actions: FtpActions | null;
  readonly heading: RefObject<HTMLHeadingElement | null>;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useFtpText();
  const notice = useRef<HTMLParagraphElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const { read } = props.state;
  const proposal = read.proposal.kind;
  const was = useRef(proposal);
  useEffect(() => {
    if (was.current !== "none" && proposal === "none") {
      (notice.current ?? props.heading.current)?.focus();
    } else if (was.current === "confirming" && proposal === "shown") {
      (notice.current ?? useButton.current)?.focus();
    }
    was.current = proposal;
  }, [proposal, props.heading]);
  return (
    <>
      {read.current === null ? (
        <p className="m-0 text-sm">{say("activity.review.ftp.noCurrent")}</p>
      ) : (
        <p className="m-0" data-ftp-current="">
          <span className="text-xl font-semibold">
            {say("activity.review.ftp.currentWatts", { watts: text.watts(read.current.watts) })}
          </span>{" "}
          <span className="text-sm text-ink-2">{text.source(read.current)}</span>
        </p>
      )}
      <FtpChart read={read} />
      <p className="m-0 text-xs text-ink-2">{say("activity.review.ftp.explainer")}</p>
      <History read={read} />
      <FtpProposalCard
        read={read}
        busy={props.state.busy !== null}
        actions={props.actions}
        useButton={useButton}
      />
      <FtpNoticeLine
        notice={props.state.notice}
        busy={props.state.busy}
        current={read.current?.watts ?? null}
        focusRef={notice}
      />
      <p className="m-0 text-xs text-ink-2">{say("activity.review.ftp.closing")}</p>
    </>
  );
}

export function FtpSheet(props: {
  readonly state: FtpPanelState;
  readonly actions: FtpActions | null;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const heading = useRef<HTMLHeadingElement>(null);
  const frame = useRef<HTMLElement>(null);
  const open = props.state.open;
  const wasOpen = useRef(false);
  useEffect(() => {
    const inside = frame.current?.contains(document.activeElement) === true;
    if (open && !wasOpen.current && !inside) heading.current?.focus();
    if (!open && wasOpen.current) focusFtpOpener();
    wasOpen.current = open;
  }, [open]);
  if (!open) return null;
  return (
    <aside
      ref={frame}
      className={FRAME}
      aria-label={say("activity.review.ftp.title")}
      data-ftp-sheet=""
      onKeyDown={(event) => {
        if (event.key === "Escape") props.actions?.close();
      }}
    >
      <div className="flex items-center justify-between">
        <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold">
          {say("activity.review.ftp.title")}
        </h2>
        <Button type="button" variant="outline" onClick={() => props.actions?.close()}>
          {say("activity.review.ftp.close")}
        </Button>
      </div>
      {props.state.kind === "loading" ? (
        <p className="m-0 text-sm text-ink-2" role="status">
          {say("activity.review.ftp.loading")}
        </p>
      ) : null}
      {props.state.kind === "unavailable" ? (
        <p className="m-0 text-sm text-warn" role="alert">
          {say("activity.review.ftp.unavailable")}
        </p>
      ) : null}
      {props.state.kind === "ready" ? (
        <Body state={props.state} actions={props.actions} heading={heading} />
      ) : null}
    </aside>
  );
}
