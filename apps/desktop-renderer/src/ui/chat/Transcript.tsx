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
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { useEnduragentStore } from "../../state/store";
import { AthleteMessage } from "./AthleteMessage";
import { CoachMessage } from "./CoachMessage";
import { HistoryControls } from "./HistoryControls";
import { PlanReferenceCard } from "./PlanReferenceCard";
import { StreamingMessage } from "./StreamingMessage";
import { PlanCreationConversation } from "./PlanCreationCards";

function planHandoffSummary(suggestion: PlanHandoffSuggestion): string {
  if (suggestion.kind === "plan_creation") {
    return "Answer the remaining details in Plan, then review the Draft before applying it.";
  }
  if (suggestion.kind === "plan_change") {
    return "Review a structured Proposal in Plan. Nothing changes until you approve it.";
  }
  return "Open Plan with this question and the relevant Chat context attached.";
}

function PlanHandoffCard(props: {
  readonly messageId: string;
  readonly suggestion: PlanHandoffSuggestion;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const loaded = useEnduragentStore((state) => state.chat.planningRequestsLoaded);
  const busyId = useEnduragentStore((state) => state.chat.planningRequestBusyId);
  return (
    <aside className="mt-row grid gap-row rounded-card border border-line-2 bg-surface p-5 shadow-elev-1">
      <div className="grid gap-inset">
        <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
          Continue in Plan
        </p>
        <h3 className="m-0 text-base font-semibold leading-6">{props.suggestion.title}</h3>
        <p className="m-0 text-sm leading-5 text-ink-2">{planHandoffSummary(props.suggestion)}</p>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={actions === null || !loaded || busyId !== null}
          onClick={() => actions?.continueMessageInPlan(props.messageId, props.suggestion)}
        >
          Continue in Plan
        </Button>
      </div>
    </aside>
  );
}

function MessageRow(props: {
  readonly message: ChatMessageView;
  readonly bufferedStreaming: boolean;
}): ReactElement {
  const message = props.message;
  const sourceMessageId = message.turnId ?? message.id;
  const handoffDelivery = useEnduragentStore((state) =>
    state.chat.planningRequests.find(
      (delivery) =>
        delivery.source?.messageId === sourceMessageId && delivery.state !== "cancelled",
    ),
  );
  const streaming = message.role === "coach" && message.delivery === "streaming";
  const silent = message.historical || message.role === "athlete";
  const rowClassName = cn(
    "chat-message grid min-w-0 data-[delivery=interrupted]:text-ink-2",
    message.role === "coach"
      ? "chat-message--coach max-w-full justify-self-start text-sm leading-5"
      : "chat-message--athlete max-w-[76%] justify-self-end rounded-card rounded-br-ctl border border-line bg-surface px-4 py-3",
  );

  return (
    <article
      className={rowClassName}
      data-message-id={message.id}
      data-delivery={message.delivery}
      aria-live={silent ? "off" : undefined}
      aria-atomic={message.role === "coach" ? "true" : "false"}
      aria-busy={streaming ? "true" : undefined}
    >
      <span className="sr-only">
        {message.role === "athlete" ? "Your message" : "Coach response"}
      </span>
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
      ) : streaming && props.bufferedStreaming ? (
        <StreamingMessage messageId={message.id} />
      ) : (
        <div className="min-w-0">
          <CoachMessage text={message.text} />
          {message.planReference === undefined ? null : (
            <PlanReferenceCard selection={message.planReference} />
          )}
          {message.planHandoff === undefined || handoffDelivery !== undefined ? null : (
            <PlanHandoffCard messageId={sourceMessageId} suggestion={message.planHandoff} />
          )}
        </div>
      )}
    </article>
  );
}

function ChoiceRow(props: { readonly choice: ChatChoiceView }): ReactElement {
  const choice = props.choice;
  return (
    <article
      className="grid grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-2.5 rounded-card bg-sunk p-3"
      aria-label="Choice consequence"
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
        <p className="m-0 text-xs font-semibold leading-4 text-ink-2">Choice consequence</p>
        <strong className="text-sm font-medium leading-5">{choice.label}</strong>
        {choice.consequence === null ? null : (
          <p className="m-0 text-xs leading-4 text-ink-2">{choice.consequence}</p>
        )}
      </div>
    </article>
  );
}

function planningRequestStatus(delivery: PlanningRequestDelivery): string {
  if (delivery.state === "pending") return "Opening";
  if (delivery.state === "failed") return "Couldn’t open";
  const request = delivery.planningRequest;
  if (request === null) return "Plan request";
  if (request.lifecycle === "applied") return "Added to Plan";
  if (request.lifecycle === "rejected" || request.lifecycle === "ended") return "Not added";
  if (request.attention === "date_conflict") return "Date conflict";
  if (request.attention === "revalidating") return "Checking";
  if (request.attention === "stale_base") return "Updated review";
  if (request.attention === "apply_failed") return "Save failed";
  if (request.proposalId !== null) return "Needs review";
  return "Continue in Plan";
}

function planningRequestSummary(delivery: PlanningRequestDelivery): string {
  const request = delivery.planningRequest;
  if (delivery.state === "pending")
    return "The workout and your Chat context are staying together.";
  if (delivery.state === "failed") {
    return delivery.retryable
      ? "The request is saved. Trying again will not create a duplicate."
      : "The request could not be delivered safely.";
  }
  if (request?.terminalResult !== null && request?.terminalResult !== undefined) {
    return request.terminalResult.detail;
  }
  if (request?.attention === "apply_failed") {
    return "The Proposal is preserved and the active Plan is unchanged.";
  }
  if (request?.target === "draft") {
    return "The workout is available to the unapplied Draft.";
  }
  if (request?.target === "plan_creation") {
    return "Plan is waiting for the details needed to build a Draft.";
  }
  return "Review the structured Proposal in Plan; the active Plan is unchanged.";
}

function PlanningRequestRow(props: { readonly delivery: PlanningRequestDelivery }): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const busyId = useEnduragentStore((state) => state.chat.planningRequestBusyId);
  const delivery = props.delivery;
  const request = delivery.planningRequest;
  const pending = delivery.state === "pending";
  const failed = delivery.state === "failed";
  const terminal = request !== null && request.lifecycle !== "open";
  const buttonLabel = failed
    ? "Try again"
    : terminal
      ? "Open Plan"
      : request?.proposalId !== null && request?.proposalId !== undefined
        ? "Review in Plan"
        : "Continue in Plan";
  return (
    <article
      className="grid gap-row rounded-card border border-line-2 bg-surface p-5 shadow-elev-1 outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-planning-request-id={delivery.requestId}
      tabIndex={-1}
      aria-label="Plan request"
    >
      <div className="flex items-start justify-between gap-row">
        <div className="min-w-0">
          <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
            {terminal ? "Plan result" : "Plan request"}
          </p>
          <h3 className="mt-inset mb-0 text-base font-semibold">
            {delivery.source?.intent ?? request?.intent ?? "Plan request"}
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
          {planningRequestStatus(delivery)}
        </span>
      </div>
      <p className="m-0 text-sm leading-5 text-ink-2">{planningRequestSummary(delivery)}</p>
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
      aria-label="Coach conversation"
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
              ) : (
                <PlanCreationConversation
                  key={`plan-creation:${item.model?.creationId ?? "empty"}`}
                  model={item.model}
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
