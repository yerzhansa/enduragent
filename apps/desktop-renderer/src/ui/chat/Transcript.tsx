import { usePhrasebook } from "@enduragent/i18n/react";
import { msg, type Message } from "@enduragent/i18n";
import { ChatTurn } from "@enduragent/ui";
import {
  Activity,
  CalendarDays,
  Check,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  X,
} from "lucide-react";
import type { ReactElement } from "react";
import type { PlanHandoffSuggestion, PlanningRequestDelivery } from "@enduragent/coach-contract";
import type {
  ChatChoiceView,
  ChatMessageView,
  ChatTranscriptItemView,
} from "../../state/chat-slice";
import { cn } from "@enduragent/ui";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { AthleteMessage } from "./AthleteMessage";
import { CoachMessage } from "./CoachMessage";
import { HistoryControls } from "./HistoryControls";
import { PlanReferenceCard } from "./PlanReferenceCard";
import { StreamingMessage } from "./StreamingMessage";
import { PlanCreationConversation, PlanCreationDiscardConsequence } from "./PlanCreationCards";

function planHandoffSummary(suggestion: PlanHandoffSuggestion): Message {
  if (suggestion.kind === "plan_creation") {
    return msg("chat.transcript.handoff.creation");
  }
  if (suggestion.kind === "plan_change") {
    return msg("chat.transcript.handoff.change");
  }
  return msg("chat.transcript.handoff.question");
}

function PlanHandoffCard(props: {
  readonly messageId: string;
  readonly suggestion: PlanHandoffSuggestion;
}): ReactElement {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.chatActions);
  const loaded = useEnduragentStore((state) => state.chat.planningRequestsLoaded);
  const busyId = useEnduragentStore((state) => state.chat.planningRequestBusyId);
  return (
    <aside className="mt-row grid gap-row rounded-card border border-line-2 bg-surface p-5 shadow-elev-1">
      <div className="grid gap-inset">
        <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
          {say("chat.transcript.continue")}
        </p>
        <h3 className="m-0 text-base font-semibold leading-6">{props.suggestion.title}</h3>
        <p className="m-0 text-sm leading-5 text-ink-2">
          {say(planHandoffSummary(props.suggestion))}
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={actions === null || !loaded || busyId !== null}
          onClick={() => actions?.continueMessageInPlan(props.messageId, props.suggestion)}
        >
          {say("chat.transcript.continue")}
        </Button>
      </div>
    </aside>
  );
}

function MessageRow(props: {
  readonly message: ChatMessageView;
  readonly bufferedStreaming: boolean;
}): ReactElement {
  const { say } = usePhrasebook();
  const message = props.message;
  const sourceMessageId = message.turnId ?? message.id;
  const handoffDelivery = useEnduragentStore((state) =>
    state.chat.planningRequests.find(
      (delivery) =>
        delivery.source?.messageId === sourceMessageId && delivery.state !== "cancelled",
    ),
  );
  const hasActivePlan = useEnduragentStore((state) => state.planLibrary.value?.active != null);
  const streaming = message.role === "coach" && message.delivery === "streaming";
  const silent = message.historical || message.role === "athlete";

  return (
    <ChatTurn
      speaker={message.role}
      label={
        message.role === "athlete"
          ? say("chat.transcript.athleteLabel")
          : say("chat.transcript.coachLabel")
      }
      data-message-id={message.id}
      data-delivery={message.delivery}
      aria-live={silent ? "off" : undefined}
      aria-atomic={message.role === "coach" ? "true" : "false"}
      aria-busy={streaming ? "true" : undefined}
    >
      {message.role === "athlete" ? (
        <div className="grid gap-2.5">
          {message.attachments?.map((attachment) => {
            const Icon =
              attachment.kind === "activity"
                ? Activity
                : attachment.kind === "workout"
                  ? CalendarDays
                  : attachment.kind === "image"
                    ? ImageIcon
                    : FileText;
            return (
              <div
                key={attachment.attachmentId}
                className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-2.5 rounded-md bg-bg-2 p-2.5"
              >
                <span className="flex size-8 items-center justify-center text-ink-2">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm leading-5">
                    {attachment.displayName}
                  </strong>
                  <small className="block text-xs leading-4 text-ink-2">
                    {attachment.extension.toUpperCase()}
                  </small>
                </span>
              </div>
            );
          })}
          {message.text.length === 0 ? null : <AthleteMessage text={message.text} />}
        </div>
      ) : streaming && props.bufferedStreaming && message.message === undefined ? (
        <StreamingMessage messageId={message.id} />
      ) : (
        <div className="min-w-0">
          <CoachMessage text={message.text} message={message.message} />
          {message.planReference === undefined ? null : (
            <PlanReferenceCard selection={message.planReference} />
          )}
          {message.planHandoff === undefined ||
          handoffDelivery !== undefined ||
          (hasActivePlan && message.planHandoff.kind === "plan_change") ? null : (
            <PlanHandoffCard messageId={sourceMessageId} suggestion={message.planHandoff} />
          )}
        </div>
      )}
    </ChatTurn>
  );
}

function ChoiceRow(props: { readonly choice: ChatChoiceView }): ReactElement {
  const { say } = usePhrasebook();
  const choice = props.choice;
  return (
    <article
      className="grid grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-2.5 rounded-card bg-sunk p-3"
      aria-label={say("chat.transcript.choice")}
      aria-live={choice.historical ? "off" : undefined}
    >
      <span
        className={cn(
          "grid size-8 place-items-center rounded-full",
          choice.skipped ? "bg-surface-2 text-ink-2" : "bg-ok/16 text-ok",
        )}
      >
        {choice.skipped ? (
          <X className="size-4" aria-hidden="true" />
        ) : (
          <Check className="size-4" aria-hidden="true" />
        )}
      </span>
      <div className="grid gap-[calc(var(--inset)/2)]">
        <p className="m-0 text-xs font-semibold leading-4 text-ink-2">
          {say("chat.transcript.choice")}
        </p>
        <strong className="text-sm font-medium leading-5">
          {choice.skipped ? say("chat.notice.questionSkipped") : choice.label}
        </strong>
        {choice.consequence === null ? null : (
          <p className="m-0 text-xs leading-4 text-ink-2">
            {choice.skipped ? say("chat.notice.choiceUnchanged") : choice.consequence}
          </p>
        )}
      </div>
    </article>
  );
}

function planningRequestStatus(delivery: PlanningRequestDelivery): Message {
  if (delivery.state === "pending") return msg("chat.transcript.status.opening");
  if (delivery.state === "failed") return msg("chat.transcript.status.failed");
  const request = delivery.planningRequest;
  if (request === null) return msg("chat.transcript.request");
  if (request.lifecycle === "applied") return msg("chat.transcript.status.applied");
  if (request.lifecycle === "rejected" || request.lifecycle === "ended")
    return msg("chat.transcript.status.notAdded");
  if (request.attention === "date_conflict") return msg("chat.transcript.status.dateConflict");
  if (request.attention === "revalidating") return msg("chat.transcript.status.checking");
  if (request.attention === "stale_base") return msg("chat.transcript.status.updated");
  if (request.attention === "apply_failed") return msg("chat.transcript.status.saveFailed");
  if (request.proposalId !== null) return msg("chat.transcript.status.review");
  return msg("chat.transcript.continue");
}

function planningRequestSummary(delivery: PlanningRequestDelivery): Message | string {
  const request = delivery.planningRequest;
  if (delivery.state === "pending") return msg("chat.transcript.summary.opening");
  if (delivery.state === "failed") {
    return delivery.retryable
      ? msg("chat.transcript.summary.retry")
      : msg("chat.transcript.summary.failed");
  }
  if (request?.terminalResult !== null && request?.terminalResult !== undefined) {
    return request.terminalResult.detail;
  }
  if (request?.attention === "apply_failed") {
    return msg("chat.transcript.summary.applyFailed");
  }
  if (request?.target === "draft") {
    return msg("chat.transcript.summary.draft");
  }
  if (request?.target === "plan_creation") {
    return msg("chat.transcript.summary.creation");
  }
  return msg("chat.transcript.summary.review");
}

function PlanningRequestRow(props: { readonly delivery: PlanningRequestDelivery }): ReactElement {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.chatActions);
  const busyId = useEnduragentStore((state) => state.chat.planningRequestBusyId);
  const delivery = props.delivery;
  const summary = planningRequestSummary(delivery);
  const request = delivery.planningRequest;
  const pending = delivery.state === "pending";
  const failed = delivery.state === "failed";
  const terminal = request !== null && request.lifecycle !== "open";
  const buttonLabel = failed
    ? say("chat.transcript.retry")
    : terminal
      ? say("chat.transcript.openPlan")
      : request?.proposalId !== null && request?.proposalId !== undefined
        ? say("chat.transcript.reviewPlan")
        : say("chat.transcript.continue");
  return (
    <article
      className="grid gap-row rounded-card border border-line-2 bg-surface p-5 shadow-elev-1 outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-planning-request-id={delivery.requestId}
      tabIndex={-1}
      aria-label={say("chat.transcript.request")}
    >
      <div className="flex items-start justify-between gap-row">
        <div className="min-w-0">
          <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
            {terminal ? say("chat.transcript.result") : say("chat.transcript.request")}
          </p>
          <h3 className="mt-inset mb-0 text-base font-semibold">
            {delivery.source?.intent ?? request?.intent ?? say("chat.transcript.request")}
          </h3>
        </div>
        <span
          className={cn(
            "inline-flex min-h-7 shrink-0 items-center rounded-full px-3 text-xs font-medium",
            request?.lifecycle === "applied"
              ? "bg-ok/14 text-ok"
              : request?.attention === "none" && !pending
                ? "bg-sunk text-ink-2"
                : "bg-warn/14 text-warn",
          )}
        >
          {pending ? (
            <LoaderCircle
              className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {say(planningRequestStatus(delivery))}
        </span>
      </div>
      <p className="m-0 text-sm leading-5 text-ink-2">
        {typeof summary === "string" ? summary : say(summary)}
      </p>
      {pending ? null : (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={actions === null || busyId !== null || (failed && !delivery.retryable)}
            onClick={() =>
              failed
                ? actions?.retryPlanningRequest(delivery.requestId)
                : actions?.openPlanningRequest(delivery.requestId)
            }
          >
            {buttonLabel}
          </Button>
        </div>
      )}
    </article>
  );
}

export function ConversationTranscript(props: {
  readonly messages: readonly ChatMessageView[];
  readonly timeline?: readonly ChatTranscriptItemView[];
  readonly historyControls?: boolean;
  readonly bufferedStreaming?: boolean;
}): ReactElement {
  const { say } = usePhrasebook();
  const timeline = props.timeline ?? [];
  const messages = props.messages;
  const items =
    timeline.length > 0
      ? timeline
      : messages.map((message) => ({ kind: "message" as const, message }));

  return (
    <section
      className="chat-transcript grid gap-[18px]"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label={say("chat.transcript.label")}
    >
      {props.historyControls === false ? null : <HistoryControls />}
      <div className="chat-messages grid gap-7">
        {items.length === 0 ? null : (
          <div className="contents">
            {items.map((item) =>
              item.kind === "message" ? (
                <MessageRow
                  key={`message:${item.message.id}`}
                  message={item.message}
                  bufferedStreaming={props.bufferedStreaming ?? false}
                />
              ) : item.kind === "choice" ? (
                <ChoiceRow key={`choice:${item.choice.id}`} choice={item.choice} />
              ) : item.kind === "planning-request" ? (
                <PlanningRequestRow
                  key={`planning-request:${item.delivery.requestId}`}
                  delivery={item.delivery}
                />
              ) : item.kind === "plan-creation" ? (
                <PlanCreationConversation
                  key={`plan-creation:${item.model?.creationId ?? "active"}`}
                  model={item.model}
                />
              ) : (
                <PlanCreationDiscardConsequence
                  key={`plan-creation-discard:${item.eventId}`}
                  eventId={item.eventId}
                />
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function Transcript(): ReactElement {
  const timeline = useEnduragentStore((state) => state.chat.timeline);
  const messages = useEnduragentStore((state) => state.chat.messages);
  return <ConversationTranscript messages={messages} timeline={timeline} bufferedStreaming />;
}
