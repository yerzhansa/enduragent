import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { PlanCreationQuestionCard } from "./PlanCreationQuestionCard";
import { Card, CardContent } from "@enduragent/ui";
import { PlanCreationDraftCards } from "./PlanCreationDraftCards";
import { PlanCreationSummary } from "./PlanCreationSummary";

export function PlanCreationDiscardDialog(): ReactElement {
  const open = useEnduragentStore((state) => state.chat.planCreationDiscardConfirmationOpen);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const actions = useEnduragentStore((state) => state.chatActions);
  const keepCreating = useRef<HTMLButtonElement>(null);
  const cancelDiscard = useCallback((): void => {
    actions?.cancelPlanCreationDiscard();
  }, [actions]);
  const confirmDiscard = useCallback((): void => {
    actions?.confirmPlanCreationDiscard();
  }, [actions]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) cancelDiscard();
      }}
    >
      <DialogContent
        className="w-[min(520px,calc(100vw-32px))] max-w-none gap-0 border-line p-5 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={keepCreating}
        finalFocus={false}
        aria-busy={busy ? "true" : undefined}
      >
        <DialogHeader className="gap-inset">
          <DialogTitle className="m-0 text-lg font-semibold">
            Discard this Plan creation?
          </DialogTitle>
          <DialogDescription className="m-0 leading-5">
            No Plan is created. Your active Plan, Schedule, training restrictions, closed Plans,
            saved preferences, and chat history are unchanged.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p className="mt-inset mb-0 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="mx-0 mt-row mb-0 flex-row justify-end rounded-none border-0 bg-transparent p-0">
          <DialogClose
            render={
              <Button
                ref={keepCreating}
                variant="outline"
                size="lg"
                disabled={busy || actions === null}
              />
            }
          >
            Keep creating
          </DialogClose>
          <Button
            variant="destructive-solid"
            size="lg"
            disabled={busy || actions === null}
            onClick={confirmDiscard}
          >
            Discard creation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function calendarWindowEnd(now: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + 6);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function PlanCreationActivateDialog(): ReactElement | null {
  const open = useEnduragentStore((state) => state.chat.planCreationActivateConfirmationOpen);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const actions = useEnduragentStore((state) => state.chatActions);
  const knowledge = useEnduragentStore((state) => state.chat.planCreationActivePlanKnowledge);
  const activePlanName = knowledge.kind === "active" ? knowledge.name : null;
  const library = useEnduragentStore((state) => state.planLibrary.value);
  const libraryStatus = useEnduragentStore((state) => state.planLibrary.status);
  const libraryActions = useEnduragentStore((state) => state.planLibraryActions);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState<"checking" | "fresh" | "stale">("checking");
  useEffect(() => {
    if (!open) {
      setConnection("checking");
      return;
    }
    if (libraryActions === null) {
      setConnection("stale");
      return;
    }
    let cancelled = false;
    setConnection("checking");
    libraryActions.refresh().then(
      () => {
        if (!cancelled) setConnection("fresh");
      },
      () => {
        if (!cancelled) setConnection("stale");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, libraryActions]);
  const connected =
    connection === "fresh" && libraryStatus === "ready" && (library?.calendarConnected ?? false);
  const cancelActivation = useCallback((): void => {
    actions?.cancelPlanCreationActivate();
  }, [actions]);
  const confirmActivation = useCallback((): void => {
    actions?.confirmPlanCreationActivate();
  }, [actions]);

  if (knowledge.kind === "unknown") return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) cancelActivation();
      }}
    >
      <DialogContent
        className="w-[min(520px,calc(100vw-32px))] max-w-none gap-0 border-line p-5 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancelButton}
        finalFocus={false}
        aria-busy={busy ? "true" : undefined}
      >
        <DialogHeader className="gap-inset">
          <DialogTitle className="m-0 text-lg font-semibold">
            {activePlanName === null ? "Activate Plan?" : "Close and activate?"}
          </DialogTitle>
          <DialogDescription className="m-0 leading-5">
            {`${activePlanName === null ? "" : `${activePlanName} closes. Today’s calendar Workout stays. `}The new Plan activates now.`}
          </DialogDescription>
          {connection === "checking" ? null : (
            <p className="m-0 text-sm leading-5 text-ink-2">
              {connected
                ? `Dated Workouts sync from ${activePlanName === null ? "today" : "tomorrow"} through ${calendarWindowEnd(Date.now())}.`
                : "Calendar updates wait until intervals.icu is connected."}
            </p>
          )}
        </DialogHeader>
        {error === null ? null : (
          <p className="mt-inset mb-0 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="mx-0 mt-row mb-0 flex-row justify-end rounded-none border-0 bg-transparent p-0">
          <DialogClose
            render={
              <Button
                ref={cancelButton}
                variant="outline"
                size="lg"
                disabled={busy || actions === null}
              />
            }
          >
            Cancel
          </DialogClose>
          <Button
            variant="default"
            size="lg"
            disabled={busy || actions === null}
            onClick={confirmActivation}
          >
            {activePlanName === null ? "Activate Plan" : "Activate new Plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlanCreationDock(props: {
  readonly onEditorOpenChange: (open: boolean) => void;
}): ReactElement | null {
  const model = useEnduragentStore((state) => state.chat.planCreation);
  const loaded = useEnduragentStore((state) => state.chat.planCreationLoaded);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const focusRevision = useEnduragentStore((state) => state.chat.planCreationFocusRevision);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const decision = useEnduragentStore((state) => state.chat.decision);
  const actions = useEnduragentStore((state) => state.chatActions);
  const startButton = useRef<HTMLButtonElement>(null);
  const decisionPending =
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  useEffect(() => {
    if (focusRequest?.target === "start") startButton.current?.focus();
  }, [focusRequest?.revision, focusRequest?.target]);
  if (!loaded) return null;
  if (model === null) {
    return (
      <div className="flex min-w-0 justify-end gap-inset" data-parity="start.row">
        <Button
          ref={startButton}
          variant="outline"
          data-parity="start.button"
          disabled={busy || actions === null || decisionPending}
          onClick={() => actions?.startPlanCreation()}
        >
          Start a Plan
        </Button>
      </div>
    );
  }
  if (paused || (editingKey === null && model.openQuestion === null)) return null;
  const editedSummary =
    editingKey === null
      ? null
      : (model.answeredSummaries.find((summary) => summary.answerKey === editingKey) ?? null);
  const question = editedSummary?.question ?? model.openQuestion;
  if (question === null) return null;
  return (
    <PlanCreationQuestionCard
      key={`${model.creationId}:${model.version}:${editingKey ?? question.kind}`}
      question={question}
      currentAnswer={editedSummary?.answer ?? null}
      editing={editingKey !== null}
      busy={busy}
      error={error}
      focusRevision={focusRevision}
      onAnswer={(answer) => actions?.answerPlanCreation(answer)}
      onLater={() => actions?.pausePlanCreation()}
      onCancel={() => actions?.cancelPlanCreationEdit()}
      onEditorOpenChange={props.onEditorOpenChange}
    />
  );
}

export function PlanCreationConversation(props: {
  readonly model: PlanCreationCardModel | null;
}): ReactElement | null {
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const actions = useEnduragentStore((state) => state.chatActions);
  if (props.model === null)
    return (
      <p role="status" className="m-0 text-sm text-ink-2">
        Plan activated locally.
      </p>
    );
  const model = props.model;
  if (model.draft === null) return <PlanCreationSummary model={model} />;
  if (editVersion === model.version)
    return (
      <section className="grid min-w-0 gap-inset" aria-label="Edit Plan answers">
        <Card size="sm">
          <CardContent className="grid gap-inset">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
              Plan creation
            </p>
            <h3 className="m-0 text-base leading-6 font-semibold">Edit answers</h3>
            <p className="m-0 text-sm text-ink-2">A changed answer makes the Draft stale.</p>
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  actions?.cancelPlanCreationEdit();
                  setEditVersion(null);
                }}
              >
                Back to Draft
              </Button>
            </div>
          </CardContent>
        </Card>
        <PlanCreationSummary model={model} answersOnly />
      </section>
    );
  return (
    <>
      {editingKey !== null || model.openQuestion !== null ? (
        <PlanCreationSummary model={model} answersOnly />
      ) : null}
      <PlanCreationDraftCards
        model={model}
        draft={model.draft}
        onEditAnswers={() => setEditVersion(model.version)}
      />
    </>
  );
}

export function PlanCreationDiscardConsequence(props: { readonly eventId: string }): ReactElement {
  return (
    <article
      className="grid gap-[calc(var(--inset)/2)] rounded-ctl bg-surface-2 p-row"
      data-plan-creation-discard-event={props.eventId}
      data-parity="discarded.record"
    >
      <strong className="text-sm font-medium leading-5">Plan creation discarded</strong>
      <p className="m-0 text-xs leading-4 text-ink-2">
        No Plan was created. Your active Plan, Schedule, training restrictions, saved preferences,
        and chat history are unchanged.
      </p>
    </article>
  );
}
