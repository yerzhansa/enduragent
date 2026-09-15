import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import {
  currentPlanChangeCardsVisible,
  planChangeCardsAllowed,
  planChangePendingCheck,
  type ChatTranscriptItemView,
} from "../../state/chat-slice";
import { useEnduragentStore } from "../../state/store";
import { CoachDecisionPanel } from "./CoachDecisionPanel";
import { CoachProgress } from "./Notice";
import { HistoryControls } from "./HistoryControls";
import { CurrentPlanChangeCards, PlanChangeCard, PlanChangeCheckDock } from "./PlanChangeCards";
import { PlanCreationDock } from "./PlanCreationCards";
import { TranscriptItem, transcriptItemKey } from "./Transcript";
import {
  conversationProjectionKey,
  conversationUlidTime,
  orderConversationRows,
  type ConversationProjectionRow,
} from "./conversation-timeline";

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

function restoredCardProjection(
  item: ChatTranscriptItemView,
): ConversationProjectionRow<ReactElement> | null {
  const occurredAtMs = transcriptItemOccurredAtMs(item);
  if (occurredAtMs === undefined) return null;
  if (item.kind === "planning-request") {
    return {
      projection: { kind: "planning-request", id: item.delivery.requestId },
      value: <TranscriptItem item={item} bufferedStreaming />,
      occurredAtMs,
    };
  }
  if (item.kind === "plan-creation" && item.model !== null) {
    return {
      projection: { kind: "plan-creation", id: item.model.creationId },
      value: <TranscriptItem item={item} bufferedStreaming />,
      occurredAtMs,
    };
  }
  return null;
}

export function ConversationTimeline(props: {
  readonly onDecisionEditorOpenChange: (open: boolean) => void;
  readonly onPlanCreationEditorOpenChange: (open: boolean) => void;
  readonly onPlanChangeEditorOpenChange: (open: boolean) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const timeline = useEnduragentStore((state) => state.chat.timeline);
  const messages = useEnduragentStore((state) => state.chat.messages);
  const planCreation = useEnduragentStore((state) => state.chat.planCreation);
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
  const pendingPlanChangeCheck = planChangePendingCheck(planChange, library);
  const items =
    timeline.length > 0
      ? timeline
      : messages.map((message) => ({ kind: "message" as const, message }));
  const timedConversation = items.every(
    (item) => item.kind !== "message" || item.message.occurredAtMs !== undefined,
  );
  const restored = new Map<ChatTranscriptItemView, ConversationProjectionRow<ReactElement>>();
  if (timedConversation) {
    for (const item of items) {
      const card = restoredCardProjection(item);
      if (card !== null) restored.set(item, card);
    }
  }
  const durable = items
    .filter((item) => !restored.has(item))
    .map((item) => ({
      key: transcriptItemKey(item),
      value: item,
      occurredAtMs: transcriptItemOccurredAtMs(item),
    }));
  const projections: ConversationProjectionRow<ReactElement>[] = [...restored.values()];

  if (planChangeCardsAllowed(planChange, library) && library?.active != null) {
    if (currentPlanChangeCardsVisible(planChange, library)) {
      projections.push({
        projection: { kind: "plan-change-current", id: library.active.planId },
        value: <CurrentPlanChangeCards />,
        occurredAtMs: library.active.todayChoice?.dayStartMs ?? null,
      });
    }
    for (const change of library.changes) {
      projections.push({
        projection: { kind: "plan-change", id: change.changeId },
        value: <PlanChangeCard change={change} />,
        occurredAtMs: conversationUlidTime(change.changeId),
      });
    }
  }
  if (coachProgress !== null) {
    projections.push({
      projection: { kind: "coach-progress" },
      value: <CoachProgress />,
      occurredAtMs: null,
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
      occurredAtMs: null,
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
      occurredAtMs: null,
    });
  }
  if (library?.active != null && pendingPlanChangeCheck !== null) {
    projections.push({
      projection: { kind: "plan-change-check", id: pendingPlanChangeCheck.checkId },
      value: <PlanChangeCheckDock onEditorOpenChange={props.onPlanChangeEditorOpenChange} />,
      occurredAtMs: conversationUlidTime(pendingPlanChangeCheck.checkId),
    });
  }

  const rows = orderConversationRows({ durable, projections });
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
