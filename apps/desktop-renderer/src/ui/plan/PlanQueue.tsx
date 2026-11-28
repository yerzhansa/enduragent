import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { chatFeedbackMessage } from "../chat/copy";

const QUEUE_LINE = "m-0 px-ctl-px py-inset text-xs";

export function PlanQueue(): ReactElement | null {
  const { say, format } = usePhrasebook();
  const queue = useEnduragentStore((state) => state.plan.coach.queued);
  const retry = useEnduragentStore((state) => state.plan.coach.retryRequired);
  const streaming = useEnduragentStore((state) => state.plan.coach.status === "streaming");
  const error = useEnduragentStore((state) => state.plan.coach.queueMutationError ?? null);
  const actions = useEnduragentStore((state) => state.planActions);
  if (queue.length === 0 && retry === null) return null;
  const errorMessage = error === null ? null : chatFeedbackMessage(error);
  return (
    <section
      className="divide-y divide-line overflow-hidden rounded-card bg-sunk"
      aria-label={say("plan.view.planQueue.queuedCoachMessages")}
    >
      {queue.length === 0 ? null : (
        <div className="flex min-h-ctl items-center justify-between px-ctl-px">
          <h3 className="m-0 text-xs font-semibold">{say("plan.view.planQueue.queuedMessages")}</h3>
          <span className="rounded-chip bg-surface px-inset text-xs text-ink-2">
            {format.number(queue.length, { useGrouping: false })}
          </span>
        </div>
      )}
      {retry === null ? null : (
        <div className="flex items-center gap-inset px-ctl-px py-inset">
          <Button
            type="button"
            className="text-ink-2 hover:text-ink"
            variant="ghost"
            size="xs"
            disabled={actions === null || streaming}
            onClick={() => actions?.discardQueuedCoachTurn(retry.claimId)}
          >
            {say("chat.notice.discardMessage")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actions === null}
            onClick={() => actions?.retryQueuedCoachTurn(retry.claimId)}
          >
            {say("plan.view.planQueue.retryInterruptedMessage")}
          </Button>
        </div>
      )}
      {error !== null ? (
        <p className={`${QUEUE_LINE} text-danger`} role="status">
          {errorMessage === null ? error : say(errorMessage)}
        </p>
      ) : retry !== null && queue.length > 0 ? (
        <p className={`${QUEUE_LINE} text-ink-2`}>{say("chat.queued.waitingForRetry")}</p>
      ) : null}
      {queue.length === 0 ? null : (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {queue.map((message, index) => (
            <li
              key={message.id}
              className="flex min-h-ctl items-center gap-inset px-ctl-px py-inset"
            >
              <span className="min-w-0 flex-1 break-words text-sm text-ink-2">{message.text}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={say("plan.view.planQueue.removeMessageLabel", {
                  value1: format.number(index + 1, { useGrouping: false }),
                })}
                disabled={actions === null}
                onClick={() => actions?.removeQueuedCoachMessage(message.id)}
              >
                {say("plan.view.planQueue.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
