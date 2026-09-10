import { msg, type Message } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { chatFeedbackMessage } from "../chat/copy";
import { usePlanDate } from "./plan-date";
import type { LegacyPlanSummary, ListPlansResult, PlanSummary } from "@enduragent/coach-contract";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY } from "../../chat/controller";
import { Button } from "@enduragent/ui";
import { PlanCard } from "./plan-card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@enduragent/ui";
import { creationTitle } from "../../plan/creation-title";
import { requestPlanCalendarRetry } from "../../plan/library-refresh";
import { useEnduragentStore } from "../../state/store";

function LibraryCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <PlanCard
      {...props}
      aria-label={props.eyebrow ?? props.title}
      contentClassName="p-0"
      statusClassName="inline-flex shrink-0 items-center gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2"
    />
  );
}

export function calendarStatusLabel(
  calendar: PlanSummary["calendar"],
  phrasebook: Phrasebook,
  planDate: ReturnType<typeof usePlanDate>,
): string {
  const { say } = phrasebook;
  switch (calendar.status) {
    case "verified":
      return calendar.window === null
        ? say("chat.planChange.calendar.current")
        : say("chat.planChange.calendar.window", {
            start: planDate(calendar.window.start),
            end: planDate(calendar.window.end),
          });
    case "pending":
      return say(
        calendar.window === null
          ? "chat.planChange.calendar.local"
          : "chat.planChange.calendar.updating",
      );
    case "running":
      return say("chat.planChange.calendar.updating");
    case "not-connected":
      return say("chat.planChange.calendar.connect");
    case "failed":
      return say(
        calendar.error.endsWith("Retry available.")
          ? "chat.planChange.calendar.failedRetry"
          : "chat.planChange.calendar.failed",
      );
  }
}

function CalendarStatus(props: {
  readonly calendar: PlanSummary["calendar"];
  readonly retry: (() => Promise<void>) | undefined;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const planDate = usePlanDate();
  const { say } = phrasebook;
  const { calendar } = props;
  if (calendar.status === "failed") {
    const retryAvailable = calendar.error.endsWith("Retry available.");
    return (
      <div className="mx-4 mb-inset grid gap-inset">
        <p role="alert" className="m-0 text-sm text-danger">
          {calendarStatusLabel(calendar, phrasebook, planDate)}
        </p>
        {retryAvailable ? (
          <div>
            <Button
              variant="outline"
              className="border-line bg-surface"
              disabled={props.retry === undefined}
              onClick={() => void props.retry?.()}
            >
              {say("plan.details.planFinalDetails.retryCalendar")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <p role="status" className="mx-4 mt-0 mb-inset text-sm leading-5 text-ink-2">
      {say("plan.library.calendarStatus", {
        status: calendarStatusLabel(calendar, phrasebook, planDate),
      })}
    </p>
  );
}

function spanLabel(
  plan: PlanSummary,
  phrasebook: Phrasebook,
  planDate: ReturnType<typeof usePlanDate>,
): string {
  return phrasebook.say("plan.library.span", {
    count: plan.weeks,
    start: planDate(plan.start),
    end: planDate(plan.end),
    weeks: phrasebook.format.number(plan.weeks, { useGrouping: false }),
  });
}

function legacySummary(
  legacy: LegacyPlanSummary,
  phrasebook: Phrasebook,
  planDate: ReturnType<typeof usePlanDate>,
): string {
  const { say, format } = phrasebook;
  const parts: string[] = [];
  if (legacy.targetDate !== null)
    parts.push(
      say("plan.library.legacyTarget", {
        date: planDate(legacy.targetDate),
      }),
    );
  if (legacy.weeks !== null)
    parts.push(
      say("plan.library.weekCount", {
        count: legacy.weeks,
        weeks: format.number(legacy.weeks, { useGrouping: false }),
      }),
    );
  if (legacy.goal !== null) parts.push(say("plan.library.legacyGoal", { goal: legacy.goal }));
  parts.push(say("plan.library.unknownReason"));
  return parts.join(" · ");
}

function creationTitleText(
  creation: NonNullable<ListPlansResult["creation"]>,
  phrasebook: Phrasebook,
  planDate: ReturnType<typeof usePlanDate>,
): string {
  const title = creationTitle(creation, planDate);
  return typeof title === "string" ? title : phrasebook.say(title);
}

function feedbackText(value: string, { say }: Phrasebook): string {
  const message = chatFeedbackMessage(value);
  return message === null ? value : say(message);
}

export function PlanLibrary(props: {
  readonly library: ListPlansResult;
  readonly readDetails: () => void;
  readonly readFinalDetails: (planId: string, justClosed?: boolean) => void;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const planDate = usePlanDate();
  const { say, format } = phrasebook;
  const actions = useEnduragentStore((state) => state.planLibraryActions);
  const chatActions = useEnduragentStore((state) => state.chatActions);
  const chatCreation = useEnduragentStore((state) => state.chat.planCreation);
  const notice = useEnduragentStore((state) => state.chat.notice);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const discard = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [closing, setClosing] = useState<PlanSummary | null>(null);
  const closeAttempt = useEnduragentStore((state) => state.planCloseAttempt);
  const setCloseAttempt = useEnduragentStore((state) => state.setPlanCloseAttempt);
  const saving = closeAttempt?.busy ?? false;
  const [closeError, setCloseError] = useState<Message | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const confirmClose = async (): Promise<void> => {
    const pending = useEnduragentStore.getState().planCloseAttempt;
    if (closing === null || actions === null || pending?.busy) return;
    setCloseError(null);
    const command =
      pending?.command.planId === closing.planId
        ? pending.command
        : {
            commandId: crypto.randomUUID(),
            planId: closing.planId,
            expectedVersion: closing.version,
          };
    setCloseAttempt({ command, busy: true });
    let result;
    try {
      result = await actions.closePlan(command);
    } catch {
      setCloseAttempt({ command, busy: false });
      if (mounted.current) {
        setCloseError(msg("plan.library.stop.unconfirmed"));
      }
      void actions.refresh();
      return;
    }
    setCloseAttempt(null);
    if (!mounted.current) {
      void actions.refresh();
      return;
    }
    if (result.status === "rejected") {
      if (result.reason === "stale-version") {
        setCloseError(msg("plan.library.stop.stale"));
        void actions.refresh();
      } else {
        setCloseError(msg("plan.library.stop.failed"));
        setClosing(null);
      }
      return;
    }
    setClosing(null);
    setCloseError(null);
    props.readFinalDetails(result.planId, true);
    void actions.refresh();
  };
  const { creation, active, closed, legacy } = props.library;
  const total =
    creation?.openQuestion?.step.total ??
    creation?.answeredSummaries[0]?.question.step.total ??
    creation?.answeredSummaries.length ??
    0;
  useEffect(() => {
    const requestedTarget = focusRequest?.target;
    const target =
      requestedTarget === "discard"
        ? discard
        : requestedTarget === "continue"
          ? continueButton
          : requestedTarget === "change"
            ? changeButton
            : null;
    if (target !== null) queueMicrotask(() => target.current?.focus());
  }, [focusRequest, busy, creation?.creationId, active?.planId]);
  return (
    <section aria-label={say("plan.library.label")} className="grid min-w-0 gap-4">
      {closeError === null || closing !== null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {say(closeError)}
        </p>
      )}
      <Dialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setClosing(null);
            setCloseError(null);
          }
        }}
      >
        <DialogContent
          className="w-[min(520px,calc(100vw-32px))] max-w-none gap-0 border-line p-5 shadow-elev-4 sm:max-w-none"
          showCloseButton={false}
          initialFocus={cancel}
          finalFocus={stop}
          aria-busy={saving ? "true" : undefined}
        >
          <DialogHeader className="gap-inset">
            <DialogTitle className="m-0 text-lg font-semibold">
              {say("plan.library.stop.title")}
            </DialogTitle>
            <DialogDescription className="m-0 leading-5">
              {say("plan.library.stop.description")}
            </DialogDescription>
          </DialogHeader>
          {closeError === null ? null : (
            <p className="mt-inset mb-0 text-xs text-danger" role="alert">
              {say(closeError)}
            </p>
          )}
          <DialogFooter className="mx-0 mt-row mb-0 flex-row justify-end rounded-none border-0 bg-transparent p-0">
            <DialogClose
              render={
                <Button
                  ref={cancel}
                  variant="outline"
                  className="border-line bg-surface"
                  size="lg"
                  disabled={saving}
                />
              }
            >
              {say("common.cancel")}
            </DialogClose>
            <Button
              variant="destructive-solid"
              size="lg"
              disabled={
                saving || actions === null || (closeError !== null && closeAttempt === null)
              }
              onClick={() => void confirmClose()}
            >
              {say("plan.library.stop.action")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {notice !== CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY ? null : (
        <p role="status" className="m-0 text-sm text-ink-2">
          {feedbackText(notice, phrasebook)}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {feedbackText(error, phrasebook)}
        </p>
      )}
      {creation === null ? null : (
        <LibraryCard
          eyebrow={say("chat.planCreation.title")}
          title={creationTitleText(creation, phrasebook, planDate)}
          status={
            creation.draft !== null
              ? say("chat.planCreation.draft")
              : paused && chatCreation?.creationId === creation.creationId
                ? say("chat.planCreation.paused")
                : say("chat.planCreation.inProgress")
          }
          summary={say(
            active === null
              ? "plan.library.creationProgress"
              : "plan.library.creationProgressActive",
            {
              answered: format.number(creation.answeredSummaries.length, { useGrouping: false }),
              total: format.number(total, { useGrouping: false }),
              name: active?.name ?? "",
            },
          )}
        >
          <div className="flex flex-wrap gap-inset px-4 pb-4">
            <Button
              ref={discard}
              variant="destructive"
              className="border-[color-mix(in_srgb,var(--danger)_52%,var(--line))]"
              aria-haspopup="dialog"
              disabled={
                busy || chatActions === null || chatCreation?.creationId !== creation.creationId
              }
              onClick={() => chatActions?.openPlanCreationDiscard()}
            >
              {say("chat.planCreation.discard")}
            </Button>
            <Button
              ref={continueButton}
              disabled={busy || actions === null}
              onClick={() => actions?.continueCreation(creation)}
            >
              {say("plan.library.continueInChat")}
            </Button>
          </div>
        </LibraryCard>
      )}
      {active === null ? (
        <LibraryCard
          title={say("plan.library.empty.title")}
          summary={say("plan.library.empty.description")}
        />
      ) : (
        <LibraryCard
          eyebrow={say("chat.planChange.activePlan")}
          title={active.name}
          status={say("plan.library.active")}
          summary={spanLabel(active, phrasebook, planDate)}
        >
          <CalendarStatus
            calendar={active.calendar}
            retry={
              actions
                ? async () => {
                    requestPlanCalendarRetry(active.planId);
                    await actions.refresh();
                  }
                : undefined
            }
          />
          <div className="flex flex-wrap gap-inset px-4 pb-4">
            <Button
              ref={stop}
              variant="destructive"
              className="border-[color-mix(in_srgb,var(--danger)_52%,var(--line))]"
              aria-haspopup="dialog"
              disabled={actions === null || saving}
              onClick={() => {
                setCloseError(null);
                setClosing(active);
              }}
            >
              {say("plan.library.stop.action")}
            </Button>
            <Button
              variant="outline"
              className="border-line bg-surface"
              onClick={props.readDetails}
            >
              {say("plan.library.readDetails")}
            </Button>
            <Button
              ref={changeButton}
              disabled={actions === null}
              onClick={() => actions?.changeInChat()}
            >
              {say("plan.library.changeInChat")}
            </Button>
          </div>
        </LibraryCard>
      )}
      {closed.map((plan) => (
        <LibraryCard
          key={plan.planId}
          eyebrow={say("plan.library.closedPlan")}
          title={plan.name}
          status={say("plan.library.closed")}
          summary={say("plan.library.closedSummary", {
            span: spanLabel(plan, phrasebook, planDate),
            reason: say(
              plan.closeReason === "stopped"
                ? "plan.library.stopped"
                : plan.closeReason === "completed"
                  ? "plan.library.completed"
                  : "plan.library.unknownReason",
            ),
          })}
        >
          <div className="flex flex-wrap gap-inset px-4 pb-4">
            <Button
              variant="outline"
              className="border-line bg-surface"
              disabled={actions === null}
              onClick={() => props.readFinalDetails(plan.planId)}
            >
              {say("plan.library.readFinalDetails")}
            </Button>
          </div>
        </LibraryCard>
      ))}
      {legacy === null ? null : (
        <LibraryCard
          eyebrow={say("plan.library.closedPlan")}
          title={legacy.name}
          status={say("plan.library.closed")}
          summary={legacySummary(legacy, phrasebook, planDate)}
        >
          <p className="m-0 px-4 pb-4 text-sm leading-5 text-ink-2">
            {say("plan.library.legacyReadOnly")}
          </p>
        </LibraryCard>
      )}
    </section>
  );
}
