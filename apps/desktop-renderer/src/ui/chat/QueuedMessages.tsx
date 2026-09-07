import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { cn } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { setupReady } from "../../state/onboarding-slice";

export function QueuedMessages(): ReactElement | null {
  const queued = useEnduragentStore((state) => state.chat.queued);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const retryRequired = useEnduragentStore((state) => state.chat.retryRequired);
  const queueMutationError = useEnduragentStore((state) => state.chat.queueMutationError) ?? null;
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);

  if (queued.length === 0) return null;
  const queueLabel = `${queued.length} queued ${queued.length === 1 ? "message" : "messages"}`;

  return (
    <section
      className="chat-queue mb-[var(--inset)] min-w-0 overflow-hidden rounded-card border border-line bg-surface shadow-elev-2"
      aria-label={`Queued messages, ${queueLabel}`}
    >
      <div className="flex min-h-ctl items-center justify-between gap-inset px-ctl-px">
        <h2 className="m-0 text-xs font-semibold text-ink">Queued messages</h2>
        <span className="rounded-chip bg-sunk px-inset text-xs text-ink-2" aria-hidden="true">
          {queued.length}
        </span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {queueLabel}
        </span>
      </div>
      {retryRequired !== null ? (
        <div className="border-t border-line px-[var(--ctl-px)] py-[var(--inset)]">
          <Button
            variant="secondary"
            size="xs"
            disabled={!canChat || workBlocked || actions === null}
            onClick={() => actions?.retryQueuedTurn(retryRequired.claimId)}
          >
            Retry interrupted message
          </Button>
        </div>
      ) : null}
      {queueMutationError !== null ? (
        <p
          className="m-0 border-t border-line px-ctl-px py-inset text-xs text-danger"
          role="status"
        >
          {queueMutationError}
        </p>
      ) : null}
      <ul className="m-0 flex list-none flex-col border-t border-line p-0" role="list">
        {queued.map((message, index) => (
          <li
            key={message.id}
            className="chat-queue__item flex min-h-ctl min-w-0 flex-wrap items-center gap-inset border-b border-line px-ctl-px py-inset last:border-b-0"
          >
            <span
              className={cn(
                "chat-queue__text min-w-0 flex-[1_1_12rem] whitespace-pre-wrap break-words text-sm text-ink-2",
                message.command && "chat-queue__command font-medium",
              )}
            >
              {message.text}
            </span>
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-inset">
              {message.command && message.restored ? (
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={!canChat || workBlocked || actions === null || retryRequired !== null}
                  onClick={() => actions?.runQueuedCommand(message.id)}
                >
                  Run command
                </Button>
              ) : null}
              <Button
                className="chat-queue__remove text-ink-2 hover:text-ink"
                variant="ghost"
                size="xs"
                aria-label={`Remove queued message ${index + 1}`}
                disabled={
                  !canChat ||
                  workBlocked ||
                  actions === null ||
                  retryRequired?.queuedMessageIds.includes(message.id) === true
                }
                onClick={() => actions?.removeQueued(message.id)}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
