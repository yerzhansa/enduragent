import type { ListPlansResult, PlanCreationCardModel } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { useRef, type ReactElement } from "react";
import type { ChatTranscriptItemView, PlanChangeSurfaceState } from "../../state/chat-slice";
import { useEnduragentStore } from "../../state/store";
import { CoachDecisionPanel } from "./CoachDecisionPanel";
import { CoachProgress } from "./Notice";
import { HistoryControls } from "./HistoryControls";
import { PlanChangeCards, PlanChangeCheckDock } from "./PlanChangeCards";
import { PlanCreationConversation, PlanCreationDock } from "./PlanCreationCards";
import { TranscriptItem, transcriptItemKey } from "./Transcript";
import {
  chronologicalConversationPredecessor,
  conversationDateStartTime,
  conversationProjectionKey,
  conversationUlidTime,
  createConversationInsertionLedger,
  forgetConversationProjection,
  orderConversationRows,
  recoverConversationPredecessor,
  resetConversationInsertionLedger,
  type ConversationInsertionLedger,
  type ConversationProjection,
} from "./conversation-timeline";

function planChangeSurfaceVisible(
  library: ListPlansResult | null,
  state: PlanChangeSurfaceState,
): boolean {
  if (library === null) return false;
  const active = library.active;
  if (active === null || active === undefined) return false;
  const pending = library.changes.find((change) => change.status === "pending");
  if (
    library.creation !== null &&
    pending === undefined &&
    !(state.open && state.planId === active.planId)
  ) {
    return false;
  }
  return true;
}

function planCreationDockVisible(input: {
  readonly loaded: boolean;
  readonly paused: boolean;
  readonly model: PlanCreationCardModel | null;
  readonly editing: boolean;
}): boolean {
  return (
    input.loaded &&
    !input.paused &&
    input.model !== null &&
    (input.editing ||
      input.model.pendingCheck !== null ||
      input.model.pendingCommitment !== null ||
      input.model.openQuestion !== null)
  );
}

function usePlanCreationModel(): PlanCreationCardModel | null {
  return useEnduragentStore((state) => state.chat.planCreation);
}

function transcriptItemOccurredAtMs(item: ChatTranscriptItemView): number | undefined {
  switch (item.kind) {
    case "message":
      return item.message.occurredAtMs;
    case "choice":
      return item.choice.occurredAtMs;
    case "planning-request":
      return item.delivery.createdAtMs;
    case "plan-creation":
      return item.model === null
        ? undefined
        : (conversationUlidTime(item.model.creationId) ?? undefined);
    case "plan-creation-discard":
      return undefined;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

export function ConversationTimeline(props: {
  readonly onDecisionEditorOpenChange: (open: boolean) => void;
  readonly onPlanCreationEditorOpenChange: (open: boolean) => void;
  readonly onPlanChangeEditorOpenChange: (open: boolean) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const timeline = useEnduragentStore((state) => state.chat.timeline);
  const messages = useEnduragentStore((state) => state.chat.messages);
  const resetCount = useEnduragentStore((state) => state.chat.resetCount);
  const hydrationStatus = useEnduragentStore((state) => state.chat.hydrationStatus);
  const planCreation = usePlanCreationModel();
  const planCreationLoaded = useEnduragentStore((state) => state.chat.planCreationLoaded);
  const planCreationPaused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const planCreationEditing = useEnduragentStore(
    (state) => state.chat.planCreationEditingKey !== null,
  );
  const decision = useEnduragentStore((state) => state.chat.decision);
  const decisionPhase = useEnduragentStore((state) => state.chat.decisionPhase);
  const decisionLoadError = useEnduragentStore((state) => state.chat.decisionLoadError);
  const coachProgress = useEnduragentStore((state) => state.chat.coachProgress);
  const library = useEnduragentStore((state) => state.planLibrary.value);
  const planChange = useEnduragentStore((state) => state.planChange);
  const insertionLedger = useRef<ConversationInsertionLedger>(
    createConversationInsertionLedger(resetCount),
  );
  const pendingPlanChangeCheck =
    planChange.pendingCheck === undefined ? library?.pendingChangeCheck : planChange.pendingCheck;
  const items =
    timeline.length > 0
      ? timeline
      : messages.map((message) => ({ kind: "message" as const, message }));
  const durable = items
    .filter((item) => item.kind !== "planning-request" && item.kind !== "plan-creation")
    .map((item) => ({
      key: transcriptItemKey(item),
      value: item,
      occurredAtMs: transcriptItemOccurredAtMs(item),
    }));
  const projections: Array<{
    readonly projection: ConversationProjection;
    readonly value: ReactElement;
    readonly afterKey?: string | null;
  }> = [];

  let previousTimelineKey: string | null = null;
  for (const item of items) {
    if (item.kind === "planning-request") {
      const projection = { kind: "planning-request", id: item.delivery.requestId } as const;
      projections.push({
        projection,
        value: <TranscriptItem item={item} bufferedStreaming />,
        afterKey: recoverConversationPredecessor(
          durable,
          transcriptItemOccurredAtMs(item) ?? null,
          previousTimelineKey,
        ),
      });
      previousTimelineKey = conversationProjectionKey(projection);
    } else if (item.kind === "plan-creation" && item.model !== null) {
      const projection = { kind: "plan-creation", id: item.model.creationId } as const;
      projections.push({
        projection,
        value: <PlanCreationConversation model={item.model} />,
        afterKey: recoverConversationPredecessor(
          durable,
          transcriptItemOccurredAtMs(item) ?? null,
          previousTimelineKey,
        ),
      });
      previousTimelineKey = conversationProjectionKey(projection);
    } else if (item.kind !== "plan-creation") {
      previousTimelineKey = transcriptItemKey(item);
    }
  }

  if (planChangeSurfaceVisible(library, planChange) && library?.active != null) {
    const currentCardsVisible =
      planChange.editorOpen ||
      (!planChange.editorOpen && planChange.error !== null) ||
      library.active.todayChoice != null;
    if (currentCardsVisible) {
      projections.push({
        projection: { kind: "plan-change-current", id: library.active.planId },
        value: <PlanChangeCards changeId={null} labelled={false} />,
        afterKey: chronologicalConversationPredecessor(
          durable,
          library.active.todayChoice === null
            ? null
            : conversationDateStartTime(
                library.active.todayChoice.date,
                library.active.todayChoice.timezone ??
                  Intl.DateTimeFormat().resolvedOptions().timeZone ??
                  "UTC",
              ),
        ),
      });
    }
    for (const change of library.changes) {
      projections.push({
        projection: { kind: "plan-change", id: change.changeId },
        value: <PlanChangeCards changeId={change.changeId} labelled={false} />,
        afterKey: chronologicalConversationPredecessor(
          durable,
          conversationUlidTime(change.changeId),
        ),
      });
    }
  }
  if (coachProgress !== null) {
    const activeRow = durable.at(-1)?.key ?? "current";
    projections.push({
      projection: { kind: "coach-progress", id: activeRow },
      value: <CoachProgress />,
    });
  }
  const decisionVisible =
    (decision !== null &&
      (decision.status === "unanswered" ||
        decisionPhase !== "idle" ||
        (decision.status === "answered" && decision.continuation.status === "pending"))) ||
    (decision === null && decisionLoadError !== null);
  if (decisionVisible) {
    projections.push({
      projection:
        decision === null
          ? { kind: "coach-decision-availability" }
          : { kind: "coach-decision", id: decision.decisionId },
      value: <CoachDecisionPanel onCustomOpenChange={props.onDecisionEditorOpenChange} />,
    });
  }
  if (
    planCreationDockVisible({
      loaded: planCreationLoaded,
      paused: planCreationPaused,
      model: planCreation,
      editing: planCreationEditing,
    }) &&
    planCreation !== null
  ) {
    projections.push({
      projection: { kind: "plan-creation-dock", id: planCreation.creationId },
      value: <PlanCreationDock onEditorOpenChange={props.onPlanCreationEditorOpenChange} />,
    });
  }
  if (library?.active != null && pendingPlanChangeCheck != null) {
    projections.push({
      projection: { kind: "plan-change-check", id: pendingPlanChangeCheck.checkId },
      value: <PlanChangeCheckDock onEditorOpenChange={props.onPlanChangeEditorOpenChange} />,
      afterKey: chronologicalConversationPredecessor(
        durable,
        conversationUlidTime(pendingPlanChangeCheck.checkId),
      ),
    });
  }

  if (insertionLedger.current.resetCount !== resetCount) {
    insertionLedger.current = resetConversationInsertionLedger({
      previous: insertionLedger.current,
      resetCount,
      projections: projections.map((entry) => entry.projection),
    });
  }
  if (decision !== null || decisionLoadError === null) {
    forgetConversationProjection(insertionLedger.current, {
      kind: "coach-decision-availability",
    });
  }
  const rows = orderConversationRows({
    durable,
    projections,
    ledger: insertionLedger.current,
    rememberNewPlacements: hydrationStatus === "ready",
  });
  return (
    <section
      className="chat-transcript grid gap-[18px]"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label={say("chat.transcript.label")}
    >
      <HistoryControls />
      <div className="chat-messages grid gap-7">
        {rows.map((row) =>
          row.kind === "durable" ? (
            <TranscriptItem key={row.key} item={row.value} bufferedStreaming />
          ) : (
            <div
              key={row.key}
              data-conversation-projection={conversationProjectionKey(row.projection)}
            >
              {row.value}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
