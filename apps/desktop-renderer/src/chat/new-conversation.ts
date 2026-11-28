import type { ChatQueueSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClient } from "../coach-client";
import { DESKTOP_CHAT_ID, type ChatState, type ChatTranscriptMessage } from "../turn-state";
import {
  TRANSCRIPT_HYDRATION_PAGE_LIMIT,
  transcriptTurnIds,
  type TranscriptHydrationSnapshot,
  type TranscriptPage,
} from "./hydration";

export interface NewConversationEvidence {
  readonly turnIds: ReadonlySet<string>;
  readonly historyLoaded: boolean;
  readonly queuedIds: ReadonlySet<string>;
  readonly draftWrites: number;
}

export type NewConversationReading =
  | {
      readonly outcome: "landed";
      readonly page: Extract<TranscriptPage, { readonly status: "page" }>;
      readonly queue: ChatQueueSnapshot;
    }
  | { readonly outcome: "not-started" }
  | { readonly outcome: "unknown" };

const messageTurnIds = (messages: readonly ChatTranscriptMessage[]): readonly string[] =>
  messages.flatMap((message) => (message.turnId === undefined ? [] : [message.turnId]));

export function newConversationEvidence(
  hydration: TranscriptHydrationSnapshot,
  state: Pick<ChatState, "messages" | "queued">,
  draftWrites: number,
): NewConversationEvidence {
  return {
    turnIds: new Set([...transcriptTurnIds(hydration), ...messageTurnIds(state.messages)]),
    historyLoaded: hydration.status === "ready",
    queuedIds: new Set(state.queued.map((message) => message.id)),
    draftWrites,
  };
}

export function newConversationOutcome(
  before: NewConversationEvidence,
  page: Extract<TranscriptPage, { readonly status: "page" }>,
  queue: ChatQueueSnapshot,
  sentTurnIds: ReadonlySet<string>,
): NewConversationReading["outcome"] {
  const pageTurnIds = transcriptTurnIds(page);
  if (
    pageTurnIds.some((turnId) => before.turnIds.has(turnId)) ||
    (!before.historyLoaded && pageTurnIds.some((turnId) => !sentTurnIds.has(turnId))) ||
    queue.items.some((item) => before.queuedIds.has(item.queuedMessageId))
  ) {
    return "not-started";
  }
  return page.nextCursor === null ? "landed" : "unknown";
}

export async function readNewConversationOutcome(
  client: DesktopCoachClient,
  readTranscriptPage: (request: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>,
  before: NewConversationEvidence,
  liveMessages: () => readonly ChatTranscriptMessage[],
): Promise<NewConversationReading> {
  await client.call("hasSession", { chatId: DESKTOP_CHAT_ID });
  const page = await readTranscriptPage({ cursor: null, limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT });
  const queue = await client.call("getChatQueue", { chatId: DESKTOP_CHAT_ID });
  if (page.status !== "page") return { outcome: "unknown" };
  const sentTurnIds = new Set(
    messageTurnIds(liveMessages()).filter((turnId) => !before.turnIds.has(turnId)),
  );
  const outcome = newConversationOutcome(before, page, queue, sentTurnIds);
  return outcome === "landed" ? { outcome, page, queue } : { outcome };
}
