import type { ChatQueueSnapshot } from "@enduragent/coach-contract";
import {
  CHAT_QUEUE_REMOVE_FAILURE_COPY,
  reportBestEffortAsync,
} from "../../chat/controller-helpers";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../../coach-client";
import {
  QUEUED_MESSAGE_SEPARATOR,
  nextDrainGroup,
  type ChatAction,
  type ChatState,
} from "../../turn-state";

type PlanChatCall<T> = (client: DesktopCoachClient, chatId: string) => Promise<T>;

export interface PlanCoachQueue {
  error(): string | null;
  enqueue(text: string): Promise<boolean>;
  stop(): void;
  remove(queuedMessageId: string): void;
  retry(claimId: string): void;
  discard(claimId: string): void;
}

export function createPlanCoachQueue(input: {
  readonly clients: DesktopCoachClientProvider | undefined;
  readonly chatId: () => string | null;
  readonly state: () => ChatState;
  readonly reduce: (action: ChatAction) => void;
  readonly render: () => void;
  readonly send: (text: string) => boolean;
  readonly sending: () => boolean;
  readonly createSubmissionId: () => string;
  readonly disposed: () => boolean;
}): PlanCoachQueue {
  let error: string | null = null;
  let mutations = 0;

  const call = async <T>(request: PlanChatCall<T>): Promise<T> => {
    const chatId = input.chatId();
    if (chatId === null || input.clients === undefined) {
      throw new TypeError("The Plan coach chat is unavailable.");
    }
    return request(await input.clients.getClient(), chatId);
  };

  const mutate = (request: PlanChatCall<ChatQueueSnapshot>, after?: () => void): void => {
    if (input.chatId() === null || input.clients === undefined) return;
    error = null;
    mutations += 1;
    input.render();
    void call(request)
      .then((snapshot) => {
        if (input.disposed()) return;
        input.reduce({ type: "queue-snapshot", snapshot });
        after?.();
      })
      .catch(() => {
        error = CHAT_QUEUE_REMOVE_FAILURE_COPY;
      })
      .finally(() => {
        mutations -= 1;
        if (!input.disposed()) input.render();
      });
  };

  return {
    error: () => error,
    async enqueue(text) {
      if (input.chatId() === null || input.clients === undefined || !/\S/u.test(text)) return false;
      const submissionId = input.createSubmissionId();
      try {
        const snapshot = await call((client, chatId) =>
          client.call("enqueueChatMessage", { chatId, submissionId, text: text.trim() }),
        );
        input.reduce({ type: "queue-snapshot", snapshot });
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      const turnId = input.state().activeTurn?.turnId;
      if (turnId === null || turnId === undefined) return;
      void reportBestEffortAsync("plan-chat-stop-chat-failed", () =>
        call((client, chatId) => client.call("stopChat", { chatId, turnId })),
      );
    },
    remove(queuedMessageId) {
      mutate((client, chatId) =>
        client.call("removeQueuedChatMessage", { chatId, queuedMessageId }),
      );
    },
    retry(claimId) {
      const state = input.state();
      const claim = state.retryRequired;
      if (claim?.claimId !== claimId || mutations > 0) return;
      error = null;
      input.send(
        state.queued
          .filter((item) => claim.queuedMessageIds.includes(item.id))
          .map((item) => item.text)
          .join(QUEUED_MESSAGE_SEPARATOR),
      );
    },
    discard(claimId) {
      if (input.state().retryRequired?.claimId !== claimId || mutations > 0 || input.sending()) {
        return;
      }
      mutate(
        (client, chatId) => client.call("discardQueuedTurn", { chatId, claimId }),
        () => {
          const group = nextDrainGroup(input.state());
          if (group === null || input.state().retryRequired != null || input.sending()) return;
          input.reduce({ type: "dequeue-group" });
          input.send(group.text);
        },
      );
    },
  };
}
