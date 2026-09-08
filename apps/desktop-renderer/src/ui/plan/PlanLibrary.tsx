import type { LegacyPlanSummary, ListPlansResult, PlanSummary } from "@enduragent/coach-contract";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY } from "../../chat/controller";
import { Button } from "@enduragent/ui";
import { Card, CardContent, CardHeader } from "@enduragent/ui";
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

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function LibraryCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <Card
      size="sm"
      className="block min-w-0 gap-[normal] py-0"
      role="region"
      aria-label={props.eyebrow ?? props.title}
    >
      <CardHeader className="block rounded-none p-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0 justify-self-start">
            {props.eyebrow ? (
              <p
                data-plan-card-eyebrow
                className="mt-0 mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2"
              >
                {props.eyebrow}
              </p>
            ) : null}
            <h3 data-plan-card-title className="m-0 text-base leading-6 font-semibold break-words">
              {props.title}
            </h3>
          </div>
          {props.status ? (
            <span
              data-plan-card-status
              className="inline-flex shrink-0 items-center gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2"
            >
              {props.status}
            </span>
          ) : null}
        </div>
        <p data-plan-card-summary className="mt-inset mb-0 text-sm leading-5 text-ink-2">
          {props.summary}
        </p>
      </CardHeader>
      {props.children ? <CardContent className="p-0">{props.children}</CardContent> : null}
    </Card>
  );
}

function CalendarStatus(props: {
  readonly calendar: PlanSummary["calendar"];
  readonly retry: (() => Promise<void>) | undefined;
}): ReactElement {
  const { calendar } = props;
  if (calendar.status === "failed") {
    const retryAvailable = calendar.error.endsWith("Retry available.");
    return (
      <div className="mx-4 mb-inset grid gap-inset">
        <p role="alert" className="m-0 text-sm text-danger">
          {retryAvailable ? "Calendar sync failed. Retry available." : "Calendar sync failed."}
        </p>
        {retryAvailable ? (
          <div>
            <Button
              variant="outline"
              className="border-line bg-surface"
              disabled={props.retry === undefined}
              onClick={() => void props.retry?.()}
            >
              Retry calendar
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  let label: string;
  switch (calendar.status) {
    case "verified":
      label =
        calendar.window === null
          ? "Up to date"
          : `${dateLabel(calendar.window.start)} to ${dateLabel(calendar.window.end)} · Up to date`;
      break;
    case "pending":
      label = calendar.window === null ? "Local only" : "Updating calendar";
      break;
    case "running":
      label = "Updating calendar";
      break;
    case "not-connected":
      label = "Connect to mirror Workouts";
      break;
  }
  return (
    <p role="status" className="mx-4 mt-0 mb-inset text-sm leading-5 text-ink-2">
      Calendar · {label}
    </p>
  );
}

function spanLabel(plan: PlanSummary): string {
  return `${dateLabel(plan.start)} to ${dateLabel(plan.end)} · ${plan.weeks} weeks`;
}

function legacySummary(legacy: LegacyPlanSummary): string {
  const parts: string[] = [];
  if (legacy.targetDate !== null) parts.push(`Target ${dateLabel(legacy.targetDate)}`);
  if (legacy.weeks !== null) parts.push(`${legacy.weeks} ${legacy.weeks === 1 ? "week" : "weeks"}`);
  if (legacy.goal !== null) parts.push(`Goal: ${legacy.goal}`);
  parts.push("Unknown reason");
  return parts.join(" · ");
}

export function PlanLibrary(props: {
  readonly library: ListPlansResult;
  readonly readDetails: () => void;
  readonly readFinalDetails: (planId: string, justClosed?: boolean) => void;
}): ReactElement {
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
  const [closeError, setCloseError] = useState<string | null>(null);
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
        setCloseError(
          "Stopping could not be confirmed. The library will show the current state after refresh.",
        );
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
        setCloseError("The Plan changed. Review its current details before stopping.");
        void actions.refresh();
      } else {
        setCloseError("Stopping could not be saved locally. Your Plan is unchanged.");
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
    <section aria-label="Plan library" className="grid min-w-0 gap-4">
      {closeError === null || closing !== null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {closeError}
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
            <DialogTitle className="m-0 text-lg font-semibold">Stop this Plan?</DialogTitle>
            <DialogDescription className="m-0 leading-5">
              Final training stays readable. Calendar cleanup can finish later.
            </DialogDescription>
          </DialogHeader>
          {closeError === null ? null : (
            <p className="mt-inset mb-0 text-xs text-danger" role="alert">
              {closeError}
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
              Cancel
            </DialogClose>
            <Button
              variant="destructive-solid"
              size="lg"
              disabled={
                saving || actions === null || (closeError !== null && closeAttempt === null)
              }
              onClick={() => void confirmClose()}
            >
              Stop Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {notice !== CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY ? null : (
        <p role="status" className="m-0 text-sm text-ink-2">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
      {creation === null ? null : (
        <LibraryCard
          eyebrow="Plan creation"
          title={creationTitle(creation)}
          status={
            creation.draft !== null
              ? "Draft"
              : paused && chatCreation?.creationId === creation.creationId
                ? "Paused"
                : "In progress"
          }
          summary={`${creation.answeredSummaries.length} of ${total} answered. ${active === null ? "No Plan is active." : `${active.name} keeps running.`}`}
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
              Discard
            </Button>
            <Button
              ref={continueButton}
              disabled={busy || actions === null}
              onClick={() => actions?.continueCreation(creation)}
            >
              Continue in Chat
            </Button>
          </div>
        </LibraryCard>
      )}
      {active === null ? (
        <LibraryCard title="No active Plan" summary="Create a Plan when you are ready." />
      ) : (
        <LibraryCard
          eyebrow="Active Plan"
          title={active.name}
          status="Active"
          summary={spanLabel(active)}
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
              Stop Plan
            </Button>
            <Button
              variant="outline"
              className="border-line bg-surface"
              onClick={props.readDetails}
            >
              Read Plan details
            </Button>
            <Button
              ref={changeButton}
              disabled={actions === null}
              onClick={() => actions?.changeInChat()}
            >
              Change in Chat
            </Button>
          </div>
        </LibraryCard>
      )}
      {closed.map((plan) => (
        <LibraryCard
          key={plan.planId}
          eyebrow="Closed Plan"
          title={plan.name}
          status="Closed"
          summary={`${spanLabel(plan)} · ${plan.closeReason === "stopped" ? "Stopped" : plan.closeReason === "completed" ? "Completed" : "Unknown reason"}`}
        >
          <div className="flex flex-wrap gap-inset px-4 pb-4">
            <Button
              variant="outline"
              className="border-line bg-surface"
              disabled={actions === null}
              onClick={() => props.readFinalDetails(plan.planId)}
            >
              Read final details
            </Button>
          </div>
        </LibraryCard>
      ))}
      {legacy === null ? null : (
        <LibraryCard
          eyebrow="Closed Plan"
          title={legacy.name}
          status="Closed"
          summary={legacySummary(legacy)}
        >
          <p className="m-0 px-4 pb-4 text-sm leading-5 text-ink-2">
            Read only · Saved before Plans moved to Chat
          </p>
        </LibraryCard>
      )}
    </section>
  );
}
