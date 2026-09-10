import { chatFeedbackMessage } from "./copy";
import { usePhrasebook } from "@enduragent/i18n/react";
import { useChatDate } from "./use-chat-date";
import type {
  PlanCreationAnswerInput,
  PlanCreationCardModel,
  PlanCreationPendingCheck,
} from "@enduragent/coach-contract";
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
import { PlanCreationDraftCards, PlanCreationCommitmentCard } from "./PlanCreationDraftCards";
import { AnswerCheckCard } from "./AnswerCheckCard";
import { commitmentSummaryId } from "./PlanCreationDraftCards";
import { PlanCreationSummary } from "./PlanCreationSummary";
import { Notice } from "./Notice";

export function PlanCreationDiscardDialog(): ReactElement {
  const { say } = usePhrasebook();
  const open = useEnduragentStore((state) => state.chat.planCreationDiscardConfirmationOpen);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const errorMessage = error === null ? null : chatFeedbackMessage(error);
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
        className="w-[min(420px,calc(100vw-32px))] max-w-none gap-0 border-line p-4 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={keepCreating}
        finalFocus={false}
        aria-busy={busy ? "true" : undefined}
      >
        <DialogHeader className="gap-0">
          <DialogTitle className="mt-0 mb-inset text-lg font-semibold">
            {say("chat.planCreation.discardTitle")}
          </DialogTitle>
          <DialogDescription className="m-0 leading-5">
            {say("chat.planCreation.discardDetail")}
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p className="mt-inset mb-0 text-xs text-danger" role="alert">
            {errorMessage === null ? error : say(errorMessage)}
          </p>
        )}
        <DialogFooter className="mx-0 mt-row mb-0 flex-row justify-end rounded-none border-0 bg-transparent p-0">
          <DialogClose
            render={
              <Button
                ref={keepCreating}
                variant="outline"
                className="border-line bg-surface"
                size="default"
                disabled={busy || actions === null}
              />
            }
          >
            {say("chat.planCreation.keepCreating")}
          </DialogClose>
          <Button
            variant="destructive-solid"
            size="default"
            disabled={busy || actions === null}
            onClick={confirmDiscard}
          >
            {say("chat.planCreation.discardCreation")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlanCreationActivateDialog(): ReactElement | null {
  const { say } = usePhrasebook();
  const formatDate = useChatDate();
  const open = useEnduragentStore((state) => state.chat.planCreationActivateConfirmationOpen);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const errorMessage = error === null ? null : chatFeedbackMessage(error);
  const actions = useEnduragentStore((state) => state.chatActions);
  const knowledge = useEnduragentStore((state) => state.chat.planCreationActivePlanKnowledge);
  const calendarWindow = useEnduragentStore((state) => {
    const creation = state.planLibrary.value?.creation;
    return creation != null && creation.creationId === state.chat.planCreation?.creationId
      ? creation.calendarWindow
      : (state.chat.planCreation?.calendarWindow ?? null);
  });

  const library = useEnduragentStore((state) => state.planLibrary.value);
  const libraryStatus = useEnduragentStore((state) => state.planLibrary.status);
  const activePlanName = library?.active?.name ?? null;
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
        className="w-[min(420px,calc(100vw-32px))] max-w-none gap-0 border-line p-4 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancelButton}
        finalFocus={false}
        aria-busy={busy ? "true" : undefined}
      >
        <DialogHeader className="gap-0">
          <DialogTitle className="mt-0 mb-inset text-lg font-semibold">
            {activePlanName === null
              ? say("chat.planCreation.activateTitle")
              : say("chat.planCreation.replaceTitle")}
          </DialogTitle>
          <DialogDescription className="m-0 leading-5">
            {activePlanName === null
              ? say("chat.planCreation.activateDetail")
              : say("chat.planCreation.replaceDetail", { name: activePlanName })}
          </DialogDescription>
          {connection === "checking" ? null : (
            <p className="mt-inset mb-0 text-sm leading-5 text-ink-2">
              {calendarWindow !== null
                ? activePlanName === null
                  ? say("chat.planCreation.syncToday", { date: formatDate(calendarWindow.endDate) })
                  : say("chat.planCreation.syncTomorrow", {
                      date: formatDate(calendarWindow.endDate),
                    })
                : say("chat.planCreation.syncWait", { service: "intervals.icu" })}
            </p>
          )}
        </DialogHeader>
        {error === null ? null : (
          <p className="mt-inset mb-0 text-xs text-danger" role="alert">
            {errorMessage === null ? error : say(errorMessage)}
          </p>
        )}
        <DialogFooter className="mx-0 mt-row mb-0 flex-row justify-end rounded-none border-0 bg-transparent p-0">
          <DialogClose
            render={
              <Button
                ref={cancelButton}
                variant="outline"
                className="border-line bg-surface"
                size="default"
                disabled={busy || actions === null}
              />
            }
          >
            {say("chat.planCreation.cancel")}
          </DialogClose>
          <Button
            variant="default"
            size="default"
            disabled={
              busy ||
              actions === null ||
              connection !== "fresh" ||
              libraryStatus !== "ready" ||
              library === null
            }
            onClick={confirmActivation}
          >
            {activePlanName === null
              ? say("chat.planCreation.activate")
              : say("chat.planCreation.activateNew")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function pendingCheckAnswer(check: PlanCreationPendingCheck): PlanCreationAnswerInput {
  const submission = check.submission;
  switch (submission.field) {
    case "commitments":
      return { kind: "commitments", commitments: { kind: "interpreted", text: submission.text } };
    case "success":
      return { kind: "success", success: { kind: "authored", text: submission.text } };
    case "event":
      return {
        kind: "goal",
        goal: { kind: "event-manual", name: submission.text, date: submission.date },
      };
  }
}

function checkNeutralDefault(model: PlanCreationCardModel): string {
  if (model.pendingCheck?.submission.field === "commitments") {
    const answer = model.answeredSummaries.find(
      (summary) => summary.answerKey === "commitments",
    )?.answer;
    return answer?.kind === "commitments" &&
      answer.commitments.kind === "interpreted" &&
      answer.commitments.status === "confirmed"
      ? "keep my confirmed commitments"
      : "nothing fixed";
  }
  const goal = model.answeredSummaries.find((summary) => summary.answerKey === "goal")?.answer;
  return goal?.kind === "goal" && goal.goal.kind !== "fitness"
    ? "finish comfortably"
    : "train consistently";
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
  const actions = useEnduragentStore((state) => state.chatActions);
  useEffect(() => {
    if (focusRequest?.target === "start") {
      queueMicrotask(() => document.getElementById("message")?.focus());
    }
  }, [focusRequest?.revision, focusRequest?.target]);
  if (!loaded) return null;
  if (model === null) return null;
  if (paused) return null;
  if (editingKey === null && model.pendingCheck !== null) {
    const check = model.pendingCheck;
    return (
      <section aria-label="Plan creation dock" data-plan-creation-dock>
        <AnswerCheckCard
          check={error === null ? check : { ...check, state: "error", message: error }}
          neutralDefault={checkNeutralDefault(model)}
          summaryId={commitmentSummaryId(model)}
          disabled={busy || actions === null}
          focusRevision={focusRevision}
          onAction={(action) =>
            actions?.answerPlanCreation({ kind: "check-action", checkId: check.checkId, action })
          }
          onEdit={() =>
            actions?.editPlanCreation(
              check.submission.field === "event" ? "goal" : check.submission.field,
            )
          }
        />
      </section>
    );
  }
  if (editingKey === null && model.pendingCommitment !== null) {
    return (
      <section aria-label="Plan creation dock" data-plan-creation-dock>
        <PlanCreationCommitmentCard model={model} />
      </section>
    );
  }
  if (editingKey === null && model.openQuestion === null) return null;
  const editedSummary =
    editingKey === null
      ? null
      : (model.answeredSummaries.find((summary) => summary.answerKey === editingKey) ?? null);
  const question = editedSummary?.question ?? model.openQuestion;
  if (question === null) return null;
  return (
    <section aria-label="Plan creation dock" data-plan-creation-dock>
      <PlanCreationQuestionCard
        key={`${model.creationId}:${model.version}:${editingKey ?? question.kind}`}
        question={question}
        currentAnswer={
          model.pendingCheck !== null && editingKey !== null
            ? pendingCheckAnswer(model.pendingCheck)
            : question.kind === "commitments-question" && model.pendingCommitment !== null
              ? {
                  kind: "commitments",
                  commitments: { kind: "interpreted", text: model.pendingCommitment.text },
                }
              : (editedSummary?.answer ?? null)
        }
        commitmentStatus={
          model.pendingCheck?.submission.field === "commitments" &&
          model.pendingCheck.state === "ready" &&
          model.pendingCheck.result.outcome === "ask"
            ? "clarify"
            : model.pendingCommitment?.status
        }
        editing={editingKey !== null}
        busy={busy}
        error={error}
        focusRevision={focusRevision}
        onAnswer={(answer) => actions?.answerPlanCreation(answer)}
        onLater={() => actions?.pausePlanCreation()}
        onCancel={() => actions?.cancelPlanCreationEdit()}
        onEditorOpenChange={props.onEditorOpenChange}
      />
    </section>
  );
}

export function PlanCreationConversation(props: {
  readonly model: PlanCreationCardModel | null;
}): ReactElement | null {
  const { say } = usePhrasebook();
  if (props.model === null) return null;
  return (
    <section className="grid min-w-0 gap-4" aria-label={say("chat.planCreation.title")}>
      <Notice inPlanCreation />
      <PlanCreationConversationContent model={props.model} />
    </section>
  );
}

function PlanCreationConversationContent(props: {
  readonly model: PlanCreationCardModel | null;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const actions = useEnduragentStore((state) => state.chatActions);
  if (props.model === null) return null;
  const model = props.model;
  if (model.draft === null) return <PlanCreationSummary model={model} />;
  if (editVersion === model.version && model.pendingCheck === null)
    return (
      <section
        className="grid min-w-0 gap-inset"
        aria-label={say("chat.planCreation.editAnswersLabel")}
      >
        <Card size="sm">
          <CardContent className="grid gap-inset">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
              {say("chat.planCreation.title")}
            </p>
            <h3 className="m-0 text-base leading-6 font-semibold">
              {say("chat.planCreation.editAnswers")}
            </h3>
            <p className="m-0 text-sm text-ink-2">{say("chat.planCreation.editStale")}</p>
            <div>
              <Button
                variant="outline"
                className="border-line bg-surface"
                onClick={() => {
                  actions?.cancelPlanCreationEdit("edit");
                  setEditVersion(null);
                }}
              >
                {say("chat.planCreation.backToDraft")}
              </Button>
            </div>
          </CardContent>
        </Card>
        <PlanCreationSummary model={model} />
      </section>
    );
  return (
    <>
      {editingKey !== null || model.openQuestion !== null ? (
        <PlanCreationSummary model={model} />
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
  const { say } = usePhrasebook();
  return (
    <article
      className="block gap-row rounded-ctl bg-surface-2 p-row"
      data-plan-creation-discard-event={props.eventId}
      data-parity="discarded.record"
    >
      <strong className="text-sm font-semibold leading-5">
        {say("chat.planCreation.discarded")}
      </strong>
      <p className="mt-1 mb-0 text-xs leading-4 text-ink-2">
        {say("chat.planCreation.discardConsequence")}
      </p>
    </article>
  );
}
