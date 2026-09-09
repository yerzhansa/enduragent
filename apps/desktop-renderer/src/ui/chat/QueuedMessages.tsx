import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { QueuedMessageList, QueuedMessageRow } from "@enduragent/ui";
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
    <QueuedMessageList
      className="mb-row"
      title="Queued messages"
      count={queued.length}
      announcement={queueLabel}
      aria-label={`Queued messages, ${queueLabel}`}
      notice={
        <>
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
        </>
      }
    >
      {queued.map((message, index) => (
        <QueuedMessageRow
          key={message.id}
          command={message.command}
          actions={
            <>
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
            </>
          }
        >
          {message.text}
        </QueuedMessageRow>
      ))}
    </QueuedMessageList>
  );
}
